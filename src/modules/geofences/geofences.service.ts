import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofences.dto';
import { GeofencesRepository, GeofenceWithGroup } from './geofences.repository';
import { geocodeAddress } from './lib/geocoder';

@Injectable()
export class GeofencesService {
  constructor(private readonly repo: GeofencesRepository, private readonly config: AppConfigService) {}

  list() {
    return this.repo.listAll().then((items) => ({ items: items.map(toView) }));
  }

  async get(id: string) {
    const fence = await this.repo.findWithGroup(id);
    if (!fence) throw new AppException(ERROR_CODES.NOT_FOUND, 'Geofence not found.', 404);
    return toView(fence);
  }

  /** §20 B-93 — `type: 'ADDRESS'` geocodes server-side into `centerLat/centerLon/radiusMi`
   * (stored as CIRCLE-shaped data, `address` kept for display); `radiusMeters` is an alias of
   * `radiusMi` (decisions.md). Requires `GEOCODER_URL` — otherwise `422 GEOCODER_NOT_CONFIGURED`. */
  async create(dto: CreateGeofenceDto) {
    const { radiusMeters, vehicleGroupId, ...rest } = dto;
    await this.assertGroupExists(vehicleGroupId);
    const data = {
      ...rest,
      radiusMi: rest.radiusMi ?? radiusMeters,
      ...(vehicleGroupId && { vehicleGroup: { connect: { id: vehicleGroupId } } }),
    };
    if (data.type === 'ADDRESS') {
      const geocoderUrl = this.config.get('GEOCODER_URL');
      if (!geocoderUrl) {
        throw new AppException(ERROR_CODES.GEOCODER_NOT_CONFIGURED, 'No geocoding service is configured.', 422);
      }
      const { lat, lon } = await geocodeAddress(data.address as string, geocoderUrl);
      return this.repo.create({ ...data, centerLat: lat, centerLon: lon });
    }
    return this.repo.create(data);
  }

  async update(id: string, dto: UpdateGeofenceDto) {
    const existing = await this.get(id);
    const { radiusMeters, vehicleGroupId, ...rest } = dto;
    await this.assertGroupExists(vehicleGroupId);
    const data = {
      ...rest,
      ...(radiusMeters != null && rest.radiusMi == null && { radiusMi: radiusMeters }),
      ...(vehicleGroupId !== undefined && {
        vehicleGroup: vehicleGroupId === null ? { disconnect: true } : { connect: { id: vehicleGroupId } },
      }),
    };
    if (dto.address && existing.type === 'ADDRESS') {
      const geocoderUrl = this.config.get('GEOCODER_URL');
      if (!geocoderUrl) {
        throw new AppException(ERROR_CODES.GEOCODER_NOT_CONFIGURED, 'No geocoding service is configured.', 422);
      }
      const { lat, lon } = await geocodeAddress(dto.address, geocoderUrl);
      return this.repo.update({ id }, { ...data, centerLat: lat, centerLon: lon });
    }
    return this.repo.update({ id }, data);
  }

  /** §20 B-104 — the app is single-carrier (no `carrierId` column, tz §27.3), so "same
   * tenant" reduces to "the group exists"; an unknown id is a 404 like `PATCH /vehicles`. */
  private async assertGroupExists(groupId: string | null | undefined): Promise<void> {
    if (!groupId) return;
    if (!(await this.repo.groupExists(groupId))) {
      throw new AppException(ERROR_CODES.VEHICLE_GROUP_NOT_FOUND, 'Vehicle group not found.', 404);
    }
  }

  async remove(id: string) {
    await this.get(id);
    await this.repo.delete({ id });
    return { id, deleted: true };
  }
}

/** §20 B-104 — flattens the joined group into `vehicleGroupName` (null = all groups). */
function toView({ vehicleGroup, ...fence }: GeofenceWithGroup) {
  return { ...fence, vehicleGroupName: vehicleGroup?.name ?? null };
}
