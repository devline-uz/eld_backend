import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import type { DataTransfer } from '@prisma/client';
import type { ContextUser } from '../../core/context/request-context';
import type { MobileCreateTransferDto, MobileTransferListQueryDto } from './dto/mobile-transfers.dto';
import type { PreSendFinding } from './pre-send-checks';
import { TransfersRepository } from './transfers.repository';
import { TransfersService } from './transfers.service';

/** B-159 — a result-less reservation older than this is treated as abandoned (crashed owner). */
const LEDGER_STALE_MS = 10 * 60 * 1000;

/** Receipt shape for the driver app (mobile/tz.md M-28 → S-10). */
export interface MobileTransferView {
  id: string;
  method: DataTransfer['method'];
  status: DataTransfer['status'];
  erodsMode: DataTransfer['erodsMode'];
  referenceId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  fileName: string;
  outputFileComment: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface MobileTransferCreated extends MobileTransferView {
  warnings: string[];
  counts: Record<string, number>;
  clientId: string | null;
  requestedAt: Date | null;
}

/**
 * mobile/tz.md §21 MB-4 — the driver-side wrapper over the eRODS transfer path (tz.md §10).
 * Nothing here differs from the back-office route except WHO the driver is: it is always the
 * token subject, so a driver can only ever transfer (and list) their own RODS. Generation,
 * Appendix A validation, pre-send checks, the TEST/PRODUCTION toggle, the recipient rule and
 * the audit row all come from `TransfersService.create()` unchanged.
 */
@Injectable()
export class MobileTransfersService {
  constructor(
    private readonly transfers: TransfersService,
    private readonly repo: TransfersRepository,
  ) {}

  async create(actor: ContextUser, dto: MobileCreateTransferDto): Promise<MobileTransferCreated> {
    // MB-18 — offline inspection transfers are queued on the device and replayed: the same
    // `clientId` yields the FIRST result, never a second file or a second FMCSA send.
    const { clientId, requestedAt, ...rest } = dto;
    if (clientId) {
      // B-159 — reserve the clientId row FIRST (unique constraint), only then generate/send. A
      // check-then-create let two concurrent replays both miss the ledger and both transfer.
      const reserved = await this.repo.reserveTransferLedger(actor.id, clientId, requestedAt ?? new Date());
      if (!reserved) {
        const prior = await this.repo.findTransferLedger(actor.id, clientId);
        const stale = prior && prior.type === 'create_transfer' && prior.result == null
          && (await this.repo.takeOverStaleTransferLedger(actor.id, clientId, new Date(Date.now() - LEDGER_STALE_MS)));
        if (!stale) return this.replay(prior, clientId);
      }
    }
    let result: MobileTransferCreated;
    try {
      const view = await this.transfers.create({ ...rest, driverId: actor.id }, actor);
      result = {
        ...toMobileView(view.transfer),
        /** §10.3 warnings (UNCERTIFIED_LOGS, UNRESOLVED_UNIDENTIFIED, ACTIVE_MALFUNCTION, ERODS_TEST_MODE). */
        warnings: view.warnings.map((w: PreSendFinding) => w.code),
        counts: view.counts,
        clientId: clientId ?? null,
        requestedAt: requestedAt ?? null,
      };
    } catch (err) {
      // Nothing was transferred: free the reservation so the device's next replay can retry.
      if (clientId) await this.repo.releaseTransferLedger(actor.id, clientId).catch(() => undefined);
      throw err;
    }
    if (clientId) {
      await this.repo.completeTransferLedger(actor.id, clientId, JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue);
    }
    return result;
  }

  private replay(prior: { type: string; result: unknown } | null, clientId: string): MobileTransferCreated {
    if (!prior || (prior.type === 'create_transfer' && prior.result == null)) {
      // B-159 — the first request is still generating/sending: never start a second transfer.
      throw AppException.conflict('A transfer with this clientId is still in progress; retry shortly.', { clientId, state: 'IN_PROGRESS' });
    }
    if (prior.type !== 'create_transfer') {
      throw AppException.conflict('clientId already used by another operation.', { clientId });
    }
    return prior.result as MobileTransferCreated;
  }

  async list(actor: ContextUser, query: MobileTransferListQueryDto) {
    const page = await this.repo.listTransfers({ driverId: actor.id }, 1, query.limit);
    return { items: page.items.map(toMobileView), total: page.total, limit: query.limit };
  }
}

export function toMobileView(t: DataTransfer): MobileTransferView {
  return {
    id: t.id,
    method: t.method,
    status: t.status,
    erodsMode: t.erodsMode,
    referenceId: t.referenceId,
    sentAt: t.sentAt,
    createdAt: t.createdAt,
    fileName: t.fileName,
    outputFileComment: t.outputFileComment,
    rangeStart: t.rangeStart,
    rangeEnd: t.rangeEnd,
  };
}
