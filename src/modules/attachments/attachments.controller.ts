import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import type { ContextUser } from '../../core/context/request-context';
import { AttachmentsService } from './attachments.service';

/**
 * TZ §20 B-41 — a short-lived, permission-checked download URL for a stored `Attachment`
 * (DVIR/defect photo, support-ticket attachment). Every object is private in MinIO/S3;
 * this is the only way the web/mobile client ever resolves one to a fetchable URL.
 */
@ApiTags('attachments')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/presign')
  @ApiOperation({ summary: 'Short-lived (15 min) presigned GET URL for one attachment, permission-checked against its owning DVIR/defect/ticket.' })
  @ApiOkResponse({ schema: { example: { url: 'https://minio.internal/onebook/dvir/photo.jpg?X-Amz-Signature=...', expiresAt: '2026-09-24T15:56:00.000Z' } } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'Attachment not found.')] })
  presign(@Param('id') id: string, @CurrentUser() actor: ContextUser) {
    return this.attachments.presignAttachment(id, actor);
  }
}
