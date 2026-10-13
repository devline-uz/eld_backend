import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { DriverGuard } from '../../common/guards/driver.guard';
import { ApiEnvelopeResponse } from '../../common/swagger/api-envelope';
import type { ContextUser } from '../../core/context/request-context';
import { AttachmentsService } from '../attachments/attachments.service';

export class MobileAttachmentPresignResponse {
  @ApiProperty({ example: 'https://eldapi.stackyard.uz/onebook-eld/chat/carrier/drv_1/att.m4a?X-Amz-Signature=...' }) url!: string;
  @ApiProperty({ format: 'date-time', example: '2026-10-11T15:15:00.000Z' }) expiresAt!: string;
}

/** MB-9 — driver-side presign for chat voice/file attachments (and the driver's own uploads). */
@ApiTags('mobile')
@ApiBearerAuth()
@UseGuards(DriverGuard)
@Controller('mobile/attachments')
export class MobileAttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get(':id/presign')
  @ApiOperation({
    summary: 'MB-9 — short-lived (15 min) presigned GET for an attachment the driver may read: a chat file only for participants of its conversation (or its uploader before it is sent).',
    description: 'Same 404 for an unknown id and for an attachment the driver may not see. Message lists already carry a presigned `attachment.url`; use this to refresh an expired one.',
  })
  @ApiEnvelopeResponse(MobileAttachmentPresignResponse, { example: { url: 'https://eldapi.stackyard.uz/onebook-eld/chat/carrier/drv_1/att.m4a?X-Amz-Signature=...', expiresAt: '2026-10-11T15:15:00.000Z' } })
  @ApiStandardErrors({ errors: [apiError.notFound(ERROR_CODES.ATTACHMENT_NOT_FOUND, 'Attachment not found.')] })
  presign(@Param('id') id: string, @CurrentUser() actor: ContextUser) {
    return this.attachments.presignAttachment(id, actor);
  }
}
