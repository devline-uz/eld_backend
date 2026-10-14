import { Injectable } from '@nestjs/common';
import type { AdverseDrivingInvocation, Driver, DriverDocument, Prisma } from '@prisma/client';
import { BaseRepository, ModelDelegate } from '../../core/prisma/base.repository';
import { PrismaService } from '../../core/prisma/prisma.service';
import { findAdverseInvokedToday } from './lib/adverse-driving';
import { emailEqualsInsensitive } from '../../common/email/email-lookup';
import { containsInsensitive, equalsInsensitive } from '../../common/text/insensitive';

export interface DriverListFilter {
  status?: Driver['status'];
  q?: string;
}

export interface DriverRosterFilter extends DriverListFilter {
  terminal?: string;
  hasOpenViolation?: boolean;
  exempt?: boolean;
  /**
   * UI-015 — the `ActiveViolationsService.refresh` exclusions (rows a STALE status filed after its
   * cap), so `hasOpenViolation` matches the roster's `openViolations` counts.
   */
  violationExclude?: Prisma.HosViolationWhereInput[];
}

/** UI-015 — the active-violation relation filter: OPEN rows minus the stale-cap exclusions. */
function activeViolationWhere(exclude: Prisma.HosViolationWhereInput[] = []): Prisma.HosViolationWhereInput {
  return exclude.length === 0 ? { status: 'OPEN' } : { AND: [{ status: 'OPEN' }, ...exclude] };
}

export type DriverWithUnit = Driver & { assignedVehicle: { id: string; unitNumber: string } | null };

export interface DriverListPage {
  items: Driver[];
  total: number;
}

type TextSortField = 'username' | 'firstName' | 'lastName' | 'cdlNumber' | 'homeTerminalName';
const TEXT_SORT_FIELDS: ReadonlySet<string> = new Set<TextSortField>(['username', 'firstName', 'lastName', 'cdlNumber', 'homeTerminalName']);
const TEXT_SORT_SELECT = { username: true, firstName: true, lastName: true, cdlNumber: true, homeTerminalName: true } as const;
type RosterSortKey = { id: string } & Record<TextSortField, string | null>;

const nameCollator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * LIVE-023 — case-insensitive, number-aware roster order (`test2` before `test10`). A name sort
 * breaks ties on the other name part, then username, then id, so pages never shuffle between
 * requests; empty values sort last in either direction.
 */
export function sortRosterKeys<T extends RosterSortKey>(keys: T[], field: TextSortField, direction: 'asc' | 'desc'): T[] {
  const tieBreak: TextSortField[] =
    field === 'lastName' ? ['firstName', 'username'] : field === 'firstName' ? ['lastName', 'username'] : ['lastName', 'firstName', 'username'];
  const sign = direction === 'desc' ? -1 : 1;
  const compareField = (a: T, b: T, f: TextSortField): number => {
    const left = (a[f] ?? '').trim();
    const right = (b[f] ?? '').trim();
    if (!left || !right) return left === right ? 0 : left ? -1 : 1;
    return nameCollator.compare(left, right);
  };
  return [...keys].sort((a, b) => {
    const primary = compareField(a, b, field);
    if (primary !== 0) return (a[field] ?? '').trim() && (b[field] ?? '').trim() ? primary * sign : primary;
    for (const f of tieBreak) {
      const c = compareField(a, b, f);
      if (c !== 0) return c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

@Injectable()
export class DriversRepository extends BaseRepository<
  Driver,
  Prisma.DriverWhereInput,
  Prisma.DriverWhereUniqueInput,
  Prisma.DriverCreateInput,
  Prisma.DriverUpdateInput
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** The carrier (office) time zone — the zone alert text is written in for the web bell. */
  async carrierTimezone(): Promise<string | null> {
    const carrier = await this.prisma.carrier.findFirst({ select: { timezone: true } });
    return carrier?.timezone ?? null;
  }

  protected get model(): ModelDelegate<
    Driver,
    Prisma.DriverWhereInput,
    Prisma.DriverWhereUniqueInput,
    Prisma.DriverCreateInput,
    Prisma.DriverUpdateInput
  > {
    return this.prisma.driver;
  }

  /** Live (not soft-deleted) driver only — `username` is unique among live rows via a partial
   * unique index (migration 20260927090000_soft_delete_partial_uniques), so a deleted driver's
   * username is free for reuse. */
  findByUsername(username: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { username, deletedAt: null } });
  }

  /** §20 B-29/B-30 — `Driver.email` is unique among live rows (partial unique index); checked
   * pre-write so a collision surfaces as a clean 409 instead of an unhandled `P2002`. Emails are
   * stored lower-cased (B-100); the lookup is case-insensitive for legacy rows. */
  findByEmail(email: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { email: emailEqualsInsensitive(email), deletedAt: null } });
  }

  /**
   * B-100 — another LIVE driver whose phone has the same comparison key (`phoneKey` in
   * `lib/driver-uniques.ts`), computed in SQL exactly like the partial unique index
   * `Driver_phone_live_key`.
   */
  async findLiveIdByPhoneKey(key: string, exceptDriverId?: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Driver"
      WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL
        AND (CASE
               WHEN length(regexp_replace("phone", '\\D', '', 'g')) = 11 AND left(regexp_replace("phone", '\\D', '', 'g'), 1) = '1'
                 THEN substr(regexp_replace("phone", '\\D', '', 'g'), 2)
               ELSE regexp_replace("phone", '\\D', '', 'g')
             END) = ${key}
        AND "id" <> ${exceptDriverId ?? ''}
      LIMIT 1`;
    return rows[0]?.id ?? null;
  }

  /** B-100 — another LIVE driver with the same licence-number key (`cdlKey`), like the partial
   * unique index `Driver_cdlNumber_live_key`. */
  async findLiveIdByCdlKey(key: string, exceptDriverId?: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Driver"
      WHERE "deletedAt" IS NULL
        AND upper(regexp_replace("cdlNumber", '[\\s-]', '', 'g')) = ${key}
        AND "id" <> ${exceptDriverId ?? ''}
      LIMIT 1`;
    return rows[0]?.id ?? null;
  }

  /** B-100 — the unit a create wants to assign, with its current live driver (if any). Queried
   * against `Vehicle` directly: `VehiclesModule` depends on `DriversModule`, never the reverse. */
  findVehicleForAssignment(vehicleId: string) {
    return this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, status: true, deletedAt: true, driver: { select: { id: true, deletedAt: true } } },
    });
  }

  /** BE-010 — `fleetManagerId` must name an existing panel user (else the FK/connect is a 500). */
  async fleetManagerExists(userId: string): Promise<boolean> {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } })) !== null;
  }

  /** BE-013 — unfinished trips (draft → in progress) that still point at this driver. */
  findOpenTrips(
    driverId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Array<{ id: string; number: string; status: string }>> {
    return db.trip.findMany({
      where: { driverId, status: { in: ['DRAFT', 'PLANNED', 'ASSIGNED', 'IN_PROGRESS'] } },
      select: { id: true, number: true, status: true },
      orderBy: { plannedStartAt: 'asc' },
      take: 20,
    });
  }

  /**
   * CODE-062 — `DELETE /drivers/:id` under the same per-driver advisory lock trip writes take
   * (`TripsRepository.withDriverScheduleLock`, key `trip-driver:<id>`): a trip being created for
   * this driver either commits first (and the re-check below sees it → caller answers 409) or
   * waits until the driver is gone. Returns the open trips instead of deleting when there are any.
   */
  softDeleteUnlessOnTrip(
    id: string,
  ): Promise<{ deleted: Driver; openTrips?: never } | { deleted?: never; openTrips: Array<{ id: string; number: string; status: string }> }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, `trip-driver:${id}`);
      const openTrips = await this.findOpenTrips(id, tx);
      if (openTrips.length > 0) return { openTrips };
      const deleted = await tx.driver.update({
        where: { id },
        data: { status: 'TERMINATED', deletedAt: new Date(), assignedVehicle: { disconnect: true } },
      });
      return { deleted };
    });
  }

  /**
   * B-100 — creates the driver and assigns the unit in ONE transaction. The assignment is a
   * scalar `assignedVehicleId` write, not a relation `connect`: Prisma's `connect` on this 1:1
   * would silently take the unit from its current driver ("steal" semantics, see
   * test/integration/fleet-crud.spec.ts), while the scalar write hits `Driver_assignedVehicleId_key`
   * (`P2002`) and rolls the whole create back.
   */
  createWithVehicle(data: Prisma.DriverCreateInput, vehicleId: string): Promise<Driver> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.driver.create({ data });
      await tx.driver.updateMany({ where: { id: created.id }, data: { assignedVehicleId: vehicleId } });
      return { ...created, assignedVehicleId: vehicleId };
    });
  }

  async list(
    filter: DriverListFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<DriverListPage> {
    const where: Prisma.DriverWhereInput = {
      deletedAt: null,
      ...(filter.status && { status: filter.status }),
      ...(filter.q && {
        OR: [
          { username: containsInsensitive(filter.q) },
          { firstName: containsInsensitive(filter.q) },
          { lastName: containsInsensitive(filter.q) },
          { cdlNumber: containsInsensitive(filter.q) },
          { email: containsInsensitive(filter.q) },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
      this.prisma.driver.count({ where }),
    ]);
    return { items, total };
  }

  /** `GET /drivers/roster` — the driver page plus its assigned unit, with the B-55 filters. */
  async listRoster(
    filter: DriverRosterFilter,
    page: number,
    limit: number,
    orderBy: Record<string, 'asc' | 'desc'>,
  ): Promise<{ items: DriverWithUnit[]; total: number }> {
    const where: Prisma.DriverWhereInput = {
      deletedAt: null,
      ...(filter.status && { status: filter.status }),
      ...(filter.terminal && { homeTerminalName: equalsInsensitive(filter.terminal) }),
      ...(filter.exempt !== undefined && { eldExempt: filter.exempt }),
      ...(filter.hasOpenViolation === true && { violations: { some: activeViolationWhere(filter.violationExclude) } }),
      ...(filter.hasOpenViolation === false && { violations: { none: activeViolationWhere(filter.violationExclude) } }),
      ...(filter.q && {
        OR: [
          { username: containsInsensitive(filter.q) },
          { firstName: containsInsensitive(filter.q) },
          { lastName: containsInsensitive(filter.q) },
          { cdlNumber: containsInsensitive(filter.q) },
          { email: containsInsensitive(filter.q) },
        ],
      }),
    };
    const scoped = this.scopeWhere(where);
    const include = { assignedVehicle: { select: { id: true, unitNumber: true } } } as const;
    const [field, direction] = Object.entries(orderBy)[0] ?? [];
    if (field && TEXT_SORT_FIELDS.has(field)) {
      // LIVE-023 — the database sorts text by byte ("Young" < "co-driver test"), so a name sort
      // runs on the matching ids in code with a case-insensitive collator, then loads one page.
      const keys = await this.prisma.driver.findMany({ where: scoped, select: { id: true, ...TEXT_SORT_SELECT } });
      const ordered = sortRosterKeys(keys, field as TextSortField, direction === 'desc' ? 'desc' : 'asc');
      const pageIds = ordered.slice((page - 1) * limit, page * limit).map((k) => k.id);
      const rows = await this.prisma.driver.findMany({ where: { id: { in: pageIds } }, include });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return { items: pageIds.map((id) => byId.get(id)).filter((r): r is DriverWithUnit => r !== undefined), total: keys.length };
    }
    const [items, total] = await Promise.all([
      this.prisma.driver.findMany({
        where: scoped,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include,
      }),
      this.prisma.driver.count({ where: scoped }),
    ]);
    return { items, total };
  }

  /**
   * UI-015 — roster header counts over every live driver in scope, whatever the current
   * filter / search / page: `total` drivers and how many have an ACTIVE violation (same
   * definition as the `hasOpenViolation` segment).
   */
  async rosterSummary(violationExclude: Prisma.HosViolationWhereInput[] = []): Promise<{ total: number; withActiveViolations: number }> {
    const [total, withActiveViolations] = await Promise.all([
      this.prisma.driver.count({ where: this.scopeWhere({ deletedAt: null }) }),
      this.prisma.driver.count({ where: this.scopeWhere({ deletedAt: null, violations: { some: activeViolationWhere(violationExclude) } }) }),
    ]);
    return { total, withActiveViolations };
  }

  /** OPEN `HosViolation` rows per driver (AUTO_CLEARED / RESOLVED are not open). */
  async countOpenViolations(driverIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (driverIds.length === 0) return counts;
    const rows = await this.prisma.hosViolation.groupBy({
      by: ['driverId'],
      where: { driverId: { in: driverIds }, status: 'OPEN' },
      _count: { _all: true },
    });
    for (const row of rows) counts.set(row.driverId, row._count._all);
    return counts;
  }

  listAll(): Promise<Driver[]> {
    return this.prisma.driver.findMany({ where: { deletedAt: null }, orderBy: { username: 'asc' } });
  }

  // -------------------------------------------------------------------
  // §20 B-94 (tz.md §20 B-16) — driver qualification documents.
  // -------------------------------------------------------------------

  listDocuments(driverId: string): Promise<DriverDocument[]> {
    return this.prisma.driverDocument.findMany({ where: { driverId }, orderBy: { createdAt: 'desc' } });
  }

  findDocument(id: string): Promise<DriverDocument | null> {
    return this.prisma.driverDocument.findUnique({ where: { id } });
  }

  createDocument(data: Prisma.DriverDocumentCreateInput): Promise<DriverDocument> {
    return this.prisma.driverDocument.create({ data });
  }

  deleteDocument(id: string): Promise<DriverDocument> {
    return this.prisma.driverDocument.delete({ where: { id } });
  }

  /** BUG-001 — ids of the permitted drivers with adverse driving invoked for their current RODS day. */
  findAdverseInvokedToday(drivers: Array<Pick<Driver, 'id' | 'homeTerminalTimezone' | 'adverseDrivingEnabled'>>, now: Date): Promise<Set<string>> {
    return findAdverseInvokedToday(this.prisma, drivers, now);
  }

  /** BUG-001 — one invocation per (driver, RODS day); re-invoking replaces the annotation. */
  upsertAdverseInvocation(data: { driverId: string; logDate: Date; annotation: string; invokedById: string | null; invokedByType: string }): Promise<AdverseDrivingInvocation> {
    const { driverId, logDate, ...rest } = data;
    return this.prisma.adverseDrivingInvocation.upsert({
      where: { driverId_logDate: { driverId, logDate } },
      create: data,
      update: rest,
    });
  }

  /** Driver email change — another LIVE driver with a still-valid (requested after `since`)
   * pending change to this address, so two drivers can't race to claim the same email. */
  async findLiveIdByPendingEmail(email: string, since: Date, exceptDriverId?: string): Promise<string | null> {
    const row = await this.prisma.driver.findFirst({
      where: {
        deletedAt: null,
        pendingEmail: emailEqualsInsensitive(email),
        pendingEmailRequestedAt: { gt: since },
        ...(exceptDriverId && { id: { not: exceptDriverId } }),
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** Driver email change — a compare-and-set write: applies `data` only while the driver is live
   * and still in the state `expect` describes (same pending request / same current email), so
   * two clicks of the same link, or a link racing a cancel, can never both win. */
  async updateIfState(id: string, expect: Prisma.DriverWhereInput, data: Prisma.DriverUpdateManyMutationInput): Promise<boolean> {
    const res = await this.prisma.driver.updateMany({ where: { id, deletedAt: null, ...expect }, data });
    return res.count > 0;
  }

  /** Driver disable — ends every open co-driver pairing the driver is part of (either side). */
  async endActivePairings(driverId: string, endedById: string | undefined): Promise<number> {
    const result = await this.prisma.coDriverPairing.updateMany({
      where: { endedAt: null, OR: [{ primaryDriverId: driverId }, { coDriverId: driverId }] },
      data: { endedAt: new Date(), ...(endedById && { endedById }) },
    });
    return result.count;
  }

  /** B-094 — revokes every live `DriverSession` (refresh token) of one driver. */
  async revokeAllSessions(driverId: string): Promise<number> {
    const result = await this.prisma.driverSession.updateMany({
      where: { driverId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }
}
