/**
 * Unit tests for the pure planning logic of the `compliance` mock generator.
 * prisma/mock is outside the `unit` jest project glob — run with an explicit --config (see report).
 */
import { createRng } from '../context';
import { checkEditProposal } from '../../../src/modules/logs/edit-rules';
import { planAcceptEdit, type AppendRow } from '../../../src/modules/logs/edit-plan';
import { statusInEffectAt, type RodsEvent } from '../../../src/modules/logs/rods';
import * as P from './compliance.plan';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-14T12:00:00Z');

/** A realistic multi-day duty timeline with jitter. */
function syntheticEvents(seed: number, days = 6): RodsEvent[] {
  const rng = createRng(seed);
  const out: RodsEvent[] = [];
  let id = 1n;
  let seq = 1;
  const push = (at: Date, code: number): void => {
    out.push({ id: id++, eventType: 1, eventCode: code, eventDateTime: at, recordStatus: 1, recordOrigin: 1, eventSequenceId: seq++, supersedesId: null });
  };
  const base = new Date('2026-09-01T00:00:00Z').getTime();
  for (let d = 0; d < days; d += 1) {
    const day = base + d * DAY;
    const j = (h: number): Date => new Date(day + h * HOUR + rng.int(0, 20) * MIN);
    push(new Date(day), 1);
    push(j(6), 4);
    push(j(6.6), 3);
    push(j(10.5), 4);
    push(j(11.2), 1);
    push(j(12), 3);
    push(j(15.5), 4);
    push(j(16), 1);
    if (rng.chance(0.5)) push(j(20), 2);
  }
  return out;
}

function apply(events: RodsEvent[], rows: AppendRow[], requestId: bigint): RodsEvent[] {
  let id = 10_000n;
  let seq = Math.max(...events.map((e) => e.eventSequenceId)) + 1;
  const out = [...events];
  out.push({ id: requestId, eventType: 1, eventCode: 1, eventDateTime: new Date(0), recordStatus: 3, recordOrigin: 3, eventSequenceId: seq++, supersedesId: null });
  for (const row of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    out.push({ id: id++, eventType: row.eventType, eventCode: row.eventCode, eventDateTime: row.at, recordStatus: row.recordStatus, recordOrigin: row.recordOrigin, eventSequenceId: seq++, supersedesId: row.supersedesId });
  }
  return out;
}

describe('mockUuid', () => {
  it('is deterministic, uuid-shaped, tagged, and distinct per key', () => {
    const a = P.mockUuid('evt:x');
    expect(a).toBe(P.mockUuid('evt:x'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(P.isComplianceUuid(a)).toBe(true);
    expect(P.isComplianceUuid('6d6f636b-0000-4000-8000-000000000001')).toBe(false);
    expect(P.mockUuid('evt:y')).not.toBe(a);
  });
});

describe('proposeCarrierEdit (§395.30)', () => {
  it('only proposes edits the API accepts, and accepting them never reduces driving time', () => {
    const kinds = new Set<string>();
    let proposals = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const events = syntheticEvents(seed);
      const timeline = P.buildTimeline(events, NOW);
      const before = P.drivingSeconds(events, NOW);
      for (const target of timeline.duty.slice(1, -1)) {
        const p = P.proposeCarrierEdit(timeline, target, P.rngFor(`t:${seed}:${String(target.id)}`), NOW);
        if (!p) continue;
        proposals += 1;
        kinds.add(p.kind);
        expect(
          checkEditProposal(
            { ...target, intervalEndAt: p.intervalEndAt },
            { proposedStatus: p.status, proposedStart: p.startAt, proposedEnd: p.endAt },
            timeline.driving,
          ),
        ).toBeNull();
        const rows = planAcceptEdit(
          { id: 9_999n, eventType: 1, eventCode: 1, eventDateTime: p.startAt },
          { id: target.id as bigint, eventType: target.eventType, eventCode: target.eventCode, eventDateTime: target.eventDateTime },
          {
            status: p.status, startAt: p.startAt, endAt: p.endAt, annotation: p.reason,
            statusBeforeTarget: statusInEffectAt(events, target.eventDateTime),
            statusAfterInterval: p.endAt ? statusInEffectAt(events, p.endAt) : null,
          },
        );
        const after = P.drivingSeconds(apply(events, rows, 9_999n), NOW);
        expect(after).toBeGreaterThanOrEqual(before);
        // Only an explicit "driving began earlier" request may add driving time.
        if (p.kind !== 'EXTEND_DRIVING') expect(after).toBe(before);
      }
    }
    expect(proposals).toBeGreaterThan(50);
    expect([...kinds].sort()).toEqual(['ANNOTATE_DRIVING', 'EXTEND_DRIVING', 'INSERT', 'RESTATUS', 'SHIFT']);
  });
});

describe('replayCertification (§9.2)', () => {
  const cert1 = new Date('2026-09-02T08:00:00Z');

  it('leaves a day untouched when nothing changed after its certification', () => {
    const r = P.replayCertification(createRng(1), [cert1], [new Date(cert1.getTime() - HOUR)], NOW);
    expect(r).toMatchObject({ added: [], certified: true, certifiedAt: cert1, certificationCount: 1 });
  });

  it('a change after certification invalidates it; re-certification uses code 2 and is never in the future', () => {
    const change = new Date(cert1.getTime() + 2 * DAY);
    let recertified = 0;
    let invalidated = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const r = P.replayCertification(createRng(seed), [cert1], [change], NOW, 0.5);
      if (r.certified) {
        recertified += 1;
        expect(r.added).toHaveLength(1);
        expect(r.added[0].eventCode).toBe(2);
        expect(r.certificationCount).toBe(2);
        expect(r.certifiedAt!.getTime()).toBeGreaterThan(change.getTime());
        expect(r.certifiedAt!.getTime()).toBeLessThanOrEqual(NOW.getTime());
      } else {
        invalidated += 1;
        expect(r).toMatchObject({ added: [], certifiedAt: null, certificationCount: 1 });
      }
    }
    expect(recertified).toBeGreaterThan(180);
    expect(invalidated).toBeGreaterThan(20);
  });

  it('an uncertified day stays uncertified; codes saturate at 9', () => {
    expect(P.replayCertification(createRng(2), [], [new Date(cert1.getTime() + DAY)], NOW)).toMatchObject({ added: [], certified: false, certificationCount: 0 });
    const nine = Array.from({ length: 9 }, (_, i) => new Date(cert1.getTime() - (9 - i) * HOUR));
    const changes = Array.from({ length: 6 }, (_, i) => new Date(cert1.getTime() + (i + 1) * 3 * DAY));
    for (let seed = 1; seed <= 50; seed += 1) {
      const r = P.replayCertification(createRng(seed), nine, changes, NOW);
      r.added.forEach((a) => expect(a.eventCode).toBe(9));
      expect(r.certificationCount).toBe(9 + r.added.length);
    }
  });

  it('a re-certification pending past `now` is not recorded', () => {
    const r = P.replayCertification(createRng(4), [cert1], [new Date(NOW.getTime() - 30 * MIN)], NOW);
    expect(r).toMatchObject({ added: [], certified: false });
  });
});

describe('groupPoolEpisodes (§7.4 rule 3)', () => {
  it('groups power-up, driving, intermediate, on-duty and power-down into one episode each', () => {
    const t0 = new Date('2026-05-01T10:00:00Z').getTime();
    let id = 0n;
    const ev = (type: number, code: number, at: number) => ({ id: ++id, eventType: type, eventCode: code, eventDateTime: new Date(at) });
    const events = [
      ev(6, 1, t0 - MIN), ev(1, 3, t0), ev(2, 1, t0 + HOUR), ev(1, 4, t0 + 70 * MIN), ev(6, 3, t0 + 72 * MIN),
      ev(1, 3, t0 + DAY), ev(1, 4, t0 + DAY + 4 * MIN),
      ev(1, 3, t0 + 2 * DAY),
    ];
    const eps = P.groupPoolEpisodes(events);
    expect(eps).toHaveLength(2);
    expect(eps[0].events.map((e) => Number(e.id))).toEqual([1, 2, 3, 4, 5]);
    expect(eps[0].endAt.getTime() - eps[0].startAt.getTime()).toBe(70 * MIN);
    expect(eps[1].events.map((e) => Number(e.id))).toEqual([6, 7]);
  });
});

describe('outcomes', () => {
  it('edit resolution is never in the future and recent requests are mostly pending', () => {
    let pending = 0;
    for (let seed = 1; seed <= 500; seed += 1) {
      const d = P.decideEditOutcome(createRng(seed), new Date(NOW.getTime() - 2 * DAY), NOW);
      if (d.resolvedAt) expect(d.resolvedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      if (d.outcome === 'PENDING') pending += 1;
    }
    expect(pending).toBeGreaterThan(250);
  });

  it('segment status draws the same randomness regardless of `now`, and never ASSIGNED when not assignable', () => {
    const end = new Date('2026-09-10T00:00:00Z');
    const a = createRng(7);
    const b = createRng(7);
    P.decideSegmentStatus(a, end, new Date('2026-09-10T00:30:00Z'), true);
    P.decideSegmentStatus(b, end, NOW, true);
    expect(a.next()).toBe(b.next());
    for (let seed = 1; seed <= 300; seed += 1) {
      const s = P.decideSegmentStatus(createRng(seed), new Date('2026-05-01T00:00:00Z'), NOW, false);
      expect(s.status).not.toBe('ASSIGNED');
      if (s.actedAt) expect(s.actedAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
    }
  });

  it('transfers: email only to *.fmcsa.dot.gov and encrypted once dispatched; TEST means TEST_ONLY', () => {
    const statuses = new Set<string>();
    for (let seed = 1; seed <= 400; seed += 1) {
      const method = seed % 3 === 0 ? 'EMAIL' : 'WEB_SERVICES';
      const createdAt = new Date(NOW.getTime() - (seed % 50 === 0 ? 5 * MIN : 3 * DAY));
      const o = P.decideTransferOutcome(createRng(seed), method, createdAt, NOW);
      statuses.add(o.status);
      if (o.sentAt) expect(o.sentAt.getTime()).toBeLessThanOrEqual(NOW.getTime());
      if (o.status === 'TEST_ONLY') expect(o.erodsMode).toBe('TEST');
      if (method === 'EMAIL') {
        expect(P.isFmcsaRecipient(o.recipient as string)).toBe(true);
        if (o.status !== 'QUEUED') expect(o.encrypted).toBe(true);
      } else {
        expect(o.encrypted).toBe(false);
        expect(o.recipient).toBeNull();
      }
    }
    expect([...statuses].sort()).toEqual(['ACCEPTED', 'FAILED', 'QUEUED', 'REJECTED', 'SENT', 'TEST_ONLY']);
  });

  it('routing comments and every text pool fit Appendix A (4..60 chars)', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const c = P.routingComment(createRng(seed));
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(60);
    }
    const pools = [...Object.values(P.CARRIER_REASONS).flat(), ...Object.values(P.UNIDENTIFIED_NOTES).flat(), ...P.DRIVER_ACCEPT_NOTES, ...P.DRIVER_REJECT_NOTES];
    for (const text of pools) {
      expect(text.length).toBeGreaterThanOrEqual(4);
      expect(text.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('vehicle odometer timeline for appended records (B-060)', () => {
  const t0 = new Date('2026-05-01T00:00:00Z');
  const at = (h: number): Date => new Date(t0.getTime() + h * HOUR);
  // hos records: parked (flat) 0-6 h, a 200 mi leg 6-10 h, parked again, a later leg 20-24 h
  const hos = [
    { at: at(0), miles: 100_000, engineHours: 5_000 },
    { at: at(6), miles: 100_000, engineHours: 5_000.5 },
    { at: at(10), miles: 100_200, engineHours: 5_005.75 },
    { at: at(20), miles: 100_200, engineHours: 5_006 },
    { at: at(24), miles: 100_450, engineHours: 5_011.2 },
  ];

  it('sorts unordered rows and never lets a reading step back', () => {
    const tl = P.buildVehicleTimeline([hos[3], hos[0], { at: at(12), miles: 99_000, engineHours: 4_000 }, hos[2], hos[1], hos[4]]);
    expect(tl.mi.map((p) => p.value)).toEqual([100_000, 100_000, 100_200, 100_200, 100_200, 100_450]);
    expect(tl.eh.map((p) => p.value)).toEqual([5_000, 5_000.5, 5_005.75, 5_005.75, 5_006, 5_011.2]);
    for (let i = 1; i < tl.mi.length; i += 1) expect(tl.mi[i].at).toBeGreaterThanOrEqual(tl.mi[i - 1].at);
  });

  it('interpolates between the surrounding hos records and stays inside them', () => {
    const tl = P.buildVehicleTimeline(hos);
    const mid = P.readingAt(tl, at(8));
    expect(mid.totalVehicleMiles).toBe(100_100);
    expect(mid.totalEngineHours).toBeCloseTo(5_003.12, 2);
    // inside an idle gap the reading is flat: a pool there cannot push the odometer past the next record
    const gapStart = P.readingAt(tl, at(14));
    const gapEnd = P.readingAt(tl, at(15), gapStart);
    expect(gapStart.totalVehicleMiles).toBe(100_200);
    expect(gapEnd.totalVehicleMiles).toBe(100_200);
    // a sweep of instants never decreases and is always bracketed by the neighbours
    let prev = -Infinity;
    for (let h = -2; h <= 26; h += 0.25) {
      const r = P.readingAt(tl, at(h));
      expect(r.totalVehicleMiles).toBeGreaterThanOrEqual(prev);
      prev = r.totalVehicleMiles as number;
      const lo = [...hos].reverse().find((x) => x.at.getTime() <= at(h).getTime())?.miles ?? hos[0].miles;
      const hi = hos.find((x) => x.at.getTime() >= at(h).getTime())?.miles ?? hos[hos.length - 1].miles;
      expect(r.totalVehicleMiles).toBeGreaterThanOrEqual(lo);
      expect(r.totalVehicleMiles).toBeLessThanOrEqual(hi);
    }
  });

  it('uses the nearest record outside the history and nulls without any', () => {
    const tl = P.buildVehicleTimeline(hos);
    expect(P.readingAt(tl, at(-48)).totalVehicleMiles).toBe(100_000);
    expect(P.readingAt(tl, at(200)).totalVehicleMiles).toBe(100_450);
    expect(P.readingAt(tl, at(200)).totalEngineHours).toBe(5_011.2);
    expect(P.readingAt(P.buildVehicleTimeline([]), at(5))).toEqual({ totalVehicleMiles: null, totalEngineHours: null });
    const milesOnly = P.buildVehicleTimeline([{ at: at(0), miles: 10, engineHours: null }]);
    expect(P.readingAt(milesOnly, at(1))).toEqual({ totalVehicleMiles: 10, totalEngineHours: null });
  });

  it('the floor keeps a segment\'s own end at or above its start', () => {
    const tl = P.buildVehicleTimeline(hos);
    const start = { totalVehicleMiles: 100_150, totalEngineHours: 5_004 };
    const end = P.readingAt(tl, at(7), start);
    expect(end.totalVehicleMiles).toBe(100_150);
    expect(end.totalEngineHours).toBe(5_004);
  });
});
