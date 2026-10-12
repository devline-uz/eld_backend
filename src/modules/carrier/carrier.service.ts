import { Injectable, Logger } from '@nestjs/common';
import { EditorType, type Carrier } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { RequestContext } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { AuditRepository } from '../audit/audit.repository';
import { UpdateCarrierDto } from './dto/carrier.dto';
import { CarrierRepository } from './carrier.repository';
import { resolveVirtualEldEnabled, VirtualEldPolicy } from './virtual-eld.policy';

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

/** `GET`/`PATCH /carrier` response — pt30_pt40/tz.md §9.3 adds `virtualEldAvailable` (env permission)
 * and `virtualEldUpdatedBy` (who last flipped the switch; null if never, or not a back-office user). */
export type CarrierView = Carrier & {
  virtualEldAvailable: boolean;
  virtualEldUpdatedBy: { id: string; name: string } | null;
};

@Injectable()
export class CarrierService {
  private readonly logger = new Logger(CarrierService.name);

  constructor(
    private readonly repo: CarrierRepository,
    private readonly virtualEld: VirtualEldPolicy,
    private readonly audit: AuditRepository,
    private readonly events: EventBusService,
  ) {}

  /** `GET /carrier` — the profile plus `virtualEldAvailable` (§9.2: web hides the switch when false). */
  async view(): Promise<CarrierView> {
    return this.toView(await this.get());
  }

  private async toView(carrier: Carrier): Promise<CarrierView> {
    const updatedBy = carrier.virtualEldUpdatedById ? await this.repo.findUserName(carrier.virtualEldUpdatedById) : null;
    return { ...carrier, virtualEldAvailable: this.virtualEld.allowed, virtualEldUpdatedBy: updatedBy };
  }

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

  async update(dto: UpdateCarrierDto): Promise<CarrierView> {
    const current = await this.get();
    const nextMode = dto.erodsMode ?? current.erodsMode;
    const nextVirtualEld = dto.virtualEldEnabled ?? current.virtualEldEnabled;
    // pt30_pt40/tz.md §9.2 — env permission first, then the TEST-only rule (both directions:
    // turning the switch on in PRODUCTION, and moving to PRODUCTION while it is on).
    if (dto.virtualEldEnabled === true && !this.virtualEld.allowed) {
      throw new AppException(
        ERROR_CODES.VIRTUAL_ELD_NOT_ALLOWED,
        'Virtual ELD (Test PT30/40) is not allowed in this environment.',
        409,
        { field: 'virtualEldEnabled' },
      );
    }
    if (nextVirtualEld && nextMode === 'PRODUCTION') {
      throw new AppException(
        ERROR_CODES.VIRTUAL_ELD_REQUIRES_TEST_ERODS,
        'Test PT30/40 mode requires erodsMode=TEST — turn the test mode off before switching eRODS to PRODUCTION.',
        409,
        { field: dto.virtualEldEnabled === true ? 'virtualEldEnabled' : 'erodsMode' },
      );
    }
    const virtualEldChanged =
      dto.virtualEldEnabled !== undefined && dto.virtualEldEnabled !== current.virtualEldEnabled;
    const actor = RequestContext.user;
    const nextRegistrationId =
      dto.eldRegistrationId !== undefined ? dto.eldRegistrationId : current.eldRegistrationId;
    if (nextMode === 'PRODUCTION' && !nextRegistrationId) {
      throw AppException.unprocessable(
        ERROR_CODES.TRANSFER_VALIDATION_FAILED,
        'erodsMode=PRODUCTION requires a 4-character eldRegistrationId (§395 Appendix A header segment).',
        { field: 'eldRegistrationId' },
      );
    }
    const updated = await this.repo.update({
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
      ...(virtualEldChanged && {
        virtualEldEnabled: dto.virtualEldEnabled,
        virtualEldUpdatedAt: new Date(),
        virtualEldUpdatedById: actor?.id ?? null,
      }),
    });
    if (virtualEldChanged) await this.onVirtualEldChanged(current.virtualEldEnabled, updated);
    return this.toView(updated);
  }

  /** §9.3 audit + §9.4 realtime: back office (`fleet`) gets `carrier.updated`, every active driver `virtual_eld.changed`. */
  private async onVirtualEldChanged(before: boolean, carrier: Carrier): Promise<void> {
    const ctx = RequestContext.get();
    const actor = ctx?.user;
    await this.audit.insert({
      actorId: actor?.id ?? 'system',
      actorType: actor?.type === 'driver' ? EditorType.DRIVER : actor?.type === 'user' ? EditorType.USER : EditorType.SYSTEM,
      action: carrier.virtualEldEnabled ? 'carrier.virtual_eld.enabled' : 'carrier.virtual_eld.disabled',
      objectType: 'Carrier',
      objectId: carrier.id,
      before: { virtualEldEnabled: before },
      after: { virtualEldEnabled: carrier.virtualEldEnabled, erodsMode: carrier.erodsMode },
      detail: carrier.virtualEldEnabled
        ? 'Test PT30/40 (Virtual ELD) mode turned on.'
        : 'Test PT30/40 (Virtual ELD) mode turned off — virtual devices are refused from now on; their data is kept.',
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
    });

    const enabled = resolveVirtualEldEnabled(this.virtualEld.allowed, carrier);
    try {
      await this.events.publish('realtime.push', {
        room: 'fleet',
        event: 'carrier.updated',
        payload: {
          virtualEldEnabled: carrier.virtualEldEnabled,
          virtualEldAvailable: this.virtualEld.allowed,
          virtualEldUpdatedAt: carrier.virtualEldUpdatedAt,
        },
      });
      const driverIds = await this.repo.findActiveDriverIds();
      for (const driverId of driverIds) {
        await this.events.publish('realtime.push', {
          room: `driver:${driverId}`,
          event: 'virtual_eld.changed',
          payload: { enabled },
        });
      }
    } catch (err) {
      // The switch itself is committed and audited; a missed push is recovered by the next
      // bootstrap / app-config read (§8.2 rule 3).
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'virtual_eld realtime push failed');
    }
  }
}
