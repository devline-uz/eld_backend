import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';
import { EventBusService } from '../core/events/event-bus.service';
import { PushService } from '../core/firebase/push.service';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../core/mail/mail.port';
import { QUEUES } from '../core/queue/queue.constants';
import { PrismaService } from '../core/prisma/prisma.service';
import { AlertDeliveryRepository, AlertRulesRepository } from '../modules/notifications/notifications.repository';
import { breakDueEpisode } from '../modules/notifications/lib/alert-events';
import { evaluateAlertPolicy, startOfLocalDay } from '../modules/notifications/lib/alert-policy';
import {
  deriveNotificationBody,
  deriveNotificationCategory,
  deriveNotificationKind,
  deriveObjectRef,
} from '../modules/notifications/lib/notification-kind';
import { WebhooksService } from '../modules/webhooks/webhooks.service';

/** TZ §20 B-87 shape stored at `Carrier.notificationChannels`. Missing entry = enabled. */
interface OrgNotificationChannels {
  email?: { enabled?: boolean };
  webhook?: { enabled?: boolean; url?: string };
}

interface AlertRecipient {
  kind: 'user' | 'driver';
  id: string;
}

/**
 * TZ §14 — consumes every `alert.*` job the API enqueues (`IngestService.raiseAlert`,
 * `TripsService.assign`, etc.), matches it against `AlertRule.conditions[].event`, then
 * enforces throttle/cooldown/quiet hours (deterministically, via
 * `modules/notifications/lib/alert-policy.ts`) before delivering IN_APP (+ FCM push),
 * EMAIL (real SMTP, `TRANSACTIONAL_MAIL`) or WEBHOOK. `SMS` never reaches here — the API
 * rejects it at rule-creation time
 * (422 CHANNEL_NOT_AVAILABLE), so no `AlertRule.channels` in the DB ever contains it.
 */
@Processor(QUEUES.ALERT)
export class AlertProcessor extends WorkerHost {
  private readonly logger = new Logger(AlertProcessor.name);

  constructor(
    private readonly rules: AlertRulesRepository,
    private readonly deliveries: AlertDeliveryRepository,
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly webhooks: WebhooksService,
    private readonly events: EventBusService,
    /** Real SMTP (`@Global()` `MailModule`, imported by `worker.ts`). Never throws — see `sendEmail`. */
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
  ) {
    super();
  }

  async process(job: Job<Record<string, unknown>>): Promise<void> {
    const eventName = job.name;
    const payload = job.data ?? {};
    const matchingRules = await this.rules.findByEvent(eventName, payload);
    if (!matchingRules.length) return;

    for (const rule of matchingRules) {
      const recipients = await this.resolveRecipients(rule, payload);
      for (const recipient of recipients) {
        await this.deliverToRecipient(rule, recipient, payload, eventName);
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

  /** TZ §20 B-87 — reads the singleton `Carrier.notificationChannels`; absent key = enabled. */
  private async isOrgChannelEnabled(channel: 'EMAIL' | 'WEBHOOK'): Promise<boolean> {
    const carrier = await this.prisma.carrier.findFirst({ select: { notificationChannels: true } });
    const channels = (carrier?.notificationChannels ?? {}) as OrgNotificationChannels;
    const entry = channel === 'EMAIL' ? channels.email : channels.webhook;
    return entry?.enabled !== false;
  }

  private async orgWebhookUrl(): Promise<string | undefined> {
    const carrier = await this.prisma.carrier.findFirst({ select: { notificationChannels: true } });
    const url = ((carrier?.notificationChannels ?? {}) as OrgNotificationChannels).webhook?.url;
    return typeof url === 'string' && url.trim().length > 0 ? url.trim() : undefined;
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
    eventName: string,
  ): Promise<void> {
    const recipientKey = `${recipient.kind}:${recipient.id}`;
    // BE-12 — a break-due rule matches every 5-minute step at or under its threshold; deliver it
    // once per (rule, recipient, driver, break deadline) — the first step that matched wins.
    const episode = breakDueEpisode(eventName, payload);
    if (episode && (await this.deliveries.existsForBreakEpisode(rule.id, recipientKey, episode))) return;
    const zone = await this.resolveZone(recipient);
    const now = new Date();
    const throttle = rule.throttle as { perDriverPerDay?: number; cooldownMin?: number } | null | undefined;
    const quietHours = rule.quietHours as { from: string; to: string; timezone: string } | null | undefined;

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

      // TZ §20 B-87 — an org-level channel toggle suppresses EMAIL/WEBHOOK delivery even
      // when the rule itself and the throttle/quiet-hours policy both allow it. IN_APP is
      // never gated here — the bell inbox always fills, per the settings page copy.
      if ((channel === 'EMAIL' || channel === 'WEBHOOK') && !(await this.isOrgChannelEnabled(channel))) {
        await this.deliveries.markSuppressed(delivery.id, 'CHANNEL_DISABLED');
        continue;
      }

      try {
        await this.send(channel, recipient, payload, rule, eventName);
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
    rule: { id: string; severity: string },
    eventName: string,
  ): Promise<void> {
    if (channel === 'IN_APP') {
      const kind = deriveNotificationKind(eventName);
      const ref = deriveObjectRef(eventName, payload);
      const category = deriveNotificationCategory(kind);
      const notification = await this.prisma.notification.create({
        data: {
          ...(recipient.kind === 'user' ? { userId: recipient.id } : { driverId: recipient.id }),
          type: rule.id,
          kind,
          title: typeof payload.title === 'string' ? payload.title : 'Alert',
          // TZ §20 B-58 — human-readable, not `JSON.stringify(payload)`; clickable via
          // objectType/objectId below, CRITICAL severity drives the toast.
          body: deriveNotificationBody(eventName, payload).slice(0, 500),
          severity: rule.severity as Prisma.NotificationCreateInput['severity'],
          ...(category && { category }),
          ...(ref && { objectType: ref.objectType, objectId: ref.objectId }),
        },
      });
      await this.events.publish('realtime.push', {
        room: recipient.kind === 'driver' ? `driver:${recipient.id}` : `user:${recipient.id}`,
        event: 'notification.new',
        payload: { notification },
      });
      // TZ §12.7 — background app gets FCM, not just the socket event.
      if (recipient.kind === 'driver') {
        await this.push.sendToDriver(
          recipient.id,
          { title: notification.title, body: notification.body },
          {
            type: notification.type,
            id: notification.id,
            driverId: recipient.id,
            kind,
            objectType: notification.objectType,
            objectId: notification.objectId,
            category: notification.category,
          },
        );
      }
      return;
    }
    if (channel === 'EMAIL') {
      await this.sendEmail(recipient, payload, rule, eventName);
      return;
    }
    if (channel === 'WEBHOOK') {
      // CODE-084 — the org-level webhook URL from Settings › Notifications used to be stored but
      // never read; when set it is the alert endpoint, otherwise the `webhook` integration's URL.
      const url = await this.orgWebhookUrl();
      await this.webhooks.notify('alert', { recipient, ...payload }, url ? { url } : {});
      return;
    }
  }

  /**
   * EMAIL channel — real SMTP via `TRANSACTIONAL_MAIL`. Anything that keeps the mail from
   * landing (no live address, no `SMTP_HOST` in dev/CI → `NO_MAIL_TRANSPORT`, SMTP rejection →
   * `SMTP_SEND_FAILED`) is thrown here so `deliverToRecipient` logs it and marks the
   * `AlertDelivery` FAILED with that reason. It is never rethrown out of `process`, so a bad
   * address or a down SMTP server cannot turn into a BullMQ retry storm (or re-send IN_APP).
   */
  private async sendEmail(
    recipient: AlertRecipient,
    payload: Record<string, unknown>,
    rule: { id: string; severity: string },
    eventName: string,
  ): Promise<void> {
    const to = await this.resolveEmail(recipient);
    if (!to) throw new Error('NO_EMAIL_ADDRESS');
    const title = typeof payload.title === 'string' ? payload.title : 'Alert';
    const body = deriveNotificationBody(eventName, payload).slice(0, 500);
    const result = await this.mail.send({
      to,
      subject: `OneBook ELD ${rule.severity.toLowerCase()} alert: ${title}`.slice(0, 200),
      text: [body, '', `Severity: ${rule.severity}`, `Event: ${eventName}`].join('\n'),
    });
    if (!result.delivered) throw new Error(result.reference);
  }

  /** Only live accounts get alert mail: an ACTIVE user, or a non-deleted ACTIVE driver with an email. */
  private async resolveEmail(recipient: AlertRecipient): Promise<string | null> {
    if (recipient.kind === 'user') {
      const user = await this.prisma.user.findUnique({
        where: { id: recipient.id },
        select: { email: true, status: true },
      });
      return user?.status === 'ACTIVE' && user.email ? user.email : null;
    }
    const driver = await this.prisma.driver.findUnique({
      where: { id: recipient.id },
      select: { email: true, status: true, deletedAt: true },
    });
    return driver && driver.status === 'ACTIVE' && !driver.deletedAt && driver.email ? driver.email : null;
  }
}
