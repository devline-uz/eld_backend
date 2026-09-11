import { Injectable } from '@nestjs/common';
import type { Trailer } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { CreateTrailerDto, ImportTrailersDto, UpdateTrailerDto } from './dto/vehicles.dto';
import { TrailersRepository } from './trailers.repository';
import { ImportSummary } from './vehicles.service';

/** TZ §5.3 — "Vehicles: units, VIN, trailer" deliverable. Trailers are simple enough (no
 * odometer/device) to not need a dedicated permission key; gated by `vehicles` (same as units). */
@Injectable()
export class TrailersService {
  constructor(private readonly trailers: TrailersRepository) {}

  list(): Promise<Trailer[]> {
    return this.trailers.listAll();
  }

  async get(id: string): Promise<Trailer> {
    const trailer = await this.trailers.findById({ id });
    if (!trailer) throw AppException.notFound('Trailer not found.');
    return trailer;
  }

  async create(dto: CreateTrailerDto): Promise<Trailer> {
    const existing = await this.trailers.findByNumber(dto.number);
    if (existing) throw AppException.conflict(`Trailer "${dto.number}" already exists.`);
    return this.trailers.create({ number: dto.number, vin: dto.vin });
  }

  async update(id: string, dto: UpdateTrailerDto): Promise<Trailer> {
    await this.get(id);
    return this.trailers.update(
      { id },
      {
        ...(dto.number !== undefined && { number: dto.number }),
        ...(dto.vin !== undefined && { vin: dto.vin }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    );
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.trailers.delete({ id });
  }

  async exportAll(): Promise<CreateTrailerDto[]> {
    return (await this.trailers.listAll()).map((t) => ({ number: t.number, vin: t.vin ?? undefined }));
  }

  async importMany(dto: ImportTrailersDto): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: 0, updated: 0, failed: [] };
    for (let index = 0; index < dto.trailers.length; index += 1) {
      const row = dto.trailers[index];
      try {
        const existing = await this.trailers.findByNumber(row.number);
        if (existing) {
          await this.trailers.update({ id: existing.id }, { vin: row.vin });
          summary.updated += 1;
        } else {
          await this.trailers.create({ number: row.number, vin: row.vin });
          summary.imported += 1;
        }
      } catch (err) {
        summary.failed.push({ index, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return summary;
  }
}
