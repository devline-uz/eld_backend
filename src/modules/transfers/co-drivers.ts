/**
 * Appendix A 4.8.2.1.1 line 2 / 4.8.2.1.2 — the co-driver(s) of the eRODS file, from the
 * time-bounded `CoDriverPairing` rows (TZ §5.3) overlapping the file's period. Shared by
 * `TransfersService` and the FMCSA compliance pack so both producers name the same co-driver.
 *
 * Rule: the subject driver may sit in either seat (seat swaps end a row and open a mirrored one),
 * so the partner is the OTHER side of each overlapping row. The header names the MOST RECENT
 * partner (open pairing first, then the latest `endedAt`, then the latest `startedAt`); every other
 * distinct partner of the period is still listed in the user list (type `D`), most recent first.
 * No overlapping pairing => no co-driver (header line 2 stays empty, as before).
 */
import type { CoDriverPairing, Driver } from '@prisma/client';
import type { TransfersRepository } from './transfers.repository';

export type PairingWithDrivers = CoDriverPairing & { primaryDriver: Driver; coDriver: Driver };

export interface PeriodCoDrivers {
  /** Header line 2 (most recent co-driver of the period), or null. */
  coDriver: Driver | null;
  /** Further distinct co-drivers of the period, most recent first (user list only). */
  otherCoDrivers: Driver[];
}

const recency = (p: CoDriverPairing): [number, number] => [p.endedAt ? p.endedAt.getTime() : Number.POSITIVE_INFINITY, p.startedAt.getTime()];

/** Pure: picks the partners of `driverId` out of the pairings overlapping the period. */
export function resolveCoDrivers(driverId: string, pairings: readonly PairingWithDrivers[]): PeriodCoDrivers {
  const sorted = [...pairings].sort((a, b) => {
    const [aEnd, aStart] = recency(a);
    const [bEnd, bStart] = recency(b);
    return bEnd - aEnd || bStart - aStart;
  });
  const partners: Driver[] = [];
  const seen = new Set<string>([driverId]);
  for (const p of sorted) {
    const partner = p.primaryDriverId === driverId ? p.coDriver : p.coDriverId === driverId ? p.primaryDriver : null;
    if (!partner || seen.has(partner.id)) continue;
    seen.add(partner.id);
    partners.push(partner);
  }
  return { coDriver: partners[0] ?? null, otherCoDrivers: partners.slice(1) };
}

export async function loadCoDrivers(
  repo: Pick<TransfersRepository, 'findCoDriverPairings'>,
  driverId: string,
  from: Date,
  to: Date,
): Promise<PeriodCoDrivers> {
  return resolveCoDrivers(driverId, await repo.findCoDriverPairings(driverId, from, to));
}
