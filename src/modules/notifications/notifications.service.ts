import { Injectable } from '@nestjs/common';
import { OffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
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

  async list(actor: ContextUser, query: NotificationListQueryDto): Promise<OffsetPage<unknown> & { counts: { all: number; violations: number; maintenance: number }; unreadCount: number }> {
    const recipient = toRecipient(actor);
    const [{ items, total }, counts, unreadCount] = await Promise.all([
      this.repo.list(recipient, query.page, query.limit, query.unreadOnly, query.category),
      this.repo.counts(recipient),
      this.repo.countUnread(recipient),
    ]);
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.max(1, Math.ceil(total / query.limit)), counts, unreadCount };
  }

  async readAll(actor: ContextUser) {
    const count = await this.repo.markAllRead(toRecipient(actor));
    return { updated: count };
  }

  /** §20 B-56 — 404s rather than 403s for a foreign id, so ownership is never confirmed either way. */
  async markRead(actor: ContextUser, id: string) {
    const notification = await this.repo.markRead(id, toRecipient(actor));
    if (!notification) throw new AppException(ERROR_CODES.NOT_FOUND, 'Notification not found.', 404, { id });
    return { id: notification.id, readAt: notification.readAt };
  }
}
