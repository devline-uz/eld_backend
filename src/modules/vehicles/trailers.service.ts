import { Injectable } from '@nestjs/common';
import type { Trailer } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { CreateTrailerDto, ImportTrailersDto, TrailerListQueryDto, TrailerListSortFields, UpdateTrailerDto } from './dto/vehicles.dto';
import { TrailersRepository } from './trailers.repository';
import { ImportSummary } from './vehicles.service';

/** Prisma unique-constraint violation (`P2002`) — the live-row partial unique index
 * `Trailer_number_live_key` rejecting a write that raced the pre-check. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

const numberTaken = (number: string): AppException => AppException.conflict(`Trailer "${number}" already exists.`, { number });

/** TZ §5.3 — "Vehicles: units, VIN, trailer" deliverable. Trailers are simple enough (no
 * odometer/device) to not need a dedicated permission key; gated by `vehicles` (same as units).
 *
 * Deletes are SOFT (`deletedAt`): a deleted trailer disappears from list / lookup / export, frees
 * its number for a new trailer, and can no longer be put on trips or DVIRs — but its row stays so
 * historical DVIRs and trips referencing it still resolve. */
@Injectable()
export class TrailersService {
  constructor(private readonly trailers: TrailersRepository) {}

  async list(query: TrailerListQueryDto): Promise<OffsetPage<Trailer>> {
    const orderBy = parseSort(query.sort, TrailerListSortFields, { number: 'asc' });
    const { items, total } = await this.trailers.list({ q: query.q, status: query.status }, query.page, query.limit, orderBy);
    return toOffsetPage(items, total, query.page, query.limit);
  }

  /** Live trailers only — a soft-deleted trailer is a 404, like a soft-deleted vehicle. */
  async get(id: string): Promise<Trailer> {
    const trailer = await this.trailers.findById({ id });
    if (!trailer || trailer.deletedAt) throw AppException.notFound('Trailer not found.');
    return trailer;
  }

  async create(dto: CreateTrailerDto): Promise<Trailer> {
    if (await this.trailers.findByNumber(dto.number)) throw numberTaken(dto.number);
    try {
      return await this.trailers.create({ number: dto.number, vin: dto.vin });
    } catch (err) {
      if (isUniqueViolation(err)) throw numberTaken(dto.number);
      throw err;
    }
  }

  async update(id: string, dto: UpdateTrailerDto): Promise<Trailer> {
    const current = await this.get(id);
    if (dto.number !== undefined && dto.number !== current.number) {
      const clash = await this.trailers.findByNumber(dto.number);
      if (clash && clash.id !== id) throw numberTaken(dto.number);
    }
    try {
      return await this.trailers.update(
        { id },
        {
          ...(dto.number !== undefined && { number: dto.number }),
          ...(dto.vin !== undefined && { vin: dto.vin }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      );
    } catch (err) {
      if (isUniqueViolation(err) && dto.number !== undefined) throw numberTaken(dto.number);
      throw err;
    }
  }

  /** Soft delete — never a hard `DELETE` (DVIRs hold an FK to the trailer and trips keep its id).
   * Mirrors `VehiclesService.remove`: status flips to INACTIVE and `deletedAt` is stamped. A second
   * delete of the same trailer is a 404. */
  async remove(id: string): Promise<Trailer> {
    await this.get(id);
    return this.trailers.update({ id }, { status: 'INACTIVE', deletedAt: new Date() });
  }

  async exportAll(): Promise<CreateTrailerDto[]> {
    return (await this.trailers.listAll()).map((t) => ({ number: t.number, vin: t.vin ?? undefined }));
  }

  /** Upserts by `number` against LIVE trailers only — a row whose number belongs only to a
   * soft-deleted trailer creates a new trailer (the deleted one is left untouched). */
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
