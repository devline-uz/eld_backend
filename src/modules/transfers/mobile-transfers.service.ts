import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import type { DataTransfer } from '@prisma/client';
import type { ContextUser } from '../../core/context/request-context';
import type { MobileCreateTransferDto, MobileTransferListQueryDto } from './dto/mobile-transfers.dto';
import type { PreSendFinding } from './pre-send-checks';
import { TransfersRepository } from './transfers.repository';
import { TransfersService } from './transfers.service';

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
      const prior = await this.repo.findTransferLedger(actor.id, clientId);
      if (prior) return this.replay(prior, clientId);
    }
    const view = await this.transfers.create({ ...rest, driverId: actor.id }, actor);
    const result = {
      ...toMobileView(view.transfer),
      /** §10.3 warnings (UNCERTIFIED_LOGS, UNRESOLVED_UNIDENTIFIED, ACTIVE_MALFUNCTION, ERODS_TEST_MODE). */
      warnings: view.warnings.map((w: PreSendFinding) => w.code),
      counts: view.counts,
      clientId: clientId ?? null,
      requestedAt: requestedAt ?? null,
    };
    if (clientId) {
      const won = await this.repo.recordTransferLedger(
        actor.id,
        clientId,
        requestedAt ?? new Date(),
        JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
      );
      if (!won) {
        const prior = await this.repo.findTransferLedger(actor.id, clientId);
        if (prior) return this.replay(prior, clientId);
      }
    }
    return result;
  }

  private replay(prior: { type: string; result: unknown }, clientId: string): MobileTransferCreated {
    if (prior.type !== 'create_transfer' || !prior.result) {
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
