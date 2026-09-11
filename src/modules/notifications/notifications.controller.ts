import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors } from '../../common/errors';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import type { ContextUser } from '../../core/context/request-context';
import { NotificationListQueryDto } from './dto/notifications.dto';
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
  @ApiOperation({ summary: 'Lists the caller\'s own in-app notifications.' })
  @ApiOkResponse({ schema: { example: { items: [{ id: 'ntf_1', type: 'hos_violation', title: 'HOS violation', body: 'Driving limit exceeded.', readAt: null }], page: 1, limit: 25, total: 1, totalPages: 1 } } })
  @ApiStandardErrors({ errors: [apiError.unauthorized()] })
  list(@Query(zodBody(NotificationListQueryDto)) query: NotificationListQueryDto, @CurrentUser() actor: ContextUser) {
    return this.notifications.list(actor, query);
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Marks every unread notification of the caller as read.' })
  @ApiOkResponse({ schema: { example: { updated: 3 } } })
  @ApiStandardErrors({ errors: [apiError.unauthorized()] })
  readAll(@CurrentUser() actor: ContextUser) {
    return this.notifications.readAll(actor);
  }
}
