import { Injectable } from '@nestjs/common';
import type { CoDriverPairing } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { OffsetPage, toOffsetPage } from '../../common/dto/list-query.dto';
import { DriversRepository } from '../drivers/drivers.repository';
import { VehiclesRepository } from '../vehicles/vehicles.repository';
import { CoDriverPairingListQueryDto, CreateCoDriverPairingDto } from './dto/co-driver-pairings.dto';
import { CoDriverPairingsRepository } from './co-driver-pairings.repository';

/** TZ §5.3 hard rule — co-driver relationships are time-bounded `CoDriverPairing` rows, never
 * a plain column on `Driver` (team-driving HOS needs the full pairing history). */
@Injectable()
export class CoDriverPairingsService {
  constructor(
    private readonly pairings: CoDriverPairingsRepository,
    private readonly drivers: DriversRepository,
    private readonly vehicles: VehiclesRepository,
  ) {}

  async list(query: CoDriverPairingListQueryDto): Promise<OffsetPage<CoDriverPairing>> {
    const { items, total } = await this.pairings.list(
      { vehicleId: query.vehicleId, driverId: query.driverId, active: query.active },
      query.page,
      query.limit,
    );
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async create(dto: CreateCoDriverPairingDto, startedById: string | undefined): Promise<CoDriverPairing> {
    if (dto.primaryDriverId === dto.coDriverId) {
      throw AppException.conflict('A driver cannot be paired with themselves.');
    }
    const [primary, coDriver, vehicle] = await Promise.all([
      this.drivers.findById({ id: dto.primaryDriverId }),
      this.drivers.findById({ id: dto.coDriverId }),
      this.vehicles.findById({ id: dto.vehicleId }),
    ]);
    if (!primary || !coDriver) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    if (!vehicle) throw new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404);

    const existing = await this.pairings.findActiveForCoDriver(dto.coDriverId, dto.vehicleId);
    if (existing) throw AppException.conflict('This co-driver already has an active pairing on this unit.');

    return this.pairings.create({
      primaryDriver: { connect: { id: dto.primaryDriverId } },
      coDriver: { connect: { id: dto.coDriverId } },
      vehicle: { connect: { id: dto.vehicleId } },
      startedAt: dto.startedAt ?? new Date(),
      ...(startedById && { startedById }),
    });
  }

  async end(id: string, endedById: string | undefined): Promise<CoDriverPairing> {
    const pairing = await this.pairings.findById(id);
    if (!pairing) throw new AppException(ERROR_CODES.CO_DRIVER_PAIRING_NOT_FOUND, 'Co-driver pairing not found.', 404);
    if (pairing.endedAt) throw AppException.conflict('This pairing has already ended.');
    return this.pairings.end(id, endedById, new Date());
  }
}
