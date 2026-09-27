import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { writeToBuffer } from 'fast-csv';
import { STORAGE_PORT, StoragePort } from '../../core/storage/storage.port';
import { DevicesRepository } from '../devices/devices.repository';
import { deriveDeviceDiagnostics } from '../devices/diagnostics.util';
import { TicketAttachmentsRepository } from './ticket-attachments.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * §20 B-91 — `POST /support/tickets { attachments: [{ kind }] }` collects the attachment
 * **server-side**: the client only ticks a checkbox, it never builds the ELD event export or
 * reads the device diagnostics itself. Scoped by `vehicleId` on the ticket DTO — the only
 * context the server has for "which device/which 24h of events".
 */
@Injectable()
export class TicketAttachmentsService {
  private readonly logger = new Logger(TicketAttachmentsService.name);

  constructor(
    private readonly repo: TicketAttachmentsRepository,
    private readonly devices: DevicesRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  /** Best-effort — a missing device/no events for the window skips that one attachment rather
   * than failing the whole ticket (the ticket itself already exists by the time this runs). */
  async collect(ticketId: string, vehicleId: string | undefined, kinds: ReadonlyArray<'DEVICE_DIAGNOSTICS' | 'ELD_EVENTS_24H'>): Promise<void> {
    if (!kinds.length) return;
    if (!vehicleId) {
      this.logger.warn({ ticketId, kinds }, 'Ticket attachments requested with no vehicleId to scope them — skipped.');
      return;
    }
    for (const kind of kinds) {
      try {
        if (kind === 'DEVICE_DIAGNOSTICS') await this.collectDiagnostics(ticketId, vehicleId);
        else await this.collectEldEvents24h(ticketId, vehicleId);
      } catch (err) {
        this.logger.warn({ ticketId, vehicleId, kind, err }, 'Failed to collect a ticket attachment.');
      }
    }
  }

  private async collectDiagnostics(ticketId: string, vehicleId: string): Promise<void> {
    const device = await this.devices.findByVehicleId(vehicleId);
    if (!device) return;
    const diagnostics = deriveDeviceDiagnostics(device);
    const body = Buffer.from(JSON.stringify({ deviceId: device.id, serial: device.serial, ...diagnostics }, null, 2));
    const key = `support-tickets/${ticketId}/device-diagnostics-${randomUUID()}.json`;
    await this.storage.put(key, body, { contentType: 'application/json' });
    await this.repo.createAttachment({ key, mimeType: 'application/json', sizeBytes: body.byteLength, ticketId, kind: 'DEVICE_DIAGNOSTICS' });
  }

  private async collectEldEvents24h(ticketId: string, vehicleId: string): Promise<void> {
    const to = new Date();
    const from = new Date(to.getTime() - DAY_MS);
    const events = await this.repo.findEldEvents24h(vehicleId, from, to);
    const rows = events.map((e) => ({
      eventDateTime: e.eventDateTime.toISOString(),
      eventType: e.eventType,
      eventCode: e.eventCode,
      driverId: e.driverId ?? '',
      malfunctionCode: e.malfunctionCode ?? '',
      diagnosticCode: e.diagnosticCode ?? '',
    }));
    const body = await writeToBuffer(rows, { headers: true });
    const key = `support-tickets/${ticketId}/eld-events-24h-${randomUUID()}.csv`;
    await this.storage.put(key, body, { contentType: 'text/csv' });
    await this.repo.createAttachment({ key, mimeType: 'text/csv', sizeBytes: body.byteLength, ticketId, kind: 'ELD_EVENTS_24H' });
  }
}
