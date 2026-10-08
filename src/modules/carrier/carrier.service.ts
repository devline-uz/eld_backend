import { Injectable } from '@nestjs/common';
import type { Carrier } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { UpdateCarrierDto } from './dto/carrier.dto';
import { CarrierRepository } from './carrier.repository';

/**
 * TZ §5.1 / §11.7 — the single-row carrier profile.
 *
 * eRODS rules enforced here (§395 Appendix A > tz.md §10):
 * - `eldIdentifier`/`eldRegistrationId` shape is validated by `EldIdentifierSchema`
 *   (exactly 6 chars, Appendix A 7.15) / `EldRegistrationIdSchema` (exactly 4, 7.17), `A-Z`/`0-9`,
 *   and mirrored by DB CHECK constraints.
 * - `erodsMode` defaults to TEST and is plain data: flipping it to PRODUCTION is a
 *   configuration change, no code change. The one guard is that PRODUCTION may not be
 *   entered without an `eldRegistrationId`, because the Appendix A header segment would
 *   then be emitted empty and the file rejected (tz.md §10.1 lists both as steps 2-3).
 */
export interface TransferConfigView {
  timezone: string;
  eldIdentifier: string;
  eldRegistrationId: string | null;
  erodsMode: Carrier['erodsMode'];
}

@Injectable()
export class CarrierService {
  constructor(private readonly repo: CarrierRepository) {}

  async get(): Promise<Carrier> {
    return (await this.repo.get()) ?? this.repo.ensure();
  }

  /**
   * B-45 — the eRODS transfer settings a report/transfer screen needs (TEST/PRODUCTION banner,
   * Appendix A header identifiers), without exposing the whole carrier profile, which is
   * `carrierSettings`-gated (ADMIN only).
   */
  async getTransferConfig(): Promise<TransferConfigView> {
    const carrier = await this.get();
    return {
      timezone: carrier.timezone,
      eldIdentifier: carrier.eldIdentifier,
      eldRegistrationId: carrier.eldRegistrationId,
      erodsMode: carrier.erodsMode,
    };
  }

  async update(dto: UpdateCarrierDto): Promise<Carrier> {
    const current = await this.get();
    const nextMode = dto.erodsMode ?? current.erodsMode;
    const nextRegistrationId =
      dto.eldRegistrationId !== undefined ? dto.eldRegistrationId : current.eldRegistrationId;
    if (nextMode === 'PRODUCTION' && !nextRegistrationId) {
      throw AppException.unprocessable(
        ERROR_CODES.TRANSFER_VALIDATION_FAILED,
        'erodsMode=PRODUCTION requires a 4-character eldRegistrationId (§395 Appendix A header segment).',
        { field: 'eldRegistrationId' },
      );
    }
    return this.repo.update({
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.dotNumber !== undefined && { dotNumber: dto.dotNumber }),
      ...(dto.mcNumber !== undefined && { mcNumber: dto.mcNumber }),
      ...(dto.ein !== undefined && { ein: dto.ein }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.hosRuleset !== undefined && { hosRuleset: dto.hosRuleset }),
      ...(dto.distanceUnit !== undefined && { distanceUnit: dto.distanceUnit }),
      ...(dto.cycleRestart !== undefined && { cycleRestart: dto.cycleRestart }),
      ...(dto.unassignedThresholdMin !== undefined && { unassignedThresholdMin: dto.unassignedThresholdMin }),
      ...(dto.dvirRetentionMonths !== undefined && { dvirRetentionMonths: dto.dvirRetentionMonths }),
      ...(dto.allowPersonalConveyance !== undefined && { allowPersonalConveyance: dto.allowPersonalConveyance }),
      ...(dto.allowYardMove !== undefined && { allowYardMove: dto.allowYardMove }),
      ...(dto.addressLine1 !== undefined && { addressLine1: dto.addressLine1 }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.state !== undefined && { state: dto.state }),
      ...(dto.zip !== undefined && { zip: dto.zip }),
      ...(dto.phone !== undefined && { phone: dto.phone }),
      ...(dto.complianceEmail !== undefined && { complianceEmail: dto.complianceEmail }),
      ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
      ...(dto.eldIdentifier !== undefined && { eldIdentifier: dto.eldIdentifier }),
      ...(dto.eldRegistrationId !== undefined && { eldRegistrationId: dto.eldRegistrationId }),
      ...(dto.erodsMode !== undefined && { erodsMode: dto.erodsMode }),
    });
  }
}
