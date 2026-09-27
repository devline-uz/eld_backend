import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Perm } from '../../common/decorators/perm.decorator';
import { AuditService } from './audit.service';
import { ApiStandardErrors } from '../../common/errors';
import { FigmaScreen } from '../../common/decorators/figma-screen.decorator';

/** TZ §11.7, §18 — read-only append-only log, gated by the `auditLog` permission key (ADMIN-only). */
@FigmaScreen('web/settings-audit-log')
@ApiTags('audit-log')
@ApiBearerAuth()
@Controller('audit-log')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Perm('auditLog', 'READ')
  @ApiQuery({ name: 'objectType', required: false })
  @ApiQuery({ name: 'objectId', required: false })
  @ApiQuery({ name: 'actorId', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOperation({ summary: 'Lists audit log entries, newest first, cursor-paginated (TZ §19).' })
  @ApiOkResponse({
    schema: {
      example: {
        items: [{ id: '42', actorType: 'USER', actorName: 'Sarah Chen', actorEmail: 'sarah.chen@universal-logistics.com', action: 'UPDATE', objectType: 'Role', objectId: 'role_1' }],
        nextCursor: null,
      },
    },
  })
  @ApiStandardErrors()
  list(
    @Query('objectType') objectType?: string,
    @Query('objectId') objectId?: string,
    @Query('actorId') actorId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.audit.list({ objectType, objectId, actorId }, parsedLimit, cursor);
  }
}
