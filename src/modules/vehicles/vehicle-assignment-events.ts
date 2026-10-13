import type { EventBusService } from '../../core/events/event-bus.service';

/**
 * B-0xx / D-0xx — realtime fan-out for every path that changes `Driver.assignedVehicleId`.
 * Published as `realtime.push` (relayed API<->worker by `RealtimePubSubService`) to the
 * driver's own room, so the mobile app refetches `GET /mobile/bootstrap` instead of waiting
 * for the next cold start. Never throws — a missed socket push must not fail the write.
 */
export type BootstrapChangeReason = 'vehicle_assigned' | 'vehicle_unassigned' | 'co_driver_switched';

async function push(events: EventBusService | undefined, driverId: string, event: string, payload: unknown): Promise<void> {
  if (!events) return;
  try {
    await events.publish('realtime.push', { room: `driver:${driverId}`, event, payload });
  } catch {
    /* best effort */
  }
}

export async function publishBootstrapChanged(
  events: EventBusService | undefined,
  driverId: string,
  reason: BootstrapChangeReason,
): Promise<void> {
  await push(events, driverId, 'bootstrap.changed', { reason });
}

export async function publishVehicleAssigned(
  events: EventBusService | undefined,
  p: { driverId: string; vehicleId: string; unitNumber: string },
): Promise<void> {
  await push(events, p.driverId, 'vehicle.assigned', { driverId: p.driverId, vehicleId: p.vehicleId, unitNumber: p.unitNumber });
  await publishBootstrapChanged(events, p.driverId, 'vehicle_assigned');
}

export async function publishVehicleUnassigned(
  events: EventBusService | undefined,
  p: { driverId: string; vehicleId: string },
): Promise<void> {
  await push(events, p.driverId, 'vehicle.unassigned', { driverId: p.driverId, vehicleId: p.vehicleId });
  await publishBootstrapChanged(events, p.driverId, 'vehicle_unassigned');
}

export async function publishNotificationNew(events: EventBusService | undefined, driverId: string, notification: unknown): Promise<void> {
  await push(events, driverId, 'notification.new', { notification });
}
