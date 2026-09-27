import { DevicesRepository } from '../devices/devices.repository';
import { StoragePort } from '../../core/storage/storage.port';
import { TicketAttachmentsRepository } from './ticket-attachments.repository';
import { TicketAttachmentsService } from './ticket-attachments.service';

describe('TicketAttachmentsService (B-91 — server-collected ticket attachments)', () => {
  let repo: jest.Mocked<Pick<TicketAttachmentsRepository, 'createAttachment' | 'findEldEvents24h'>>;
  let devices: jest.Mocked<Pick<DevicesRepository, 'findByVehicleId'>>;
  let storage: jest.Mocked<Pick<StoragePort, 'put'>>;
  let service: TicketAttachmentsService;

  beforeEach(() => {
    repo = { createAttachment: jest.fn(), findEldEvents24h: jest.fn() };
    devices = { findByVehicleId: jest.fn() };
    storage = { put: jest.fn().mockResolvedValue('key') };
    service = new TicketAttachmentsService(
      repo as unknown as TicketAttachmentsRepository,
      devices as unknown as DevicesRepository,
      storage as unknown as StoragePort,
    );
  });

  it('does nothing when no attachment kinds are requested', async () => {
    await service.collect('tck_1', 'veh_1', []);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('skips silently (does not throw) when kinds are requested but no vehicleId is given', async () => {
    await service.collect('tck_1', undefined, ['DEVICE_DIAGNOSTICS']);
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('uploads a DEVICE_DIAGNOSTICS attachment when the vehicle has a paired device', async () => {
    devices.findByVehicleId.mockResolvedValue({ id: 'dev_1', serial: 'PT30_A86E', bleState: 'CONNECTED', lastSeenAt: new Date() } as never);

    await service.collect('tck_1', 'veh_1', ['DEVICE_DIAGNOSTICS']);

    expect(storage.put).toHaveBeenCalledWith(
      expect.stringContaining('support-tickets/tck_1/device-diagnostics-'),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'application/json' }),
    );
    expect(repo.createAttachment).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 'tck_1', kind: 'DEVICE_DIAGNOSTICS' }));
  });

  it('skips DEVICE_DIAGNOSTICS (without throwing) when the vehicle has no paired device', async () => {
    devices.findByVehicleId.mockResolvedValue(null);
    await service.collect('tck_1', 'veh_1', ['DEVICE_DIAGNOSTICS']);
    expect(storage.put).not.toHaveBeenCalled();
    expect(repo.createAttachment).not.toHaveBeenCalled();
  });

  it('uploads an ELD_EVENTS_24H CSV attachment scoped to the last 24h for the vehicle', async () => {
    repo.findEldEvents24h.mockResolvedValue([
      { eventDateTime: new Date(), eventType: 1, eventCode: 1, driverId: 'drv_1', malfunctionCode: null, diagnosticCode: null } as never,
    ]);

    await service.collect('tck_1', 'veh_1', ['ELD_EVENTS_24H']);

    expect(repo.findEldEvents24h).toHaveBeenCalledWith('veh_1', expect.any(Date), expect.any(Date));
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringContaining('support-tickets/tck_1/eld-events-24h-'),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'text/csv' }),
    );
    expect(repo.createAttachment).toHaveBeenCalledWith(expect.objectContaining({ ticketId: 'tck_1', kind: 'ELD_EVENTS_24H' }));
  });
});
