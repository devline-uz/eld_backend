import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../core/queue/queue.constants';
import { PrismaService } from '../core/prisma/prisma.service';
import { EventBusService } from '../core/events/event-bus.service';
import { CircleGeofence, detectGeofenceTransitions, isDwellExceeded, isInsideGeofence, Point } from '../modules/geofences/lib/geofence-detect';
import { GeofencesRepository } from '../modules/geofences/geofences.repository';
import { coarsenLocation } from '../common/units';
import { detectHarshEvents, toSample } from '../modules/safety/lib/harsh-detect';
import { SafetyRepository } from '../modules/safety/safety.repository';

export interface SafetyDetectJobData {
  vehicleId: string;
  driverId: string | null;
  /** §7.3 rule 9 — PC active at the batch start: persisted positions coarsen to 10 mi, else 1 mi. */
  pcActive?: boolean;
  /** D-135 — harsh types the device itself detects (threshold > 0); the proxy skips those. */
  deviceHarsh?: { accel: boolean; brake: boolean; corner: boolean };
  /** Lat/lon are `null` for a point without a GPS fix (PT SDK 6.11). */
  points: Array<{
    time: string;
    latitude: number | null;
    longitude: number | null;
    speedKmh?: number | null;
    headingDeg?: number | null;
  }>;
}

const PROXY_TYPE_COVERED_BY_DEVICE: Record<'HARSH_ACCEL' | 'HARSH_BRAKING' | 'HARSH_TURN', 'accel' | 'brake' | 'corner'> = {
  HARSH_ACCEL: 'accel',
  HARSH_BRAKING: 'brake',
  HARSH_TURN: 'corner',
};

/**
 * TZ §11.5 (`GET /safety/events`) + Live Fleet "Geofences" chip — consumes the telemetry
 * batch `IngestService.ingestTelemetry` enqueues after every accepted write, runs the
 * pure detectors (`safety/lib/harsh-detect.ts`, `geofences/lib/geofence-detect.ts`) and
 * persists `SafetyEvent` rows / raises `alert.geofence_*` jobs. Detection itself never
 * runs inside the request path (TZ §3.3 — heavy work stays in the worker container).
 */
@Processor(QUEUES.SAFETY_DETECT)
export class SafetyDetectProcessor extends WorkerHost {
  private readonly logger = new Logger(SafetyDetectProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly safety: SafetyRepository,
    private readonly geofences: GeofencesRepository,
    private readonly events: EventBusService,
    @InjectQueue(QUEUES.ALERT) private readonly alertQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<SafetyDetectJobData>): Promise<void> {
    const { vehicleId, driverId, points } = job.data;
    if (!points.length) return;

    await this.detectHarsh(vehicleId, driverId, points, job.data.pcActive ?? false, job.data.deviceHarsh);
    await this.detectGeofences(vehicleId, points);
  }

  private async detectHarsh(
    vehicleId: string,
    driverId: string | null,
    points: SafetyDetectJobData['points'],
    pcActive: boolean,
    deviceHarsh: SafetyDetectJobData['deviceHarsh'],
  ): Promise<void> {
    const samples = points.map((p) =>
      toSample({ time: new Date(p.time), speedKmh: p.speedKmh, headingDeg: p.headingDeg, latitude: p.latitude, longitude: p.longitude }),
    );
    const detected = detectHarshEvents(samples)
      .filter((e) => !deviceHarsh?.[PROXY_TYPE_COVERED_BY_DEVICE[e.type]])
      .map((e) => {
        // B-155 — §7.3 rule 9: the persisted SafetyEvent position is coarsened like every other
        // stored coordinate; the raw fix was only ever needed for detection.
        if (e.latitude === null || e.longitude === null) return e;
        const c = coarsenLocation({ lat: e.latitude, lon: e.longitude }, pcActive ? 'TEN_MILE' : 'ONE_MILE');
        return { ...e, latitude: c.lat, longitude: c.lon };
      });
    if (!detected.length) return;

    await this.safety.createMany(
      detected.map((e) => ({
        driverId: driverId ?? undefined,
        vehicleId,
        type: e.type,
        occurredAt: e.occurredAt,
        severity: e.severity,
        speedMph: e.speedMph ?? undefined,
        latitude: e.latitude,
        longitude: e.longitude,
      })),
    );
    for (const e of detected) {
      await this.events.publish('realtime.push', {
        room: 'fleet',
        event: 'safety.event_created',
        payload: { vehicleId, driverId, type: e.type, severity: e.severity },
      });
      await this.alertQueue
        .add('alert.harsh_event', { vehicleId, driverId, type: e.type, severity: e.severity })
        .catch((err: unknown) => this.logger.error({ err }, 'Failed to enqueue alert.harsh_event'));
    }
  }

  private async detectGeofences(vehicleId: string, points: SafetyDetectJobData['points']): Promise<void> {
    const fences = await this.applicableFences(vehicleId);
    if (!fences.length) return;

    // Points without a GPS fix (PT SDK 6.11) say nothing about a fence.
    const orderedPoints: Array<Point & { time: string }> = points
      .filter((p): p is typeof p & { latitude: number; longitude: number } => p.latitude !== null && p.longitude !== null)
      .map((p) => ({ lat: p.latitude, lon: p.longitude, time: p.time }))
      .sort((a, b) => a.time.localeCompare(b.time));
    if (!orderedPoints.length) return;
    const earliest = new Date(orderedPoints[0].time);
    const zone = await this.resolveZone();

    for (const fence of fences) {
      const circle: CircleGeofence = {
        id: fence.id,
        centerLat: Number(fence.centerLat),
        centerLon: Number(fence.centerLon),
        radiusMi: Number(fence.radiusMi),
        alertOnEnter: fence.alertOnEnter,
        alertOnExit: fence.alertOnExit,
        afterHoursOnly: fence.afterHoursOnly,
      };
      const priorPoint = await this.prisma.telemetryPoint.findFirst({
        where: { vehicleId, time: { lt: earliest }, latitude: { not: null }, longitude: { not: null } },
        orderBy: { time: 'desc' },
        select: { latitude: true, longitude: true },
      });
      const wasInside = priorPoint
        ? distanceInside({ lat: Number(priorPoint.latitude), lon: Number(priorPoint.longitude) }, circle)
        : null;

      const transitions = detectGeofenceTransitions(orderedPoints, circle, wasInside, zone);
      for (const t of transitions) {
        await this.events.publish('realtime.push', {
          room: 'fleet',
          event: 'geofence.transition',
          payload: { vehicleId, geofenceId: t.geofenceId, kind: t.kind },
        });
        await this.alertQueue
          .add(`alert.geofence_${t.kind.toLowerCase()}`, { vehicleId, geofenceId: t.geofenceId })
          .catch((err: unknown) => this.logger.error({ err }, 'Failed to enqueue geofence alert'));
      }

      if (fence.dwellMinutes) {
        await this.detectDwell(vehicleId, fence.id, fence.dwellMinutes, circle, orderedPoints);
      }
    }
  }

  /** §20 B-104 — a fence with a `vehicleGroupId` only applies to vehicles in that group;
   * a null group applies to every vehicle. The vehicle's group is read at most once per job,
   * and only when some active fence is group-scoped. */
  private async applicableFences(vehicleId: string) {
    const fences = await this.geofences.activeCircleFences();
    if (!fences.some((f) => f.vehicleGroupId)) return fences;
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { groupId: true } });
    const groupId = vehicle?.groupId ?? null;
    return fences.filter((f) => !f.vehicleGroupId || f.vehicleGroupId === groupId);
  }

  /** §20 B-15 "Dwell longer than N min" — fires (at most once per batch, throttled by the
   * matching `AlertRule`) once the vehicle has been continuously inside the fence for at
   * least `dwellMinutes`, found by walking `TelemetryPoint` history backward from the latest
   * point in this batch until the first point outside the fence (capped at 300 rows). */
  private async detectDwell(
    vehicleId: string,
    geofenceId: string,
    dwellMinutes: number,
    circle: CircleGeofence,
    orderedPoints: Array<Point & { time: string }>,
  ): Promise<void> {
    const last = orderedPoints[orderedPoints.length - 1];
    if (!isInsideGeofence(last, circle)) return;

    const history = await this.prisma.telemetryPoint.findMany({
      where: { vehicleId, time: { lte: new Date(last.time) }, latitude: { not: null }, longitude: { not: null } },
      orderBy: { time: 'desc' },
      take: 300,
      select: { time: true, latitude: true, longitude: true },
    });
    let enteredAt: Date | null = null;
    for (const p of history) {
      if (isInsideGeofence({ lat: Number(p.latitude), lon: Number(p.longitude) }, circle)) {
        enteredAt = p.time;
      } else break;
    }
    if (!enteredAt || !isDwellExceeded(enteredAt, new Date(last.time), dwellMinutes)) return;

    await this.alertQueue
      .add('alert.geofence_dwell', { vehicleId, geofenceId, dwellMinutes })
      .catch((err: unknown) => this.logger.error({ err }, 'Failed to enqueue alert.geofence_dwell'));
  }

  private async resolveZone(): Promise<string> {
    const carrier = await this.prisma.carrier.findFirst({ select: { timezone: true } });
    return carrier?.timezone ?? 'America/New_York';
  }
}

function distanceInside(point: Point, fence: CircleGeofence): boolean {
  return isInsideGeofence(point, fence);
}
