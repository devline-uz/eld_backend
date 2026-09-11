import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { QUEUES } from '../core/queue/queue.constants';
import { PrismaService } from '../core/prisma/prisma.service';
import { EventBusService } from '../core/events/event-bus.service';
import { CircleGeofence, detectGeofenceTransitions, isInsideGeofence, Point } from '../modules/geofences/lib/geofence-detect';
import { GeofencesRepository } from '../modules/geofences/geofences.repository';
import { detectHarshEvents, toSample } from '../modules/safety/lib/harsh-detect';
import { SafetyRepository } from '../modules/safety/safety.repository';

export interface SafetyDetectJobData {
  vehicleId: string;
  driverId: string | null;
  points: Array<{ time: string; latitude: number; longitude: number; speedKmh?: number | null; headingDeg?: number | null }>;
}

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

    await this.detectHarsh(vehicleId, driverId, points);
    await this.detectGeofences(vehicleId, points);
  }

  private async detectHarsh(
    vehicleId: string,
    driverId: string | null,
    points: SafetyDetectJobData['points'],
  ): Promise<void> {
    const samples = points.map((p) =>
      toSample({ time: new Date(p.time), speedKmh: p.speedKmh, headingDeg: p.headingDeg, latitude: p.latitude, longitude: p.longitude }),
    );
    const detected = detectHarshEvents(samples);
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
    const fences = await this.geofences.activeCircleFences();
    if (!fences.length) return;

    const orderedPoints: Array<Point & { time: string }> = points
      .map((p) => ({ lat: p.latitude, lon: p.longitude, time: p.time }))
      .sort((a, b) => a.time.localeCompare(b.time));
    const earliest = new Date(orderedPoints[0].time);

    for (const fence of fences) {
      const circle: CircleGeofence = {
        id: fence.id,
        centerLat: Number(fence.centerLat),
        centerLon: Number(fence.centerLon),
        radiusMi: Number(fence.radiusMi),
        alertOnEnter: fence.alertOnEnter,
        alertOnExit: fence.alertOnExit,
      };
      const priorPoint = await this.prisma.telemetryPoint.findFirst({
        where: { vehicleId, time: { lt: earliest } },
        orderBy: { time: 'desc' },
        select: { latitude: true, longitude: true },
      });
      const wasInside = priorPoint
        ? distanceInside({ lat: Number(priorPoint.latitude), lon: Number(priorPoint.longitude) }, circle)
        : null;

      const transitions = detectGeofenceTransitions(orderedPoints, circle, wasInside);
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
    }
  }
}

function distanceInside(point: Point, fence: CircleGeofence): boolean {
  return isInsideGeofence(point, fence);
}
