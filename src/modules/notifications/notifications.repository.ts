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

  listAll(): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({ orderBy: { name: 'asc' } });
  }

  findByKey(key: string): Promise<AlertRule | null> {
    return this.prisma.alertRule.findUnique({ where: { key } });
  }

  /** Enabled rules whose `conditions[].event` matches the given job/alert name. */
  findByEvent(event: string): Promise<AlertRule[]> {
    return this.prisma.alertRule.findMany({ where: { enabled: true } }).then((rows) =>
      rows.filter((r) => {
        const conditions = r.conditions as Array<{ event: string }>;
        return Array.isArray(conditions) && conditions.some((c) => c.event === event);
      }),
    );
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

  list(recipient: { userId?: string; driverId?: string }, page: number, limit: number, unreadOnly: boolean) {
    const where: Prisma.NotificationWhereInput = {
      ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }),
      ...(unreadOnly && { readAt: null }),
    };
    return Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.notification.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  async markAllRead(recipient: { userId?: string; driverId?: string }): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { ...(recipient.userId ? { userId: recipient.userId } : { driverId: recipient.driverId }), readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
