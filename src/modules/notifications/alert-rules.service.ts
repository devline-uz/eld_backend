import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { CreateAlertRuleDto, UpdateAlertRuleDto } from './dto/notifications.dto';
import { AlertRulesRepository } from './notifications.repository';

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
  constructor(private readonly repo: AlertRulesRepository) {}

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
}
