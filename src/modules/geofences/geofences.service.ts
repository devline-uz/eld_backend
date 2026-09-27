import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofences.dto';
import { GeofencesRepository } from './geofences.repository';
import { geocodeAddress } from './lib/geocoder';

@Injectable()
export class GeofencesService {
  constructor(private readonly repo: GeofencesRepository, private readonly config: AppConfigService) {}

  list() {
    return this.repo.listAll().then((items) => ({ items }));
  }

  async get(id: string) {
    const fence = await this.repo.findById({ id });
    if (!fence) throw new AppException(ERROR_CODES.NOT_FOUND, 'Geofence not found.', 404);
    return fence;
  }

  /** §20 B-93 — `type: 'ADDRESS'` geocodes server-side into `centerLat/centerLon/radiusMi`
   * (stored as CIRCLE-shaped data, `address` kept for display); `radiusMeters` is an alias of
   * `radiusMi` (decisions.md). Requires `GEOCODER_URL` — otherwise `422 GEOCODER_NOT_CONFIGURED`. */
  async create(dto: CreateGeofenceDto) {
    const { radiusMeters, ...rest } = dto;
    const data = { ...rest, radiusMi: rest.radiusMi ?? radiusMeters };
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
    await this.get(id);
    const { radiusMeters, ...rest } = dto;
    const data = { ...rest, ...(radiusMeters != null && rest.radiusMi == null && { radiusMi: radiusMeters }) };
    if (dto.address && (await this.get(id)).type === 'ADDRESS') {
      const geocoderUrl = this.config.get('GEOCODER_URL');
      if (!geocoderUrl) {
        throw new AppException(ERROR_CODES.GEOCODER_NOT_CONFIGURED, 'No geocoding service is configured.', 422);
      }
      const { lat, lon } = await geocodeAddress(dto.address, geocoderUrl);
      return this.repo.update({ id }, { ...data, centerLat: lat, centerLon: lon });
    }
    return this.repo.update({ id }, data);
  }

  async remove(id: string) {
    await this.get(id);
    await this.repo.delete({ id });
    return { id, deleted: true };
  }
}
