import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/notifications.dto';
import { NotificationChannelsService } from './notification-channels.service';
import { AlertRulesRepository, NotificationsRepository } from './notifications.repository';

export interface AlertRuleTestChannelResult {
  channel: 'IN_APP' | 'EMAIL' | 'WEBHOOK';
  /** SENT = delivered now; QUEUED = handed to the webhook queue; FAILED / SUPPRESSED carry `reason`. */
  status: 'SENT' | 'QUEUED' | 'FAILED' | 'SUPPRESSED';
  /** e.g. NO_EMAIL_ADDRESS, NO_MAIL_TRANSPORT, SMTP_SEND_FAILED, NO_WEBHOOK_CONFIGURED, CHANNEL_DISABLED. */
  reason?: string;
}

export interface AlertRuleTestResult {
  /** At least one channel actually sent or queued the test alert. */
  triggered: boolean;
  channels: AlertRuleTestChannelResult[];
}

/**
 * TZ §14 — "SMS — v1 yo'q": the enum value stays (migration-free v2 add) but the API
 * rejects any rule that selects it, with the exact envelope the driver-facing UI expects.
 */
function assertNoSms(channels: readonly string[]): void {
  if (channels.includes('SMS')) {
    throw new AppException(ERROR_CODES.CHANNEL_NOT_AVAILABLE, 'SMS is not available yet.', 422, {
      channel: 'SMS',
      availableIn: 'v2',
    });
  }
}

@Injectable()
export class AlertRulesService {
  private readonly logger = new Logger(AlertRulesService.name);

  constructor(
    private readonly repo: AlertRulesRepository,
    private readonly notifications: NotificationsRepository,
    private readonly events: EventBusService,
    private readonly webhooks: WebhooksService,
    private readonly orgChannels: NotificationChannelsService,
    /** Real SMTP (`@Global()` `MailModule`, imported by `app.module.ts`). Never throws. */
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
  ) {}

  list() {
    return this.repo.listAll().then((items) => ({ items }));
  }

  async get(id: string) {
    const rule = await this.repo.findById({ id });
    if (!rule) throw new AppException(ERROR_CODES.NOT_FOUND, 'Alert rule not found.', 404);
    return rule;
  }

  async create(dto: CreateAlertRuleDto) {
    assertNoSms(dto.channels);
    const existing = await this.repo.findByKey(dto.key);
    if (existing) throw new AppException(ERROR_CODES.CONFLICT, 'An alert rule with this key already exists.', 409);
    return this.repo.create(dto as Prisma.AlertRuleCreateInput);
  }

  async update(id: string, dto: UpdateAlertRuleDto) {
    const rule = await this.get(id);
    // `key` cannot be changed at all — UpdateAlertRuleDto omits it entirely.
    if (rule.isSystem && dto.conditions !== undefined) {
      throw new AppException(ERROR_CODES.ALERT_RULE_INVALID, 'System alert rules cannot change their conditions.', 422);
    }
    if (dto.channels) assertNoSms(dto.channels);
    return this.repo.update({ id }, dto as Prisma.AlertRuleUpdateInput);
  }

  async remove(id: string) {
    const rule = await this.get(id);
    if (rule.isSystem) throw new AppException(ERROR_CODES.ALERT_RULE_INVALID, 'System alert rules cannot be deleted.', 422);
    await this.repo.delete({ id });
    return { id, deleted: true };
  }

  /**
   * TZ §20 B-9 — "Test rule" row menu. Sends a synthetic alert to the calling actor through
   * every channel the rule actually has configured (never through channels the rule doesn't
   * select), the same way `AlertProcessor.send` would for a real event — minus the
   * throttle/cooldown/quiet-hours policy, since a deliberate manual test must always land.
   * The org-level Email/Webhook switches (TZ §20 B-87) still apply, exactly as live.
   * A disabled rule triggers nothing (`{ triggered: false, channels: [] }`): the point of the
   * button is to preview what a *live* rule would do.
   *
   * `triggered` is true only when at least one channel actually sent (or queued) something;
   * `channels` reports each channel's truthful outcome (an EMAIL with no SMTP transport or no
   * address on the actor's account is `FAILED`, never silently "sent").
   */
  async testRule(id: string, actor: ContextUser): Promise<AlertRuleTestResult> {
    const rule = await this.get(id);
    if (!rule.enabled) return { triggered: false, channels: [] };

    const title = `Test: ${rule.name}`;
    const body = `This is a test notification for the "${rule.name}" alert rule.`;
    const channels: AlertRuleTestChannelResult[] = [];

    for (const channel of rule.channels) {
      if (channel === 'SMS') continue; // never persisted, never sent — same as live delivery.
      if (channel === 'IN_APP') {
        const notification = await this.notifications.create({
          ...(actor.type === 'driver' ? { driverId: actor.id } : { userId: actor.id }),
          type: rule.id,
          title,
          body,
          severity: rule.severity,
        });
        await this.events.publish('realtime.push', {
          room: actor.type === 'driver' ? `driver:${actor.id}` : `user:${actor.id}`,
          event: 'notification.new',
          payload: { notification },
        });
        channels.push({ channel, status: 'SENT' });
      } else if (channel === 'EMAIL') {
        channels.push(await this.sendTestEmail(rule, actor, body));
      } else if (channel === 'WEBHOOK') {
        if (!(await this.isOrgChannelEnabled('WEBHOOK'))) {
          channels.push({ channel, status: 'SUPPRESSED', reason: 'CHANNEL_DISABLED' });
          continue;
        }
        const delivery = await this.webhooks.notify('alert.test', { ruleId: rule.id, ruleName: rule.name, title, body });
        channels.push(delivery ? { channel, status: 'QUEUED' } : { channel, status: 'FAILED', reason: 'NO_WEBHOOK_CONFIGURED' });
      }
    }
    return { triggered: channels.some((c) => c.status === 'SENT' || c.status === 'QUEUED'), channels };
  }

  /**
   * EMAIL test — real SMTP via `TRANSACTIONAL_MAIL`, same subject/body layout as
   * `AlertProcessor.sendEmail`, prefixed `[TEST]`, addressed to the acting user/driver.
   */
  private async sendTestEmail(
    rule: { id: string; name: string; severity: string },
    actor: ContextUser,
    body: string,
  ): Promise<AlertRuleTestChannelResult> {
    if (!(await this.isOrgChannelEnabled('EMAIL'))) {
      return { channel: 'EMAIL', status: 'SUPPRESSED', reason: 'CHANNEL_DISABLED' };
    }
    const to = actor.type === 'api-key' ? null : await this.notifications.findLiveEmail(actor.type, actor.id);
    if (!to) return { channel: 'EMAIL', status: 'FAILED', reason: 'NO_EMAIL_ADDRESS' };
    const result = await this.mail.send({
      to,
      subject: `[TEST] OneBook ELD ${rule.severity.toLowerCase()} alert: ${rule.name}`.slice(0, 200),
      text: [body, '', `Severity: ${rule.severity}`, `Rule: ${rule.name}`].join('\n'),
    });
    if (!result.delivered) {
      this.logger.warn({ ruleId: rule.id, actor: actor.id, reason: result.reference }, 'EMAIL test alert was not delivered');
      return { channel: 'EMAIL', status: 'FAILED', reason: result.reference };
    }
    return { channel: 'EMAIL', status: 'SENT' };
  }

  /** TZ §20 B-87 — same org-level gate `AlertProcessor.isOrgChannelEnabled` applies live. */
  private async isOrgChannelEnabled(channel: 'EMAIL' | 'WEBHOOK'): Promise<boolean> {
    const org = await this.orgChannels.get();
    return channel === 'EMAIL' ? org.email.enabled : org.webhook.enabled;
  }
}
