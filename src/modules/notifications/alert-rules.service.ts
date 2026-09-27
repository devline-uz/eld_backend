import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { EventBusService } from '../../core/events/event-bus.service';
import type { ContextUser } from '../../core/context/request-context';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/notifications.dto';
import { AlertRulesRepository, NotificationsRepository } from './notifications.repository';

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
   * A disabled rule triggers nothing (`{ triggered: false }`): the point of the button is to
   * preview what a *live* rule would do.
   */
  async testRule(id: string, actor: ContextUser): Promise<{ triggered: boolean }> {
    const rule = await this.get(id);
    if (!rule.enabled) return { triggered: false };

    const title = `Test: ${rule.name}`;
    const body = `This is a test notification for the "${rule.name}" alert rule.`;
    let triggered = false;

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
        triggered = true;
      } else if (channel === 'EMAIL') {
        // No SMTP transport configured yet (same gap as AlertProcessor/TransfersModule).
        this.logger.log({ ruleId: rule.id, actor: actor.id }, 'EMAIL test alert (no SMTP transport configured yet)');
        triggered = true;
      } else if (channel === 'WEBHOOK') {
        await this.webhooks.notify('alert.test', { ruleId: rule.id, ruleName: rule.name, title, body });
        triggered = true;
      }
    }
    return { triggered };
  }
}
