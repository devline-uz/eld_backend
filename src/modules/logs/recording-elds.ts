/**
 * LIVE-005 — Appendix A §4.8: a RODS display names the ELD the day was recorded on. Pure on
 * purpose: `LogsRepository.findRecordingElds` loads the rows, this decides what is shown.
 */

/** One ELD a RODS day was recorded on. */
export interface RecordingEld {
  deviceId: string | null;
  serial: string | null;
  vehicleId: string | null;
  unitNumber: string | null;
}

export interface RecordingEventRow {
  deviceId: string | null;
  vehicleId: string | null;
}

export interface RecordingDeviceRow {
  id: string;
  serial: string;
  vehicleId: string | null;
}

export interface RecordingVehicleRow {
  id: string;
  unitNumber: string;
}

/**
 * The distinct device / unit pairs of a day's records. A record written without a `deviceId`
 * (manual entries, older data) falls back to the device paired with its unit now — but only when
 * no record on that unit carried a device id, so a real identifier is never mixed with a guess.
 */
export function resolveRecordingElds(
  rows: RecordingEventRow[],
  devices: RecordingDeviceRow[],
  vehicles: RecordingVehicleRow[],
): RecordingEld[] {
  const deviceById = new Map(devices.map((device) => [device.id, device]));
  const deviceByVehicle = new Map<string, RecordingDeviceRow>();
  for (const device of devices) if (device.vehicleId) deviceByVehicle.set(device.vehicleId, device);
  const unitById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle.unitNumber]));
  const vehiclesWithDevice = new Set(rows.filter((row) => row.deviceId && row.vehicleId).map((row) => row.vehicleId));

  const out = new Map<string, RecordingEld>();
  for (const row of rows) {
    if (!row.deviceId && row.vehicleId && vehiclesWithDevice.has(row.vehicleId)) continue;
    const device = row.deviceId
      ? deviceById.get(row.deviceId)
      : row.vehicleId
        ? deviceByVehicle.get(row.vehicleId)
        : undefined;
    const eld: RecordingEld = {
      deviceId: device?.id ?? row.deviceId ?? null,
      serial: device?.serial ?? null,
      vehicleId: row.vehicleId,
      unitNumber: row.vehicleId ? (unitById.get(row.vehicleId) ?? null) : null,
    };
    if (!eld.serial && !eld.unitNumber) continue;
    out.set(`${eld.serial ?? ''}|${eld.vehicleId ?? ''}`, eld);
  }
  return [...out.values()].sort(
    (a, b) =>
      (a.unitNumber ?? '').localeCompare(b.unitNumber ?? '', undefined, { numeric: true }) ||
      (a.serial ?? '').localeCompare(b.serial ?? ''),
  );
}
