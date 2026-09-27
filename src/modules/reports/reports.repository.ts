import { Injectable } from '@nestjs/common';
import type { Prisma, Report, ReportSchedule } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';

/** TZ §15/§11.6 — `Report` rows (job status/params/file reference). */
@Injectable()
export class ReportsRepository extends BaseRepository<
  Report,
  Prisma.ReportWhereInput,
  Prisma.ReportWhereUniqueInput,
  Prisma.ReportUncheckedCreateInput,
  Prisma.ReportUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    Report,
    Prisma.ReportWhereInput,
    Prisma.ReportWhereUniqueInput,
    Prisma.ReportUncheckedCreateInput,
    Prisma.ReportUpdateInput
  > {
    return this.prisma.report;
  }

  async list(where: Prisma.ReportWhereInput, page: number, limit: number) {
    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { requestedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: REQUESTED_BY_INCLUDE,
      }),
      this.prisma.report.count({ where }),
    ]);
    return { items, total };
  }

  /** B-46 — `requestedBy: { id, name }` on read (`Report.requestedBy` is a real `User`
   * relation, unlike `DataTransfer.requestedById`, see decisions.md D-092). */
  findByIdWithRequestedBy(id: string) {
    return this.prisma.report.findUnique({ where: { id }, include: REQUESTED_BY_INCLUDE });
  }
}

const REQUESTED_BY_INCLUDE = {
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.ReportInclude;

/** `ReportSchedule` rows — cron-like definitions the report scheduler consumes (TZ §15). */
@Injectable()
export class ReportSchedulesRepository extends BaseRepository<
  ReportSchedule,
  Prisma.ReportScheduleWhereInput,
  Prisma.ReportScheduleWhereUniqueInput,
  Prisma.ReportScheduleCreateInput,
  Prisma.ReportScheduleUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get model(): ModelDelegate<
    ReportSchedule,
    Prisma.ReportScheduleWhereInput,
    Prisma.ReportScheduleWhereUniqueInput,
    Prisma.ReportScheduleCreateInput,
    Prisma.ReportScheduleUpdateInput
  > {
    return this.prisma.reportSchedule;
  }

  listAll(): Promise<ReportSchedule[]> {
    return this.prisma.reportSchedule.findMany({ orderBy: { id: 'asc' } });
  }

  dueSchedules(now: Date): Promise<ReportSchedule[]> {
    return this.prisma.reportSchedule.findMany({
      where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
    });
  }
}
