import { DateTime } from 'luxon';
import { RetentionService } from './retention.service';
import { EldEventPartition } from './retention.repository';

/** Pure-function boundary tests (no DB, no S3) — TZ §5.5/§18/§23 "RODS retained 6 months,
 * audit retained 24 months" compliance-checklist line. `partitionsEligibleForDrop` is the
 * single place that decides whether a partition may be touched at all, so this is the test
 * that must never let a still-in-window record be dropped. */
describe('RetentionService.partitionsEligibleForDrop (boundary)', () => {
  function partition(name: string, rangeStart: string, rangeEnd: string): EldEventPartition {
    return { name, rangeStart: new Date(rangeStart), rangeEnd: new Date(rangeEnd) };
  }

  it('excludes a partition whose range END is exactly at the cutoff instant + 1ms (still one ms of in-window data)', () => {
    const cutoff = new Date('2024-01-01T00:00:00.000Z');
    const p = partition('EldEvent_y2023m12', '2023-12-01T00:00:00.000Z', '2024-01-01T00:00:00.001Z');
    expect(RetentionService.partitionsEligibleForDrop([p], cutoff)).toEqual([]);
  });

  it('includes a partition whose range END is exactly AT the cutoff (no row in it can be >= cutoff)', () => {
    const cutoff = new Date('2024-01-01T00:00:00.000Z');
    const p = partition('EldEvent_y2023m12', '2023-12-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
    expect(RetentionService.partitionsEligibleForDrop([p], cutoff)).toEqual([p]);
  });

  it('excludes a partition whose range END is even one millisecond after the cutoff', () => {
    const cutoff = new Date('2024-01-01T00:00:00.000Z');
    const p = partition('EldEvent_y2023m12', '2023-12-01T00:00:00.000Z', '2024-01-01T00:00:00.001Z');
    expect(RetentionService.partitionsEligibleForDrop([p], cutoff)).toHaveLength(0);
  });

  it('includes a partition comfortably older than the cutoff and excludes one comfortably newer', () => {
    const cutoff = new Date('2024-01-01T00:00:00.000Z');
    const old = partition('EldEvent_y2020m01', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z');
    const recent = partition('EldEvent_y2025m01', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z');
    expect(RetentionService.partitionsEligibleForDrop([old, recent], cutoff)).toEqual([old]);
  });

  it('never touches an unparseable/DEFAULT partition because the repository never returns one for it to see', () => {
    // Defensive documentation test: RetentionRepository.listEldEventPartitions() filters out
    // partitions whose bound cannot be parsed (the DEFAULT catch-all) before this function
    // ever runs — see retention.repository.ts `parseBound`. Nothing to assert on
    // `partitionsEligibleForDrop` itself; it only ever receives partitions with a real range.
    expect(RetentionService.partitionsEligibleForDrop([], new Date())).toEqual([]);
  });
});

describe('RetentionService cutoff computation', () => {
  it('EVENT_RETENTION_MONTHS floor is 24 months back from "now" (superset of the 6-month RODS minimum)', () => {
    const svc = new RetentionService({} as never, {} as never, {} as never, {} as never);
    const now = DateTime.utc(2026, 9, 11);
    expect(svc.eventCutoff(now).toISOString()).toBe('2024-09-11T00:00:00.000Z');
  });

  it('AUDIT_RETENTION_MONTHS floor is 24 months back from "now"', () => {
    const svc = new RetentionService({} as never, {} as never, {} as never, {} as never);
    const now = DateTime.utc(2026, 9, 11);
    expect(svc.auditCutoff(now).toISOString()).toBe('2024-09-11T00:00:00.000Z');
  });
});

describe('RetentionService.sweepAuditLog — never falls back to the app-role connection', () => {
  it('skips the purge (and reports why) when RetentionPurgeService is not configured, even though eligible rows exist', async () => {
    const repo = {
      countAuditLogOlderThan: jest.fn().mockResolvedValue(5),
    };
    const purge = { isConfigured: false, purgeOlderThan: jest.fn() };
    const auditRepo = { insert: jest.fn() };
    const storage = { exists: jest.fn(), putStream: jest.fn() };
    const svc = new RetentionService(repo as never, purge as never, auditRepo as never, storage as never);

    const result = await svc.sweepAuditLog();

    expect(result).toEqual({ eligible: 5, archived: 0, purged: 0, skipped: true, reason: 'RETENTION_DATABASE_URL not configured' });
    expect(purge.purgeOlderThan).not.toHaveBeenCalled();
    expect(storage.putStream).not.toHaveBeenCalled();
  });

  it('reports zero eligible rows without ever calling the archive/purge path', async () => {
    const repo = { countAuditLogOlderThan: jest.fn().mockResolvedValue(0) };
    const purge = { isConfigured: true, purgeOlderThan: jest.fn() };
    const auditRepo = { insert: jest.fn() };
    const storage = { exists: jest.fn(), putStream: jest.fn() };
    const svc = new RetentionService(repo as never, purge as never, auditRepo as never, storage as never);

    const result = await svc.sweepAuditLog();

    expect(result).toEqual({ eligible: 0, archived: 0, purged: 0, skipped: false });
    expect(purge.purgeOlderThan).not.toHaveBeenCalled();
  });

  it('refuses to purge when the archived row count does not match the DB count (verification failure)', async () => {
    const repo = {
      countAuditLogOlderThan: jest.fn().mockResolvedValue(3),
      streamAuditLogOlderThan: async function* () {
        yield [{ id: 1n }, { id: 2n }]; // only 2 rows streamed, DB said 3 — mismatch
      },
    };
    const purge = { isConfigured: true, purgeOlderThan: jest.fn() };
    const auditRepo = { insert: jest.fn() };
    const storage = {
      exists: jest.fn().mockResolvedValue(true),
      putStream: jest.fn().mockResolvedValue({ key: 'k', sizeBytes: 42 }),
    };
    const svc = new RetentionService(repo as never, purge as never, auditRepo as never, storage as never);

    const result = await svc.sweepAuditLog();

    expect(result.purged).toBe(0);
    expect(result.skipped).toBe(true);
    expect(purge.purgeOlderThan).not.toHaveBeenCalled();
  });
});
