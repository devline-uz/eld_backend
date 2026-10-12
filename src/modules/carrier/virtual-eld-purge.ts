import type { PrismaClient } from '@prisma/client';

/**
 * pt30_pt40/tz.md §9.5 — dev-only cleanup of PT Emulator ("Virtual ELD") data, driven by
 * `npm run virtual-eld:purge -- --before=<date> [--dry-run]` (`scripts/virtual-eld-purge.ts`).
 *
 * Deletes ONLY non-§395 data of virtual devices older than `before`:
 *  - `DeviceRawEvent` (raw SDK-style events),
 *  - `TelemetryPoint` rows tagged with the virtual device (`deviceId`, D-145; older untagged rows
 *    cannot be attributed and are left alone),
 *  - BLE state on the `Device` row (no BLE history table exists): reset to DISCONNECTED when the
 *    device was last seen before `before`.
 * `EldEvent` (Appendix A RODS) is append-only and is NEVER touched. Device rows are kept.
 */
export interface VirtualEldPurgeResult {
  virtualDevices: number;
  rawEvents: number;
  telemetryPoints: number;
  bleStatesReset: number;
  dryRun: boolean;
}

type PurgeClient = Pick<PrismaClient, 'device' | 'deviceRawEvent' | 'telemetryPoint' | '$transaction'>;

/** `--before=2026-10-01` / `--before=2026-10-01T12:00:00Z` (+ optional `--dry-run`). */
export function parsePurgeArgs(argv: string[]): { before: Date; dryRun: boolean } {
  const raw = argv.find((a) => a.startsWith('--before='))?.slice('--before='.length);
  if (!raw) throw new Error('pass --before=<date> (e.g. --before=2026-10-01)');
  const before = new Date(raw);
  if (Number.isNaN(before.getTime())) throw new Error(`--before="${raw}" is not a valid date`);
  if (before.getTime() > Date.now()) throw new Error('--before must not be in the future');
  return { before, dryRun: argv.includes('--dry-run') };
}

export async function purgeVirtualEldData(prisma: PurgeClient, before: Date, dryRun: boolean): Promise<VirtualEldPurgeResult> {
  const devices = await prisma.device.findMany({
    where: { OR: [{ isVirtual: true }, { serial: { startsWith: 'V', mode: 'insensitive' } }] },
    select: { id: true },
  });
  const ids = devices.map((d) => d.id);
  const empty = { virtualDevices: 0, rawEvents: 0, telemetryPoints: 0, bleStatesReset: 0, dryRun };
  if (!ids.length) return empty;

  const rawWhere = { deviceId: { in: ids }, occurredAt: { lt: before } };
  const telemetryWhere = { deviceId: { in: ids }, time: { lt: before } };
  const bleWhere = {
    id: { in: ids },
    OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: before } }],
    NOT: { bleState: 'DISCONNECTED' as const, storedEventsCount: 0, lastSeenAt: null },
  };

  if (dryRun) {
    const [rawEvents, telemetryPoints, bleStatesReset] = await Promise.all([
      prisma.deviceRawEvent.count({ where: rawWhere }),
      prisma.telemetryPoint.count({ where: telemetryWhere }),
      prisma.device.count({ where: bleWhere }),
    ]);
    return { virtualDevices: ids.length, rawEvents, telemetryPoints, bleStatesReset, dryRun };
  }

  const [raw, telemetry, ble] = await prisma.$transaction([
    prisma.deviceRawEvent.deleteMany({ where: rawWhere }),
    prisma.telemetryPoint.deleteMany({ where: telemetryWhere }),
    prisma.device.updateMany({
      where: bleWhere,
      data: { bleState: 'DISCONNECTED', storedEventsCount: 0, lastSeenAt: null, connectionType: null },
    }),
  ]);
  return { virtualDevices: ids.length, rawEvents: raw.count, telemetryPoints: telemetry.count, bleStatesReset: ble.count, dryRun };
}
