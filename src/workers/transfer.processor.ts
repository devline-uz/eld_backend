import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AppException } from '../common/errors/app.exception';
import { ERROR_CODES } from '../common/errors/codes';
import { QUEUES } from '../core/queue/queue.constants';
import { AuditRepository } from '../modules/audit/audit.repository';
import { FmcsaTransferService } from '../modules/transfers/fmcsa-transfer.service';
import { TransfersRepository } from '../modules/transfers/transfers.repository';
import type { TransferJobData } from '../modules/transfers/transfers.service';
import { TransfersService } from '../modules/transfers/transfers.service';

/**
 * TZ §10.1 / §10.4 — the SEND step of an eRODS transfer.
 *
 * The file is already generated, Appendix A-validated and stored by `TransfersService`;
 * this processor only transmits it. `Carrier.erodsMode` decides whether it is transmitted at
 * all, and the decision is read fresh from the DB on every attempt — flipping the toggle to
 * PRODUCTION takes effect on the next job with no deploy (§10.1, settings-only).
 */
@Processor(QUEUES.TRANSFER)
export class TransferProcessor extends WorkerHost {
  private readonly logger = new Logger(TransferProcessor.name);

  constructor(
    private readonly repo: TransfersRepository,
    private readonly transfers: TransfersService,
    private readonly fmcsa: FmcsaTransferService,
    private readonly audit: AuditRepository,
  ) {
    super();
  }

  async process(job: Job<TransferJobData>): Promise<void> {
    const transfer = await this.repo.findTransfer(job.data.transferId);
    if (!transfer) {
      this.logger.warn({ transferId: job.data.transferId }, 'DataTransfer row missing — skipping.');
      return;
    }
    if (transfer.status !== 'QUEUED') {
      this.logger.log({ transferId: transfer.id, status: transfer.status }, 'Transfer already resolved — skipping.');
      return;
    }

    const carrier = await this.repo.findCarrier();
    // erodsMode is re-read from the carrier profile, not taken from the (possibly stale) row.
    const erodsMode = carrier?.erodsMode ?? transfer.erodsMode;
    // The recipient is parked on the transfer row at request time (EMAIL only).
    const recipient = transfer.method === 'EMAIL' ? transfer.responseBody : null;
    const fileBytes = await this.transfers.loadFile(transfer);

    let result;
    try {
      result = await this.fmcsa.send({
        transferId: transfer.id,
        method: transfer.method,
        erodsMode,
        fileName: transfer.fileName,
        fileBytes,
        outputFileComment: transfer.outputFileComment,
        recipient,
      });
    } catch (err) {
      const code = err instanceof AppException ? err.code : 'UNKNOWN';
      await this.repo.updateTransfer(transfer.id, {
        status: 'FAILED',
        attempts: transfer.attempts + 1,
        responseCode: String(code),
        responseBody: err instanceof Error ? err.message.slice(0, 2_000) : 'unknown error',
      });
      throw err;
    }

    // §10.4 — `DataTransfer.encrypted` must be true for a DISPATCHED email transfer. A false
    // value here means the payload left unencrypted, which fails the job rather than being
    // recorded as a successful transfer.
    if (transfer.method === 'EMAIL' && result.status === 'SENT' && !result.encrypted) {
      await this.repo.updateTransfer(transfer.id, {
        status: 'FAILED',
        attempts: transfer.attempts + 1,
        responseCode: ERROR_CODES.TRANSFER_NOT_ENCRYPTED,
      });
      throw AppException.unprocessable(
        ERROR_CODES.TRANSFER_NOT_ENCRYPTED,
        'An eRODS email transfer reported success without encryption — refusing to record it as sent (§10.4).',
      );
    }

    await this.repo.updateTransfer(transfer.id, {
      status: result.status,
      encrypted: result.encrypted,
      referenceId: result.referenceId,
      responseCode: result.responseCode,
      responseBody: result.responseBody,
      attempts: transfer.attempts + 1,
      sentAt: result.sentAt,
    });

    await this.audit.insert({
      actorId: transfer.requestedById ?? 'system',
      actorType: transfer.requestedByType,
      action: result.status === 'TEST_ONLY' ? 'ERODS_TRANSFER_TEST_ONLY' : 'ERODS_TRANSFER_SEND',
      objectType: 'DataTransfer',
      objectId: transfer.id,
      after: {
        status: result.status,
        method: transfer.method,
        encrypted: result.encrypted,
        erodsMode,
        fileName: transfer.fileName,
      },
      detail:
        result.status === 'TEST_ONLY'
          ? `eRODS TEST mode — ${transfer.fileName} generated and stored, not sent to FMCSA.`
          : `eRODS ${transfer.method} transfer of ${transfer.fileName} finished with ${result.status}.`,
    });
  }
}
