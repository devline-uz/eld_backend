import { resolveRecordingElds } from './recording-elds';

const devices = [
  { id: 'dev-1', serial: 'PT30_D3ED', vehicleId: 'veh-106' },
  { id: 'dev-2', serial: 'PT30_AAAA', vehicleId: 'veh-101' },
];
const vehicles = [
  { id: 'veh-106', unitNumber: '106' },
  { id: 'veh-101', unitNumber: '101' },
];

describe('resolveRecordingElds (LIVE-005)', () => {
  it('names the device each record carried, with its unit', () => {
    expect(resolveRecordingElds([{ deviceId: 'dev-1', vehicleId: 'veh-106' }], devices, vehicles)).toEqual([
      { deviceId: 'dev-1', serial: 'PT30_D3ED', vehicleId: 'veh-106', unitNumber: '106' },
    ]);
  });

  it('falls back to the device paired with the unit when no record carried a device id', () => {
    expect(resolveRecordingElds([{ deviceId: null, vehicleId: 'veh-101' }], devices, vehicles)).toEqual([
      { deviceId: 'dev-2', serial: 'PT30_AAAA', vehicleId: 'veh-101', unitNumber: '101' },
    ]);
  });

  it('does not add a guessed device next to a real one on the same unit', () => {
    const out = resolveRecordingElds(
      [
        { deviceId: 'dev-1', vehicleId: 'veh-101' },
        { deviceId: null, vehicleId: 'veh-101' },
      ],
      devices,
      vehicles,
    );
    expect(out.map((eld) => eld.serial)).toEqual(['PT30_D3ED']);
  });

  it('lists every unit of a day spent in two trucks, by unit number', () => {
    const out = resolveRecordingElds(
      [
        { deviceId: 'dev-1', vehicleId: 'veh-106' },
        { deviceId: 'dev-2', vehicleId: 'veh-101' },
      ],
      devices,
      vehicles,
    );
    expect(out.map((eld) => eld.unitNumber)).toEqual(['101', '106']);
  });

  it('keeps a unit without any paired device (serial unknown) and drops rows with nothing to show', () => {
    const out = resolveRecordingElds(
      [
        { deviceId: null, vehicleId: 'veh-999' },
        { deviceId: 'gone', vehicleId: null },
      ],
      devices,
      [...vehicles, { id: 'veh-999', unitNumber: '999' }],
    );
    expect(out).toEqual([{ deviceId: null, serial: null, vehicleId: 'veh-999', unitNumber: '999' }]);
  });
});
