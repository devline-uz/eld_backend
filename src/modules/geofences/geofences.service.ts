import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { CreateGeofenceDto, UpdateGeofenceDto } from './dto/geofences.dto';
import { GeofencesRepository } from './geofences.repository';

@Injectable()
export class GeofencesService {
  constructor(private readonly repo: GeofencesRepository) {}

  list() {
    return this.repo.listAll().then((items) => ({ items }));
  }

  async get(id: string) {
    const fence = await this.repo.findById({ id });
    if (!fence) throw new AppException(ERROR_CODES.NOT_FOUND, 'Geofence not found.', 404);
    return fence;
  }

  create(dto: CreateGeofenceDto) {
    return this.repo.create(dto as Prisma.GeofenceCreateInput);
  }

  async update(id: string, dto: UpdateGeofenceDto) {
    await this.get(id);
    return this.repo.update({ id }, dto as Prisma.GeofenceUpdateInput);
  }

  async remove(id: string) {
    await this.get(id);
    await this.repo.delete({ id });
    return { id, deleted: true };
  }
}
