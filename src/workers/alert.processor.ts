import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { EventBusService } from '../core/events/event-bus.service';
import { FirebaseService } from '../core/firebase/firebase.service';
import { QUEUES } from '../core/queue/queue.constants';
import { PrismaService } from '../core/prisma/prisma.service';
import { MobileRepository } from '../modules/mobile/mobile.repository';
import { AlertDeliveryRepository, AlertRulesRepository } from '../modules/notifications/notifications.repository';
import { evaluateAlertPolicy, startOfLocalDay } from '../modules/notifications/lib/alert-policy';
import { WebhooksService } from '../modules/webhooks/webhooks.service';

interface AlertRecipient {
  kind: 'user' | 'driver';
  id: string;
}

/**
 * TZ §14 — consumes every `alert.*` job the API enqueues (`IngestService.raiseAlert`,
 * `TripsService.assign`, etc.), matches it against `AlertRule.conditions[].event`, then
 * enforces throttle/cooldown/quiet hours (deterministically, via
 * `modules/notifications/lib/alert-policy.ts`) before delivering IN_APP (+ FCM push),
 * EMAIL or WEBHOOK. `SMS` never reaches here — the API rejects it at rule-creation time
 * (422 CHANNEL_NOT_AVAILABLE), so no `AlertRule.channels` in the DB ever contains it.
 */
@Processor(QUEUES.ALERT)
export class AlertProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertProcessor.name);

  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly deliveries: AlertDeliveryRepository,
    private readonly prisma: PrismaService,
    private readonly mobile: MobileRepository,
    private readonly firebase: FirebaseService,
    private readonly webhooks: WebhooksService,
    private readonly events: EventBusService,
  ) {
    super();
  }

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    const eventName = job.name;
    const payload = job.data ?? {};
    const matchingRules = await this.rules.findByEvent(eventName);
    if (!matchingRules.length) return;

    for (const rule of matchingRules) {
      const recipients = await this.resolveRecipients(rule, payload);
      for (const recipient of recipients) {
        await this.deliverToRecipient(rule, recipient, payload);
      }
    }
  }

  private async resolveRecipients(
    rule: { recipients: unknown },
    payload: Record<string, unknown>,
  ): Promise<AlertRecipient[]> {
    const spec = rule.recipients as {
      roles?: string[];
      userIds?: string[];
      driverIds?: string[];
      subjectDriver?: boolean;
    };
    const out: AlertRecipient[] = [];
    for (const id of spec.userIds ?? []) out.push({ kind: 'user', id });
    for (const id of spec.driverIds ?? []) out.push({ kind: 'driver', id });
    if (spec.subjectDriver && typeof payload.driverId === 'string') {
      out.push({ kind: 'driver', id: payload.driverId });
    }
    if (spec.roles?.length) {
      const users = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', role: { key: { in: spec.roles } } },
        select: { id: true },
      });
      for (const u of users) out.push({ kind: 'user', id: u.id });
    }
    // De-duplicate.
    const seen = new Set<string>();
    return out.filter((r) => {
      const key = `${r.kind}:${r.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async resolveZone(recipient: AlertRecipient): Promise<string> {
    if (recipient.kind === 'driver') {
      const driver = await this.prisma.driver.findUnique({
        where: { id: recipient.id },
        select: { homeTerminalTimezone: true },
      });
      if (driver?.homeTerminalTimezone) return driver.homeTerminalTimezone;
    }
    const carrier = await this.prisma.carrier.findFirst({ select: { timezone: true } });
    return carrier?.timezone ?? 'America/New_York';
  }

  private async deliverToRecipient(
    rule: {
      id: string;
      severity: string;
      channels: string[];
      throttle: unknown;
      quietHours: unknown;
    },
    recipient: AlertRecipient,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const recipientKey = `${recipient.kind}:${recipient.id}`;
    const zone = await this.resolveZone(recipient);
    const now = new Date();
    const throttle = (rule.throttle ?? undefined) as { perDriverPerDay?: number; cooldownMin?: number } | undefined;
    const quietHours = (rule.quietHours ?? undefined) as { from: string; to: string; timezone: string } | undefined;

    const deliveriesTodayCount = throttle?.perDriverPerDay
      ? await this.deliveries.countToday(rule.id, recipientKey, startOfLocalDay(now, zone))
      : 0;
    const lastDelivery = throttle?.cooldownMin ? await this.deliveries.lastDelivered(rule.id, recipientKey) : null;

    const decision = evaluateAlertPolicy({
      now,
      zone,
      throttle,
      quietHours,
      deliveriesTodayCount,
      lastDeliveredAt: lastDelivery?.sentAt ?? null,
      bypassQuietHours: rule.severity === 'CRITICAL',
    });

    for (const channel of rule.channels) {
      if (channel === 'SMS') continue; // defence in depth — never persisted, never sent.
      const delivery = await this.deliveries.create({
        alertRule: { connect: { id: rule.id } },
        channel,
        recipient: recipientKey,
        subjectType: recipient.kind,
        subjectId: recipient.id,
        payload: payload as Prisma.InputJsonValue,
        status: 'QUEUED',
      });

      if (!decision.allowed) {
        await this.deliveries.markSuppressed(delivery.id, decision.reason ?? 'SUPPRESSED');
        continue;
      }

      try {
        await this.send(channel, recipient, payload, rule);
        await this.deliveries.markSent(delivery.id);
      } catch (err) {
        this.logger.error({ err, ruleId: rule.id, channel, recipient: recipientKey }, 'Alert delivery failed');
        await this.deliveries.markFailed(delivery.id, err instanceof Error ? err.message : 'Unknown error');
      }
    }
  }

  private async send(
    channel: string,
    recipient: AlertRecipient,
    payload: Record<string, unknown>,
    rule: { id: string },
  ): Promise<void> {
    if (channel === 'IN_APP') {
      const notification = await this.prisma.notification.create({
        data: {
          ...(recipient.kind === 'user' ? { userId: recipient.id } : { driverId: recipient.id }),
          type: rule.id,
          title: String(payload.title ?? 'Alert'),
          body: JSON.stringify(payload).slice(0, 500),
        },
      });
      await this.events.publish('realtime.push', {
        room: recipient.kind === 'driver' ? `driver:${recipient.id}` : `user:${recipient.id}`,
        event: 'notification.new',
        payload: { notification },
      });
      // TZ §12.7 — background app gets FCM, not just the socket event.
      if (recipient.kind === 'driver' && this.firebase.enabled) {
        const tokens = await this.mobile.findPushTokens(recipient.id);
        await Promise.allSettled(
          tokens.map((t) =>
            this.firebase.sendToToken(
              t.token,
              { title: notification.title, body: notification.body },
              { type: notification.type, id: notification.id, driverId: recipient.id },
            ),
          ),
        );
      }
      return;
    }
    if (channel === 'EMAIL') {
      // No SMTP client exists yet (same gap as TransfersModule's MAIL_PORT) — logged for now.
      this.logger.log({ recipient, payload }, 'EMAIL alert (no SMTP transport configured yet)');
      return;
    }
    if (channel === 'WEBHOOK') {
      await this.webhooks.notify('alert', { recipient, ...payload });
      return;
    }
  }
}
