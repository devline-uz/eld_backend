import { buildRodsDayCsv, csvCell, localDateTime, rodsDayFileName, RODS_DAY_CSV_HEADERS } from './rods-day-csv';

function evt(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    uuid: 'u',
    driverId: 'drv_1',
    vehicleId: 'veh_1',
    eventType: 1,
    eventCode: 3,
    eventSequenceId: 17,
    eventDateTime: new Date('2026-09-10T13:00:00Z'),
    timezoneOffset: -240,
    recordStatus: 1,
    recordOrigin: 1,
    locationName: 'New Haven, CT',
    totalVehicleMiles: 993107,
    totalEngineHours: 4321.4,
    annotation: null,
    ...overrides,
  } as never;
}

describe('rods-day-csv (MB-18)', () => {
  it('writes the documented header row and one row per record, CRLF, home-terminal local time', () => {
    const csv = buildRodsDayCsv([evt()], 'America/New_York');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(RODS_DAY_CSV_HEADERS.join(','));
    expect(lines[0]).toBe('sequenceId,eventType,eventCode,eventDateTime,status,location,odometerMi,engineHours,origin,recordStatus,annotation');
    expect(lines[1]).toBe('17,1,3,2026-09-10 09:00:00,D,"New Haven, CT",993107,4321.4,ELD,ACTIVE,');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines).toHaveLength(3); // header, row, trailing empty
  });

  it('labels driver edits, superseded records and non-duty-status events', () => {
    const csv = buildRodsDayCsv(
      [
        evt({ eventSequenceId: 18, eventCode: 4, recordOrigin: 2, recordStatus: 2, annotation: 'Loading at shipper "#4821"' }),
        evt({ eventSequenceId: 19, eventType: 4, eventCode: 1, locationName: null, totalVehicleMiles: null, totalEngineHours: null }),
        evt({ eventSequenceId: 20, eventType: 1, eventCode: 2, recordOrigin: 3, recordStatus: 3 }),
      ],
      'America/New_York',
    );
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('18,1,4,2026-09-10 09:00:00,ON,"New Haven, CT",993107,4321.4,DRIVER,INACTIVE_CHANGED,"Loading at shipper ""#4821"""');
    expect(lines[2]).toBe('19,4,1,2026-09-10 09:00:00,,,,,ELD,ACTIVE,');
    expect(lines[3]).toBe('20,1,2,2026-09-10 09:00:00,SB,"New Haven, CT",993107,4321.4,CARRIER,INACTIVE_CHANGE_REQUESTED,');
  });

  it('an empty day is just the header', () => {
    expect(buildRodsDayCsv([], 'UTC')).toBe(`${RODS_DAY_CSV_HEADERS.join(',')}\r\n`);
  });

  it('localDateTime follows the home-terminal timezone across DST', () => {
    expect(localDateTime('America/New_York', new Date('2026-01-10T13:00:00Z'))).toBe('2026-01-10 08:00:00');
    expect(localDateTime('America/Los_Angeles', new Date('2026-09-10T03:30:15Z'))).toBe('2026-09-09 20:30:15');
  });

  it('csvCell quotes only when needed', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('file name is RODS_<date>.<format> with unsafe characters stripped', () => {
    expect(rodsDayFileName('2026-09-10', 'csv')).toBe('RODS_2026-09-10.csv');
    expect(rodsDayFileName('2026-09-10"; rm', 'pdf')).toBe('RODS_2026-09-10.pdf');
  });
});
