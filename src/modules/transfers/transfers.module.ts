import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FmcsaEncryptionService } from './fmcsa-encryption.service';
import { FmcsaTransferService } from './fmcsa-transfer.service';
import { LoggingMailTransport } from './logging-mail.transport';
import { MAIL_PORT } from './mail.port';
import { TransfersController } from './transfers.controller';
import { TransfersRepository } from './transfers.repository';
import { TransfersService } from './transfers.service';

/**
 * TZ §10 — eRODS (TEST mode by default).
 *
 * `MAIL_PORT` is bound to `LoggingMailTransport`: no SMTP client exists in the project yet
 * and FMCSA's mailbox/subject/key are still open (tasks.md #3). Binding a real transport is
 * a one-line provider swap here.
 */
@Module({
  imports: [AuditModule],
  controllers: [TransfersController],
  providers: [
    TransfersService,
    TransfersRepository,
    FmcsaTransferService,
    FmcsaEncryptionService,
    { provide: MAIL_PORT, useClass: LoggingMailTransport },
  ],
  exports: [TransfersService, TransfersRepository, FmcsaTransferService, FmcsaEncryptionService],
})
export class TransfersModule {}
