import { Injectable } from '@nestjs/common';
import { OffsetPage } from '../../common/dto/list-query.dto';
import type { ContextUser } from '../../core/context/request-context';
import { NotificationListQueryDto } from './dto/notifications.dto';
import { NotificationsRepository } from './notifications.repository';

function toRecipient(actor: ContextUser) {
  return actor.type === 'driver' ? { driverId: actor.id } : { userId: actor.id };
}

/** TZ §14 in-app notification inbox (the bell icon — no dedicated Figma export available). */
@Injectable()
export class NotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  async list(actor: ContextUser, query: NotificationListQueryDto): Promise<OffsetPage<unknown>> {
    const { items, total } = await this.repo.list(toRecipient(actor), query.page, query.limit, query.unreadOnly);
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)) };
  }

  async readAll(actor: ContextUser) {
    const count = await this.repo.markAllRead(toRecipient(actor));
    return { updated: count };
  }
}
