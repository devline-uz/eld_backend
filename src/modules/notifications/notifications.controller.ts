import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { NotificationListQueryDto } from './dto/notifications.dto';
import { NotificationListResponse, NotificationReadResponse, NotificationsUpdatedResponse } from './dto/notifications.responses';
import { NotificationsService } from './notifications.service';

/**
 * TZ §14 — the caller's own in-app notification inbox (bell icon). Personal data, not
 * gated by a permission-matrix key: any authenticated user/driver reads their own inbox.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'unreadOnly', required: false })
  @ApiQuery({ name: 'category', required: false, enum: ['VIOLATIONS', 'MAINTENANCE'] })
  @ApiOperation({
    summary: "Lists the caller's own in-app notifications, with segment counts.",
    description:
      'Every item carries `createdAt` (ISO-8601, newest first). `total`/`totalPages` describe the filtered list (honour `unreadOnly`/`category`). ' +
      '`counts` are TOTAL rows per segment (read + unread), ignoring `unreadOnly`/`category` — they are NOT unread counts. ' +
      '`unreadCount` is the number of unread notifications across all categories (badge number).',
  })
  @ApiEnvelopeResponse(NotificationListResponse, {
    example: {
      items: [{ id: 'ntf_1', userId: null, driverId: 'drv_1', type: 'hos_violation', kind: 'VIOLATION', title: 'HOS violation', body: 'An HOS violation was detected.', objectType: 'Driver', objectId: 'drv_1', category: 'VIOLATIONS', severity: 'CRITICAL', readAt: null, createdAt: '2026-10-08T15:41:00.000Z' }],
      page: 1, limit: 25, total: 1, totalPages: 1, counts: { all: 12, violations: 5, maintenance: 3 }, unreadCount: 4,
    },
  })
  @ApiStandardErrors({ errors: [apiError.unauthorized()] })
  list(@Query(zodBody(NotificationListQueryDto)) query: NotificationListQueryDto, @CurrentUser() actor: ContextUser) {
    return this.notifications.list(actor, query);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Marks every unread notification of the caller as read.' })
  @ApiEnvelopeResponse(NotificationsUpdatedResponse, { status: 201, example: { updated: 3 } })
  @ApiStandardErrors({ errors: [apiError.unauthorized()] })
  readAll(@CurrentUser() actor: ContextUser) {
    return this.notifications.readAll(actor);
  }

  @Post(':id/read')
  @ApiOperation({ summary: "Marks one of the caller's own notifications as read." })
  @ApiEnvelopeResponse(NotificationReadResponse, { status: 201, example: { id: 'ntf_1', readAt: '2026-09-24T15:41:00.000Z' } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.NOT_FOUND, 'Notification not found.')] })
  markRead(@Param('id') id: string, @CurrentUser() actor: ContextUser) {
    return this.notifications.markRead(actor, id);
  }
}
