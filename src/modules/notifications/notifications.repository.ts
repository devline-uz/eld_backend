import { Injectable } from '@nestjs/common';
import { NotificationKind, type AlertRule, type Notification, type Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { conditionParamsMatch, ruleEventsFor, type RuleCondition } from './lib/alert-events';
import { effectiveNotificationCategory } from './lib/notification-kind';

/**
 * A segment filter. Device/ELD rows stored before the CONNECTIVITY segment existed still say
 * `MAINTENANCE` (kind DEVICE): they count under CONNECTIVITY and never under Maintenance.
 */
function categoryWhere(category: string): Prisma.NotificationWhereInput {
  if (category === 'CONNECTIVITY') {
    return { OR: [{ category: 'CONNECTIVITY' }, { category: 'MAINTENANCE', kind: NotificationKind.DEVICE }] };
  }
  if (category === 'MAINTENANCE') {
    return { category: 'MAINTENANCE', OR: [{ kind: null }, { kind: { not: NotificationKind.DEVICE } }] };
  }
  return { category };
}

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
  async findByEvent(event: string, payload: Record<string, unknown> = {}): Promise<AlertRule[]> {
    // LIVE-027 — a job also matches the editor vocabulary it stands for (`ruleEventsFor`).
    const events = new Set(ruleEventsFor(event, payload));
    const now = new Date();
    await this.prisma.alertRule.updateMany({
      where: { mutedUntil: { lte: now } },
      data: { mutedUntil: null },
    });
    const rows = await this.prisma.alertRule.findMany({
      where: { enabled: true, mutedUntil: null },
    });
    return rows.filter((r) => {
      const conditions = r.conditions as unknown as RuleCondition[];
      // LIVE-027 — `params.minutes` (break due within / offline for / unassigned longer than) is honoured.
      return Array.isArray(conditions) && conditions.some((c) => events.has(c.event) && conditionParamsMatch(c, payload, now));
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

  /**
   * BE-12 — whether this rule already produced a delivery row (any status) to this recipient for
   * this driver's break deadline: a "break due within M" rule is delivered once per break.
   */
  async existsForBreakEpisode(alertRuleId: string, recipient: string, episode: { driverId: string; nextBreakDueAt: string }): Promise<boolean> {
    const row = await this.prisma.alertDelivery.findFirst({
      where: {
        alertRuleId,
        recipient,
        AND: [
          { payload: { path: ['driverId'], equals: episode.driverId } },
          { payload: { path: ['nextBreakDueAt'], equals: episode.nextBreakDueAt } },
        ],
      },
      select: { id: true },
    });
    return row !== null;
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

  /**
   * Alert-mail address for a recipient — same "live accounts only" rule as
   * `AlertProcessor.resolveEmail`: an ACTIVE user, or a non-deleted ACTIVE driver with an email.
   */
  async findLiveEmail(kind: 'user' | 'driver', id: string): Promise<string | null> {
    if (kind === 'user') {
      const user = await this.prisma.user.findUnique({ where: { id }, select: { email: true, status: true } });
      return user?.status === 'ACTIVE' && user.email ? user.email : null;
    }
    const driver = await this.prisma.driver.findUnique({
      where: { id },
      select: { email: true, status: true, deletedAt: true },
    });
    return driver && driver.status === 'ACTIVE' && !driver.deletedAt && driver.email ? driver.email : null;
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
      ...(category && categoryWhere(category)),
    };
    return Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notification.count({ where }),
    ]).then(([items, total]) => ({
      items: items.map((item) => ({ ...item, category: effectiveNotificationCategory(item) })),
      total,
    }));
  }

  /** §20 B-57 — sidebar counts; `all` ignores `category`/`unreadOnly` entirely. */
  async counts(
    recipient: { userId?: string; driverId?: string },
  ): Promise<{ all: number; violations: number; maintenance: number; connectivity: number }> {
    const base: Prisma.NotificationWhereInput = recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId };
    const [all, violations, maintenance, connectivity] = await Promise.all([
      this.prisma.notification.count({ where: base }),
      this.prisma.notification.count({ where: { ...base, ...categoryWhere('VIOLATIONS') } }),
      this.prisma.notification.count({ where: { ...base, ...categoryWhere('MAINTENANCE') } }),
      this.prisma.notification.count({ where: { ...base, ...categoryWhere('CONNECTIVITY') } }),
    ]);
    return { all, violations, maintenance, connectivity };
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
