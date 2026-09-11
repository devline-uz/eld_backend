import { Injectable } from '@nestjs/common';
import type { Dvir } from '@prisma/client';
import { OffsetPage, parseSort, toOffsetPage } from '../../common/dto/list-query.dto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { DvirAdminRepository } from './dvir-admin.repository';
import { DvirListQueryDto, MechanicSignOffDto, NextDriverReviewDto } from './dto/service.dto';

const SORTABLE_FIELDS = ['submittedAt', 'repairStatus', 'createdAt'] as const;

/** TZ §5.10 / §396.13 — web read of DVIRs plus the mechanic sign-off + next-driver-review
 * steps that complete the paper trail the driver app submission starts. */
@Injectable()
export class DvirAdminService {
  constructor(private readonly repo: DvirAdminRepository) {}

  async list(query: DvirListQueryDto): Promise<OffsetPage<Dvir>> {
    const orderBy = parseSort(query.sort, SORTABLE_FIELDS, { submittedAt: 'desc' });
    const { items, total } = await this.repo.list(
      { vehicleId: query.vehicleId, driverId: query.driverId, repairStatus: query.repairStatus },
      query.page,
      query.limit,
      orderBy,
    );
    return toOffsetPage(items, total, query.page, query.limit);
  }

  async get(id: string) {
    const dvir = await this.repo.findWithDefects(id);
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return dvir;
  }

  private async getOrThrow(id: string): Promise<Dvir> {
    const dvir = await this.repo.findById({ id });
    if (!dvir) throw new AppException(ERROR_CODES.DVIR_NOT_FOUND, 'DVIR not found.', 404, { id });
    return dvir;
  }

  async mechanicSignOff(id: string, dto: MechanicSignOffDto): Promise<Dvir> {
    await this.getOrThrow(id);
    return this.repo.update(
      { id },
      { mechanicName: dto.mechanicName, mechanicNote: dto.mechanicNote ?? null, mechanicSignedAt: new Date(), repairStatus: dto.repairStatus },
    );
  }

  async nextDriverReview(id: string, dto: NextDriverReviewDto): Promise<Dvir> {
    await this.getOrThrow(id);
    return this.repo.update({ id }, { nextDriverReviewedAt: dto.reviewedAt ? new Date(dto.reviewedAt) : new Date() });
  }
}
