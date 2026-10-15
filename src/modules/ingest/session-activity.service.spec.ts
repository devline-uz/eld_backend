import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import type { ContextUser } from '../../core/context/request-context';
import type { DriverSessionRepository } from '../auth/repositories/driver-session.repository';
import { IngestController } from './ingest.controller';
import type { DeviceEventsService } from './device-events.service';
import type { IngestService } from './ingest.service';
import type { IngestDeviceEventsDto, IngestEventsDto, IngestTelemetryDto } from './dto/ingest.dto';
import { DriverActivityInterceptor, SessionActivityService } from './session-activity.service';

const NOW = new Date('2026-10-15T12:00:00Z');
const DRIVER: ContextUser = { id: 'drv_1', type: 'driver', sessionId: 'sid_1' };
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function build() {
  const sessions = { markMotion: jest.fn().mockResolvedValue(undefined), touchLastSeen: jest.fn().mockResolvedValue(undefined) };
  const svc = new SessionActivityService(sessions as unknown as DriverSessionRepository);
  return { sessions, svc };
}

describe('SessionActivityService — motion (D-161)', () => {
  it('marks the latest fresh moving sample', async () => {
    const { sessions, svc } = build();
    await svc.noteMotion(DRIVER, [
      { at: ago(90_000), moving: true },
      { at: ago(30_000), moving: true },
      { at: ago(10_000), moving: false },
    ], NOW);
    expect(sessions.markMotion).toHaveBeenCalledTimes(1);
    expect(sessions.markMotion).toHaveBeenCalledWith('sid_1', ago(30_000));
  });

  it('ignores stale backlog (> 5 min old) and stationary samples', async () => {
    const { sessions, svc } = build();
    await svc.noteMotion(DRIVER, [{ at: ago(5 * 60_000 + 1), moving: true }, { at: ago(1_000), moving: false }], NOW);
    expect(sessions.markMotion).not.toHaveBeenCalled();
  });

  it('caps a future timestamp at now', async () => {
    const { sessions, svc } = build();
    await svc.noteMotion(DRIVER, [{ at: new Date(NOW.getTime() + 3_600_000), moving: true }], NOW);
    expect(sessions.markMotion).toHaveBeenCalledWith('sid_1', NOW);
  });

  it('throttles writes to one per 30 s of motion time per sid', async () => {
    const { sessions, svc } = build();
    await svc.noteMotion(DRIVER, [{ at: ago(60_000), moving: true }], NOW);
    await svc.noteMotion(DRIVER, [{ at: ago(40_000), moving: true }], NOW);
    expect(sessions.markMotion).toHaveBeenCalledTimes(1);
    await svc.noteMotion(DRIVER, [{ at: ago(20_000), moving: true }], NOW);
    expect(sessions.markMotion).toHaveBeenCalledTimes(2);
    await svc.noteMotion({ ...DRIVER, sessionId: 'sid_2' }, [{ at: ago(20_000), moving: true }], NOW);
    expect(sessions.markMotion).toHaveBeenCalledTimes(3);
  });

  it('skips non-driver principals and tokens without sid', async () => {
    const { sessions, svc } = build();
    await svc.noteMotion({ id: 'u1', type: 'user', sessionId: 's' }, [{ at: NOW, moving: true }], NOW);
    await svc.noteMotion({ id: 'drv_1', type: 'driver' }, [{ at: NOW, moving: true }], NOW);
    await svc.noteMotion(undefined, [{ at: NOW, moving: true }], NOW);
    expect(sessions.markMotion).not.toHaveBeenCalled();
  });

  it('never throws, and retries after a failed write', async () => {
    const { sessions, svc } = build();
    sessions.markMotion.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.noteMotion(DRIVER, [{ at: ago(1_000), moving: true }], NOW)).resolves.toBeUndefined();
    await svc.noteMotion(DRIVER, [{ at: ago(1_000), moving: true }], NOW);
    expect(sessions.markMotion).toHaveBeenCalledTimes(2);
  });
});

describe('SessionActivityService — lastSeenAt (D-161)', () => {
  it('touches at most once per 60 s per sid and never throws', async () => {
    const { sessions, svc } = build();
    await svc.noteSeen(DRIVER, NOW);
    await svc.noteSeen(DRIVER, new Date(NOW.getTime() + 59_000));
    expect(sessions.touchLastSeen).toHaveBeenCalledTimes(1);
    expect(sessions.touchLastSeen).toHaveBeenCalledWith('sid_1', NOW);
    sessions.touchLastSeen.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.noteSeen(DRIVER, new Date(NOW.getTime() + 60_000))).resolves.toBeUndefined();
    expect(sessions.touchLastSeen).toHaveBeenCalledTimes(2);
  });

  it('interceptor touches driver sessions only and always passes through', (done) => {
    const { sessions, svc } = build();
    const interceptor = new DriverActivityInterceptor(svc);
    const ctx = (user?: ContextUser) =>
      ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of('ok') };
    interceptor.intercept(ctx({ id: 'u1', type: 'user', sessionId: 's' }), next);
    interceptor.intercept(ctx(DRIVER), next).subscribe((v) => {
      expect(v).toBe('ok');
      expect(sessions.touchLastSeen).toHaveBeenCalledTimes(1);
      expect(sessions.touchLastSeen).toHaveBeenCalledWith('sid_1', expect.any(Date));
      done();
    });
  });
});

describe('IngestController — motion wiring (D-161)', () => {
  function controller() {
    const ingest = {
      ingestTelemetry: jest.fn().mockResolvedValue({ accepted: 2 }),
      ingestEvents: jest.fn().mockResolvedValue({ warnings: [] }),
    };
    const deviceEvents = { ingestDeviceEvents: jest.fn().mockResolvedValue({ stored: 1 }) };
    const activity = { noteMotion: jest.fn().mockResolvedValue(undefined) };
    const ctrl = new IngestController(
      ingest as unknown as IngestService,
      deviceEvents as unknown as DeviceEventsService,
      activity as unknown as SessionActivityService,
    );
    const req = { headers: {} } as never;
    return { ctrl, ingest, activity, req };
  }

  it('telemetry: speedKmh > 0 is moving, 0/null is not', async () => {
    const { ctrl, activity, req } = controller();
    const t1 = new Date(), t2 = new Date();
    const dto = { points: [{ time: t1, speedKmh: 0 }, { time: t2, speedKmh: 12 }, { time: t1 }] } as unknown as IngestTelemetryDto;
    await expect(ctrl.telemetry(req, dto, 'drv_1', DRIVER)).resolves.toEqual({ accepted: 2 });
    expect(activity.noteMotion).toHaveBeenCalledWith(DRIVER, [
      { at: t1, moving: false },
      { at: t2, moving: true },
      { at: t1, moving: false },
    ]);
  });

  it('device-events: uses occurredAt + speedKmh', async () => {
    const { ctrl, activity, req } = controller();
    const t = new Date();
    const dto = { events: [{ occurredAt: t, speedKmh: 72 }] } as unknown as IngestDeviceEventsDto;
    await ctrl.deviceEventsUpload(req, dto, 'drv_1', DRIVER);
    expect(activity.noteMotion).toHaveBeenCalledWith(DRIVER, [{ at: t, moving: true }]);
  });

  it('events: only a Driving duty status (1/3) counts as motion', async () => {
    const { ctrl, activity, req } = controller();
    const t = new Date();
    const dto = { batch: [{ eventType: 1, eventCode: 3, eventDateTime: t }, { eventType: 1, eventCode: 1, eventDateTime: t }] } as unknown as IngestEventsDto;
    const res = { status: jest.fn() } as never;
    await ctrl.events(req, res, dto, 'drv_1', DRIVER);
    expect(activity.noteMotion).toHaveBeenCalledWith(DRIVER, [{ at: t, moving: true }, { at: t, moving: false }]);
  });

  it('does not mark motion when the ingest itself fails', async () => {
    const { ctrl, ingest, activity, req } = controller();
    ingest.ingestTelemetry.mockRejectedValue(new Error('forbidden'));
    const dto = { points: [{ time: new Date(), speedKmh: 50 }] } as unknown as IngestTelemetryDto;
    await expect(ctrl.telemetry(req, dto, 'drv_1', DRIVER)).rejects.toThrow('forbidden');
    expect(activity.noteMotion).not.toHaveBeenCalled();
  });
});
