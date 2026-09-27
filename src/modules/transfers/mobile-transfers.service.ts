import { Injectable } from '@nestjs/common';
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

  async create(actor: ContextUser, dto: MobileCreateTransferDto) {
    const view = await this.transfers.create({ ...dto, driverId: actor.id }, actor);
    return {
      ...toMobileView(view.transfer),
      /** §10.3 warnings (UNCERTIFIED_LOGS, UNRESOLVED_UNIDENTIFIED, ACTIVE_MALFUNCTION, ERODS_TEST_MODE). */
      warnings: view.warnings.map((w: PreSendFinding) => w.code),
      counts: view.counts,
    };
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
