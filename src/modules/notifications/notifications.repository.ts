import { Injectable } from '@nestjs/common';
import type { AlertRule, Notification, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

@Injectable()
export class AlertRulesRepository extends BaseRepository<
  AlertRule,
  Prisma.AlertRuleWhereInput,
  Prisma.AlertRuleWhereUniqueInput,
  Prisma.AlertRuleCreateInput,
  Prisma.AlertRuleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    AlertRule,
    Prisma.AlertRuleWhereInput,
    Prisma.AlertRuleWhereUniqueInput,
    Prisma.AlertRuleCreateInput,
    Prisma.AlertRuleUpdateInput
  > {
    return this.prisma.alertRule;
  }

  async listAll(): Promise<AlertRule[]> {
    // §20 B-86 — surface an expired mute as cleared here too, not only on the next event match.
    await this.prisma.alertRule.updateMany({ where: { mutedUntil: { lte: new Date() } }, data: { mutedUntil: null } });
    return this.prisma.alertRule.findMany({ orderBy: { name: 'asc' } });
  }

  findByKey(key: string): Promise<AlertRule | null> {
    return this.prisma.alertRule.findUnique({ where: { key } });
  }

  /**
   * Enabled, currently-unmuted rules whose `conditions[].event` matches the given job/alert
   * name. §20 B-86 — a rule "Mute for 24h"'d (`mutedUntil` in the future) is skipped; once
   * `mutedUntil` has passed it is cleared here (not just ignored) so the row goes back to
   * reading as a plain un-muted rule everywhere else (list/get/UI) without a date comparison.
   */
  async findByEvent(event: string): Promise<AlertRule[]> {
    const now = new Date();
    await this.prisma.alertRule.updateMany({
      where: { mutedUntil: { lte: now } },
      data: { mutedUntil: null },
    });
    const rows = await this.prisma.alertRule.findMany({
      where: { enabled: true, mutedUntil: null },
    });
    return rows.filter((r) => {
      const conditions = r.conditions as Array<{ event: string }>;
      return Array.isArray(conditions) && conditions.some((c) => c.event === event);
    });
  }
}

@Injectable()
export class AlertDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.AlertDeliveryCreateInput) {
    return this.prisma.alertDelivery.create({ data });
  }

  /** Deliveries of this rule to this recipient since `sinceLocalMidnightUtc` (§14 throttle). */
  countToday(alertRuleId: string, recipient: string, sinceLocalMidnightUtc: Date): Promise<number> {
    return this.prisma.alertDelivery.count({
      where: { alertRuleId, recipient, status: 'SENT', createdAt: { gte: sinceLocalMidnightUtc } },
    });
  }

  lastDelivered(alertRuleId: string, recipient: string) {
    return this.prisma.alertDelivery.findFirst({
      where: { alertRuleId, recipient, status: 'SENT' },
      orderBy: { sentAt: 'desc' },
    });
  }

  markSent(id: string) {
    return this.prisma.alertDelivery.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 } } });
  }

  markSuppressed(id: string, reason: string) {
    return this.prisma.alertDelivery.update({ where: { id }, data: { status: 'SUPPRESSED', error: reason } });
  }

  markFailed(id: string, error: string) {
    return this.prisma.alertDelivery.update({ where: { id }, data: { status: 'FAILED', error, attempts: { increment: 1 } } });
  }
}

@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: Prisma.NotificationCreateInput): Promise<Notification> {
    return this.prisma.notification.create({ data });
  }

  list(
    recipient: { userId?: string; driverId?: string },
    page: number,
    limit: number,
    unreadOnly: boolean,
    category?: string,
  ) {
    const where: Prisma.NotificationWhereInput = {
      ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }),
      ...(unreadOnly && { readAt: null }),
      ...(category && { category }),
    };
    return Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notification.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  /** §20 B-57 — sidebar counts; `all` ignores `category`/`unreadOnly` entirely. */
  async counts(recipient: { userId?: string; driverId?: string }): Promise<{ all: number; violations: number; maintenance: number }> {
    const base: Prisma.NotificationWhereInput = recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId };
    const [all, violations, maintenance] = await Promise.all([
      this.prisma.notification.count({ where: base }),
      this.prisma.notification.count({ where: { ...base, category: 'VIOLATIONS' } }),
      this.prisma.notification.count({ where: { ...base, category: 'MAINTENANCE' } }),
    ]);
    return { all, violations, maintenance };
  }

  /** MR-19 — unread rows for the recipient (all categories, ignores `category`/`unreadOnly`). */
  countUnread(recipient: { userId?: string; driverId?: string }): Promise<number> {
    return this.prisma.notification.count({
      where: { ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }), readAt: null },
    });
  }

  async markAllRead(recipient: { userId?: string; driverId?: string }): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }), readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  /**
   * §20 B-56 — marks exactly one of the caller's own notifications read. Scoped by
   * recipient in the `WHERE` (not a separate ownership check) so this both 404s for a
   * foreign id and never leaks whether that id exists.
   */
  async markRead(id: string, recipient: { userId?: string; driverId?: string }): Promise<Notification | null> {
    const result = await this.prisma.notification.updateMany({
      where: { id, ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }), readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count > 0) return this.prisma.notification.findUnique({ where: { id } });
    // Already read (by the same recipient) or not theirs at all — tell the two apart so a
    // double-click on an already-read row still answers 200, not a spurious 404.
    const existing = await this.prisma.notification.findFirst({
      where: { id, ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }) },
    });
    return existing;
  }
}
