import { Injectable } from '@nestjs/common';
import { RequestContext } from '../context/request-context';
import { PrismaService } from './prisma.service';

/**
 * Minimal structural shape of a generated Prisma model delegate. Declared here rather
 * than imported so this file compiles before `prisma generate` has ever run.
 */
export interface ModelDelegate<TModel, TWhere, TWhereUnique, TCreate, TUpdate> {
  findUnique(args: { where: TWhereUnique }): Promise<TModel | null>;
  findFirst(args?: { where?: TWhere }): Promise<TModel | null>;
  findMany(args?: {
    where?: TWhere;
    take?: number;
    skip?: number;
    cursor?: TWhereUnique;
    orderBy?: unknown;
  }): Promise<TModel[]>;
  create(args: { data: TCreate }): Promise<TModel>;
  update(args: { where: TWhereUnique; data: TUpdate }): Promise<TModel>;
  delete(args: { where: TWhereUnique }): Promise<TModel>;
  count(args?: { where?: TWhere }): Promise<number>;
}

export interface CursorPage<TModel> {
  items: TModel[];
  /** Opaque cursor for the next page, or null at the end (TZ §19 — cursor pagination). */
  nextCursor: string | null;
}

/**
 * TZ §27.1 point 1 — EVERY database call goes through BaseRepository.
 *
 * When the product becomes multi-tenant, `scopeWhere()` is the one place that gains the
 * `carrierId` filter (~50 lines, per TZ §27.2). Until then it is an identity function and
 * no table carries a `carrierId` column (TZ §27.3).
 */
@Injectable()
export abstract class BaseRepository<
  TModel,
  TWhere extends object = Record<string, unknown>,
  TWhereUnique extends object = { id: string },
  TCreate extends object = Record<string, unknown>,
  TUpdate extends object = Record<string, unknown>,
> {
  protected constructor(protected readonly prisma: PrismaService) {}

  /** The generated delegate for this repository's model, e.g. `this.prisma.driver`. */
  protected abstract get model(): ModelDelegate<TModel, TWhere, TWhereUnique, TCreate, TUpdate>;

  /** Tenant scoping hook. Identity today; the SaaS migration adds `carrierId` here. */
  protected scopeWhere(where?: TWhere): TWhere | undefined {
    return where;
  }

  /** Carrier of the current request, when one is bound (TZ §27.1 point 3). */
  protected get carrierId(): string | undefined {
    return RequestContext.carrierId;
  }

  findById(id: TWhereUnique): Promise<TModel | null> {
    return this.model.findUnique({ where: id });
  }

  findOne(where: TWhere): Promise<TModel | null> {
    return this.model.findFirst({ where: this.scopeWhere(where) });
  }

  findMany(where?: TWhere, take?: number, orderBy?: unknown): Promise<TModel[]> {
    return this.model.findMany({ where: this.scopeWhere(where), take, orderBy });
  }

  count(where?: TWhere): Promise<number> {
    return this.model.count({ where: this.scopeWhere(where) });
  }

  create(data: TCreate): Promise<TModel> {
    return this.model.create({ data });
  }

  update(where: TWhereUnique, data: TUpdate): Promise<TModel> {
    return this.model.update({ where, data });
  }

  delete(where: TWhereUnique): Promise<TModel> {
    return this.model.delete({ where });
  }

  /**
   * Cursor pagination (TZ §19). `cursorField` defaults to `id`; the returned cursor is the
   * value of that field on the last row.
   */
  async paginate(
    where: TWhere | undefined,
    limit: number,
    cursor?: string,
    orderBy?: unknown,
    cursorField: string = 'id',
  ): Promise<CursorPage<TModel>> {
    const items = await this.model.findMany({
      where: this.scopeWhere(where),
      take: limit + 1,
      skip: cursor ? 1 : 0,
      cursor: cursor ? ({ [cursorField]: cursor } as unknown as TWhereUnique) : undefined,
      orderBy,
    });
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page.at(-1) as Record<string, unknown> | undefined;
    return {
      items: page,
      nextCursor: hasMore && last ? String(last[cursorField]) : null,
    };
  }
}
