import { Injectable } from '@nestjs/common';
import type { ContextUser } from '../../core/context/request-context';
import { SearchRepository } from './search.repository';

export interface SearchDriverHit {
  id: string;
  name: string;
  unitNumber: string | null;
  dutyStatus: null;
  openViolations: number | null;
  openWarnings: null;
  homeTerminalName: string | null;
}

export interface SearchVehicleHit {
  id: string;
  unitNumber: string;
  make: string | null;
  model: string | null;
  vin: string;
  driverName: string | null;
}

export interface GlobalSearchResult {
  q: string;
  drivers: SearchDriverHit[];
  vehicles: SearchVehicleHit[];
}

/** §20 B-10 `GET /search?q=&limit=` — the 11.28 command-palette entity search. Splits one `q`
 * across `Driver` and `Vehicle` in parallel; `dutyStatus`/`openWarnings` are left `null` rather
 * than fabricated (no cheap, correct source for either without a per-row join — see
 * decisions.md), matching the "truthful, not guessed" rule the web client already follows for
 * these same fields. */
@Injectable()
export class SearchService {
  constructor(private readonly repo: SearchRepository) {}

  /** Each section is only searched when the caller holds READ on it (B-090): `drivers` for
   * driver hits, `vehicles` for vehicle hits, `hos` for the open-violation count. A section
   * the caller may not read comes back empty/`null` — never queried, never leaked. */
  async search(q: string, limit: number, actor: Pick<ContextUser, 'permissions'> | undefined): Promise<GlobalSearchResult> {
    const canRead = (key: string) => (actor?.permissions?.[key] ?? 'NONE') !== 'NONE';
    const [driverRows, vehicleRows] = await Promise.all([
      canRead('drivers') ? this.repo.findDrivers(q, limit) : Promise.resolve([]),
      canRead('vehicles') ? this.repo.findVehicles(q, limit) : Promise.resolve([]),
    ]);
    const violationCounts =
      canRead('hos') && driverRows.length ? await this.repo.openViolationCounts(driverRows.map((d) => d.id)) : null;

    const drivers: SearchDriverHit[] = driverRows.map((d) => ({
      id: d.id,
      name: `${d.firstName} ${d.lastName}`.trim() || d.username,
      unitNumber: d.assignedVehicle?.unitNumber ?? null,
      dutyStatus: null,
      openViolations: violationCounts ? violationCounts.get(d.id) ?? 0 : null,
      openWarnings: null,
      homeTerminalName: d.homeTerminalName ?? null,
    }));
    const vehicles: SearchVehicleHit[] = vehicleRows.map((v) => ({
      id: v.id,
      unitNumber: v.unitNumber,
      make: v.make,
      model: v.model,
      vin: v.vin,
      driverName: v.driver && canRead('drivers') ? `${v.driver.firstName} ${v.driver.lastName}`.trim() : null,
    }));

    return { q, drivers, vehicles };
  }
}
