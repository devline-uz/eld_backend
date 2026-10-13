import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsRepository } from './attachments.repository';
import { ChatAttachmentsService } from './chat-attachments.service';
import { AttachmentsService } from './attachments.service';

/**
 * TZ §20 B-41. `AttachmentsService` is exported so other modules (fleet-ops driver
 * documents, DVIR photo reads) can reuse the presign helper instead of reaching for
 * `STORAGE_PORT` directly.
 */
@Module({
  controllers: [AttachmentsController],
  providers: [AttachmentsService, AttachmentsRepository, ChatAttachmentsService],
  exports: [AttachmentsService, ChatAttachmentsService],
})
export class AttachmentsModule {}
