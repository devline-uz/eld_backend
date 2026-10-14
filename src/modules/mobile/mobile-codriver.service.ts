import { Injectable, Logger, Optional } from '@nestjs/common';
import { EditorType, Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { RequestContext } from '../../core/context/request-context';
import type { AccessTokenPair, RequestMeta } from '../auth/auth.service';
import { AuthService } from '../auth/auth.service';
import { AuditRepository } from '../audit/audit.repository';
import type { CoDriverSwitchDto } from './dto/mobile-fleet-ops.dto';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileTripService } from './mobile-trip.service';
import { MobileRepository } from './mobile.repository';
import { EventBusService } from '../../core/events/event-bus.service';
import { publishBootstrapChanged, publishVehicleUnassigned } from '../vehicles/vehicle-assignment-events';
import { RodsLoginRecorder } from '../logs/rods-login-recorder';

const LEDGER_TYPE = 'co_driver_switch';

/**
 * mobile/tz.md §21.1 MB-3, screens S-11/S-18/S-19 — the driver-seat handoff between an
 * active `CoDriverPairing`'s two drivers.
 *
 * The co-driver's password is verified through `AuthService.loginDriver` — the SAME code
 * path `POST /auth/login/driver` uses — so hashing, the `ACTIVE`-status check and refresh
 * session bookkeeping are exercised in exactly one place (never duplicated here).
 */
@Injectable()
export class MobileCoDriverService {
  private readonly logger = new Logger(MobileCoDriverService.name);

  constructor(
    private readonly repo: MobileFleetOpsRepository,
    private readonly mobileRepo: MobileRepository,
    private readonly auth: AuthService,
    private readonly audit: AuditRepository,
    private readonly trips: MobileTripService,
    private readonly loginRecords: RodsLoginRecorder,
    @Optional() private readonly events?: EventBusService,
  ) {}

  /** MR-15 — the caller's active pairing (as either seat), or null. */
  async current(driverId: string) {
    const pairing = await this.mobileRepo.findActivePairing(driverId);
    if (!pairing) return null;
    const coDriverId = pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId;
    const [coDriver, trip] = await Promise.all([this.mobileRepo.findDriver(coDriverId), this.trips.activeTripLists(driverId)]);
    if (!coDriver) return null;
    return {
      pairingId: pairing.id,
      startedAt: pairing.startedAt,
      coDriver: { id: coDriver.id, firstName: coDriver.firstName, lastName: coDriver.lastName, username: coDriver.username },
      ...(trip ? { trip } : {}),
    };
  }

  async switch(driverId: string, dto: CoDriverSwitchDto, actor: ContextUser, meta: RequestMeta, sessionId?: string): Promise<AccessTokenPair> {
    // D-155 — replay: the same clientId returns the first pair (encrypted under the password, short TTL).
    if (dto.clientId) {
      const prior = await this.mobileRepo.findSyncedByClientId(driverId, dto.clientId);
      if (prior) {
        if (prior.type !== LEDGER_TYPE) throw AppException.conflict('clientId already used by another operation.', { clientId: dto.clientId });
        const pair = await this.auth.recallSwitchPair(dto.coDriverPassword, `${driverId}:${dto.clientId}`);
        if (pair) return pair;
        throw AppException.conflict('This switch was already applied — sign in as the co-driver.', { clientId: dto.clientId });
      }
    }
    // D-155 — the caller's own session family goes with the switch; a caller whose session was
    // already revoked (stale token, no clientId replay) must not swap the seats back.
    const outgoing = await this.auth.resolveDriverSessionFamily(driverId, sessionId);
    if (outgoing?.revoked) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'Session was revoked — sign in again.', 401);
    const pairing = await this.mobileRepo.findActivePairing(driverId);
    if (!pairing) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'No active co-driver pairing for this driver.', 404);
    }
    const coDriverId = pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId;
    const coDriver = await this.mobileRepo.findDriver(coDriverId);
    if (!coDriver) {
      throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Co-driver not found.', 404, { coDriverId });
    }

    // Verifies the co-driver's own password/status and issues THEIR token pair — never the
    // calling driver's. A wrong password is 422 CO_DRIVER_PASSWORD_INVALID (MR-22), not the
    // login 401 — the caller's own session is fine and the app must not treat it as expired.
    let tokens: AccessTokenPair;
    try {
      tokens = await this.auth.loginDriver(coDriver.username, dto.coDriverPassword, meta);
    } catch (err) {
      if (err instanceof AppException && err.code === ERROR_CODES.INVALID_CREDENTIALS) {
        throw new AppException(ERROR_CODES.CO_DRIVER_PASSWORD_INVALID, 'The co-driver password is incorrect.', 422);
      }
      throw err;
    }

    const now = new Date();
    await this.repo.switchSeats({
      pairingId: pairing.id,
      endedById: driverId,
      now,
      newPrimaryDriverId: coDriverId,
      newCoDriverId: driverId,
      vehicleId: pairing.vehicleId,
      ...(outgoing ? { revokeFamily: { driverId, familyId: outgoing.familyId } } : {}),
    });
    // D-155 — the outgoing driver's ELD session on the unit ends with their app session (4.5.1.5
    // logout, idempotent: nothing is written when no login is open, so /auth/logout afterwards never doubles it).
    if (outgoing) await this.loginRecords.logout(driverId, 'CO_DRIVER_SWITCH', { onlyVehicleId: pairing.vehicleId });
    // CODE-012 — the revoked family must stop authorising this driver's cached access on every replica.
    if (outgoing) await this.auth.evictDriverAccess(driverId);
    // D-130 — the co-driver taking the seat authenticates on the unit: §395 Appendix A 4.5.1.5
    // login (idempotent).
    await this.loginRecords.login(coDriverId, pairing.vehicleId, 'CO_DRIVER_SWITCH');

    await this.writeAudit(actor, 'CO_DRIVER_SWITCHED', driverId, {
      pairingId: pairing.id,
      newPrimaryDriverId: coDriverId,
      newCoDriverId: driverId,
    });

    await publishBootstrapChanged(this.events, driverId, 'co_driver_switched');
    await publishBootstrapChanged(this.events, coDriverId, 'co_driver_switched');

    if (dto.clientId) {
      await this.auth.stashSwitchPair(dto.coDriverPassword, `${driverId}:${dto.clientId}`, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      await this.mobileRepo.recordSyncedResult(driverId, dto.clientId, LEDGER_TYPE, now, 'ACCEPTED', null, { coDriverId, pairingId: pairing.id });
    }
    return tokens;
  }

  async leave(driverId: string, actor: ContextUser): Promise<{ ended: boolean }> {
    const pairing = await this.mobileRepo.findActivePairing(driverId);
    if (!pairing) return { ended: false };

    const now = new Date();
    await this.repo.endPairing(pairing.id, driverId, now);
    await this.repo.clearAssignedVehicle(driverId);
    await publishVehicleUnassigned(this.events, { driverId, vehicleId: pairing.vehicleId });
    await publishBootstrapChanged(this.events, pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId, 'co_driver_switched');
    // D-130 — leaving the team ends this driver's ELD session on the unit (logout record).
    await this.loginRecords.logout(driverId, 'CO_DRIVER_LEAVE', { onlyVehicleId: pairing.vehicleId });

    await this.writeAudit(actor, 'CO_DRIVER_LEFT', driverId, { pairingId: pairing.id });

    return { ended: true };
  }

  private async writeAudit(actor: ContextUser, action: string, driverId: string, after: Record<string, unknown>): Promise<void> {
    const ctx = RequestContext.get();
    try {
      await this.audit.insert({
        actorId: actor.id,
        actorType: actor.type === 'driver' ? EditorType.DRIVER : EditorType.USER,
        action,
        objectType: 'CoDriverPairing',
        objectId: driverId,
        after: after as Prisma.InputJsonValue,
        detail: 'Driver-seat handoff from the app (mobile/tz.md S-11/S-18/S-19).',
        ip: ctx?.ip,
        userAgent: ctx?.userAgent,
      });
    } catch (err) {
      this.logger.error({ err, action, driverId }, 'Failed to write the co-driver-pairing audit entry');
    }
  }
}
