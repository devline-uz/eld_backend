import { buildOutputFile } from './output-file';
import {
  activeMalfunctionCodes,
  buildSnapshot,
  formatShippingDocumentField,
  formatTrailerField,
  multidayBasisOf,
  uncertifiedDayCount,
} from './snapshot';
import { validateOutputFile } from './validator';

const DRIVER = {
  id: 'drv_1',
  username: 'jsmith',
  firstName: 'John',
  lastName: 'Smith',
  cdlNumber: 'W8569238',
  cdlState: 'CT',
  homeTerminalTimezone: 'America/New_York',
  hosRuleset: 'US_70_8_PROPERTY',
  eldExempt: false,
  assignedVehicleId: 'veh_1',
} as never;

const CARRIER = {
  name: 'OneBook Logistics',
  dotNumber: '3355123',
  eldIdentifier: 'OBK001',
  eldRegistrationId: null,
} as never;

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    driverId: 'drv_1',
    vehicleId: 'veh_1',
    eventType: 1,
    eventCode: 3,
    eventSequenceId: 1,
    eventDateTime: new Date('2026-09-08T13:00:00Z'),
    timezoneOffset: -240,
    recordStatus: 1,
    recordOrigin: 1,
    latitude: 41.318511,
    longitude: -72.928932,
    locationPrecisionMi: 1,
    totalVehicleMiles: 1000,
    totalEngineHours: 10.5,
    distanceSinceLastValidCoords: 0,
    malfunctionCode: null,
    diagnosticCode: null,
    annotation: null,
    comment: null,
    editReason: null,
    editedById: null,
    ...overrides,
  } as never;
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return buildSnapshot({
    driver: DRIVER,
    carrier: CARRIER,
    events: [event()],
    unidentifiedEvents: [],
    vehicles: [{ id: 'veh_1', unitNumber: '101', vin: '1FUJGLDR9CSBK1234' }] as never,
    users: [],
    dailyLogs: [],
    outputFileComment: 'Roadside',
    generatedAt: new Date('2026-09-11T17:00:00Z'),
    eldIdentifier: 'OBK001',
    eldRegistrationId: '',
    eldAuthenticationValue: 'A1B2C3D4',
    ...overrides,
  });
}

describe('buildSnapshot — segment routing (tz.md §10.2)', () => {
  it('routes eventType 7 to the malfunction list, 4 to the certification list, the rest to events', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1 }),
        event({ eventSequenceId: 2, eventType: 7, eventCode: 1, malfunctionCode: 'P' }),
        event({ eventSequenceId: 3, eventType: 4, eventCode: 1 }),
      ],
    });
    expect(snap.events).toHaveLength(1);
    expect(snap.malfunctions).toHaveLength(1);
    expect(snap.certifications).toHaveLength(1);
  });

  it('keeps the driver at user order 1 and gives each editing back-office user its own order', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1 }),
        event({ eventSequenceId: 2, editedById: 'usr_9', recordOrigin: 3 }),
        event({ eventSequenceId: 3, editedById: 'usr_9' }),
        event({ eventSequenceId: 4, editedById: 'usr_7' }),
      ],
      users: [
        { id: 'usr_9', email: 'fm@onebook.io', firstName: 'Ann', lastName: 'Fleet' },
        { id: 'usr_7', email: 'ad@onebook.io', firstName: 'Bo', lastName: 'Admin' },
      ],
    });
    // 4.8.2.1.2: the unidentified driver profile is always listed, account type D (7.13).
    expect(snap.users.map((u) => [u.orderNumber, u.accountType, u.lastName])).toEqual([
      [1, 'D', 'Smith'],
      [2, 'S', 'Fleet'],
      [3, 'S', 'Admin'],
      [4, 'D', 'Unidentified'],
    ]);
    expect(snap.events[1].userOrderNumber).toBe(2);
    expect(snap.events[3].userOrderNumber).toBe(3);
  });

  it('ranks CMVs most recently operated first across driver and unidentified records (4.8.2.1.3)', () => {
    const snap = snapshot({
      events: [
        event({ vehicleId: 'veh_3', eventDateTime: new Date('2026-09-08T09:00:00Z') }),
        event({ eventSequenceId: 2, vehicleId: 'veh_2', eventDateTime: new Date('2026-09-08T10:00:00Z') }),
      ],
      unidentifiedEvents: [
        event({ eventSequenceId: 3, driverId: null, recordOrigin: 4, vehicleId: 'veh_1', eventDateTime: new Date('2026-09-08T11:00:00Z') }),
      ],
      vehicles: [
        { id: 'veh_1', unitNumber: '101', vin: 'VIN1' },
        { id: 'veh_2', unitNumber: '102', vin: 'VIN2' },
        { id: 'veh_3', unitNumber: '103', vin: 'VIN3' },
      ] as never,
    });
    expect(snap.cmvs).toEqual([
      { orderNumber: 1, powerUnitNumber: '101', vin: 'VIN1' },
      { orderNumber: 2, powerUnitNumber: '102', vin: 'VIN2' },
      { orderNumber: 3, powerUnitNumber: '103', vin: 'VIN3' },
    ]);
    expect(snap.unidentified[0].cmvOrderNumber).toBe(1);
    expect(snap.events.map((e) => e.cmvOrderNumber)).toEqual([3, 2]);
  });

  it('turns annotations, comments and edit reasons into annotation-segment rows', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, annotation: 'Fuel stop' }),
        event({ eventSequenceId: 2, comment: 'Dispatcher note' }),
        event({ eventSequenceId: 3, editReason: 'Wrong status selected' }),
        event({ eventSequenceId: 4 }),
      ],
    });
    expect(snap.annotations.map((a) => a.text)).toEqual(['Fuel stop', 'Dispatcher note', 'Wrong status selected']);
  });

  it('annotates only event-list records (types 1-3) and names the originator by ELD username (4.8.2.1.5)', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, annotation: 'Driver note' }),
        event({ eventSequenceId: 2, annotation: 'Carrier edit', editedById: 'usr_9', recordOrigin: 3 }),
        event({ eventSequenceId: 3, eventType: 4, eventCode: 1, annotation: 'Certified RODS day', comment: 'certifiedDate=2026-09-07' }),
        event({ eventSequenceId: 4, eventType: 7, eventCode: 1, malfunctionCode: 'P', comment: 'Power' }),
        event({ eventSequenceId: 5, eventType: 5, eventCode: 1, comment: 'login' }),
      ],
      users: [{ id: 'usr_9', email: 'fm@onebook.io', firstName: 'Ann', lastName: 'Fleet' }],
    });
    expect(snap.annotations.map((a) => [a.sequenceId, a.username])).toEqual([
      [1, 'jsmith'],
      [2, 'fm@onebook.io'],
    ]);
  });

  it('routes login/logout (5) and engine power (6) records to their own segments (4.8.2.1.8 / 4.8.2.1.9)', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1 }),
        event({ eventSequenceId: 2, eventType: 5, eventCode: 1 }),
        event({ eventSequenceId: 3, eventType: 6, eventCode: 1 }),
      ],
    });
    expect(snap.events.map((e) => e.sequenceId)).toEqual([1]);
    expect(snap.loginLogout?.map((e) => e.sequenceId)).toEqual([2]);
    expect(snap.enginePower?.map((e) => e.sequenceId)).toEqual([3]);
    expect(validateOutputFile(buildOutputFile(snap).csv).issues).toEqual([]);
  });

  it('derives accumulated miles / elapsed hours from the last power-up of the same CMV (4.3.1.3 / 4.3.1.4)', () => {
    const at = (iso: string) => new Date(iso);
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, eventDateTime: at('2026-09-08T08:00:00Z'), totalVehicleMiles: 990 }),
        event({ eventSequenceId: 2, eventType: 6, eventCode: 1, eventDateTime: at('2026-09-08T09:00:00Z'), totalVehicleMiles: 1000, totalEngineHours: 10.2 }),
        event({ eventSequenceId: 3, eventDateTime: at('2026-09-08T12:00:00Z'), totalVehicleMiles: 1150, totalEngineHours: 13.3 }),
        event({ eventSequenceId: 4, eventDateTime: at('2026-09-08T12:30:00Z'), vehicleId: 'veh_2', totalVehicleMiles: 50 }),
      ],
    });
    expect(snap.events.map((e) => [e.sequenceId, e.accumulatedVehicleMiles, e.elapsedEngineHours])).toEqual([
      [1, null, null], // no power-up visible before it: blank, never a guess
      [3, 150, 3.1],
      [4, null, null], // different CMV
    ]);
  });

  it('sets the indicator statuses while a malfunction / diagnostic is active (7.35 / 7.7)', () => {
    const at = (iso: string) => new Date(iso);
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, eventType: 7, eventCode: 1, malfunctionCode: 'P', eventDateTime: at('2026-09-08T09:00:00Z') }),
        event({ eventSequenceId: 2, eventType: 7, eventCode: 3, diagnosticCode: '5', eventDateTime: at('2026-09-08T09:30:00Z') }),
        event({ eventSequenceId: 3, eventDateTime: at('2026-09-08T10:00:00Z') }),
        event({ eventSequenceId: 4, eventType: 7, eventCode: 2, malfunctionCode: 'P', eventDateTime: at('2026-09-08T11:00:00Z') }),
        event({ eventSequenceId: 5, eventDateTime: at('2026-09-08T12:00:00Z') }),
      ],
    });
    expect(snap.events.map((e) => [e.sequenceId, e.malfunctionIndicator, e.diagnosticIndicator])).toEqual([
      [3, true, true],
      [5, false, true],
    ]);
  });

  it('takes the certified date from the certification record, not its timestamp (4.5.1.4(b)(5))', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, eventType: 4, eventCode: 1, comment: 'certifiedDate=2026-09-07', eventDateTime: new Date('2026-09-08T13:00:00Z') }),
        event({ eventSequenceId: 2, eventType: 4, eventCode: 2, eventDateTime: new Date('2026-09-08T13:00:00Z') }),
      ],
    });
    expect(snap.certifications.map((c) => [c.certifiedDate.toISOString().slice(0, 10), c.cmvOrderNumber])).toEqual([
      ['2026-09-07', 1],
      ['2026-09-08', 1],
    ]);
  });

  it('fills header line 6 from the latest active record', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, eventDateTime: new Date('2026-09-08T10:00:00Z'), totalVehicleMiles: 1200, totalEngineHours: 12 }),
        event({ eventSequenceId: 2, eventDateTime: new Date('2026-09-08T11:00:00Z'), latitude: 40.1, longitude: -80.2, totalVehicleMiles: null, totalEngineHours: null }),
      ],
    });
    expect(snap.current).toMatchObject({ latitude: 40.1, longitude: -80.2, totalVehicleMiles: 1200, totalEngineHours: 12 });
  });

  it('treats a locationName with no lat/lon as a manual location and gives it an annotation row', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, latitude: null, longitude: null, locationName: 'Pilot Exit 12' }),
        // Geocoded label next to a fix: not a manual entry, no annotation row.
        event({ eventSequenceId: 2, locationName: '2 mi N of Dayton, OH' }),
        event({ eventSequenceId: 3, latitude: null, longitude: null, locationName: 'Yard 4', annotation: 'Fuel' }),
      ],
    });
    expect(snap.events.map((e) => e.locationDescription)).toEqual(['Pilot Exit 12', null, 'Yard 4']);
    expect(snap.annotations).toEqual([
      expect.objectContaining({ sequenceId: 1, text: '', locationDescription: 'Pilot Exit 12' }),
      expect.objectContaining({ sequenceId: 3, text: 'Fuel', locationDescription: 'Yard 4' }),
    ]);
    const lines = buildOutputFile(snap).csv.split('\r\n');
    expect(lines.find((l) => l.startsWith('0001,'))?.split(',').slice(9, 11)).toEqual(['M', 'M']);
  });

  it('flags records inside an active positioning malfunction (L) window for the E marker', () => {
    const at = (iso: string) => new Date(iso);
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1, eventDateTime: at('2026-09-08T10:00:00Z') }),
        event({ eventSequenceId: 2, eventType: 7, eventCode: 1, malfunctionCode: 'L', eventDateTime: at('2026-09-08T11:00:00Z') }),
        event({ eventSequenceId: 3, latitude: null, longitude: null, eventDateTime: at('2026-09-08T12:00:00Z') }),
        event({ eventSequenceId: 4, eventType: 7, eventCode: 2, malfunctionCode: 'L', eventDateTime: at('2026-09-08T13:00:00Z') }),
        event({ eventSequenceId: 5, eventDateTime: at('2026-09-08T14:00:00Z') }),
      ],
    });
    expect(snap.events.map((e) => [e.sequenceId, e.positioningMalfunction])).toEqual([
      [1, false],
      [3, true],
      [5, false],
    ]);
  });

  it('also sets the indicator flags from the record codes', () => {
    const snap = snapshot({
      events: [event({ malfunctionCode: 'E' }), event({ eventSequenceId: 2, diagnosticCode: '3' })],
    });
    expect(snap.events[0].malfunctionIndicator).toBe(true);
    expect(snap.events[1].diagnosticIndicator).toBe(true);
  });

  it('produces a file that passes Appendix A validation', () => {
    expect(validateOutputFile(buildOutputFile(snapshot()).csv).valid).toBe(true);
  });

  it('derives the header time-zone offset from the driver home terminal timezone', () => {
    // 2026-09-11 is EDT (UTC-4).
    expect(snapshot().driver.timezoneOffsetMin).toBe(-240);
    // Mid-January is EST (UTC-5).
    expect(snapshot({ generatedAt: new Date('2026-01-11T17:00:00Z') }).driver.timezoneOffsetMin).toBe(-300);
  });

  it('maps the 60/7 rulesets to a multiday basis of 7 and 70/8 to 8', () => {
    expect(multidayBasisOf({ hosRuleset: 'US_60_7_PROPERTY' } as never)).toBe(7);
    expect(multidayBasisOf({ hosRuleset: 'US_60_7_PASSENGER' } as never)).toBe(7);
    expect(multidayBasisOf({ hosRuleset: 'US_70_8_PROPERTY' } as never)).toBe(8);
    expect(multidayBasisOf({ hosRuleset: 'US_70_8_PASSENGER' } as never)).toBe(8);
  });
});

describe('buildSnapshot — trailers / shipping documents and server login records (D-129 / D-130)', () => {
  it('fills header lines 3 and 4 from the current trip details (7.42 space-separated, 7.39)', () => {
    const snap = snapshot({ currentTripDetails: { trailerNumbers: ['X53-1188', 'TR-2'], shippingDocuments: ['BOL-1', 'BOL-2'] } });
    expect(snap.currentCmv.trailerNumbers).toBe('X53-1188 TR-2');
    expect(snap.shippingDocumentNumber).toBe('BOL-1 BOL-2');
    const csv = buildOutputFile(snap).csv;
    expect(csv).toContain(',X53-1188 TR-2,');
    expect(csv).toContain('BOL-1 BOL-2,0,');
    expect(validateOutputFile(csv).issues).toEqual([]);
  });

  it('keeps an explicit shippingDocumentNumber over the trip details', () => {
    expect(snapshot({ shippingDocumentNumber: 'EXPLICIT', currentTripDetails: { trailerNumbers: [], shippingDocuments: ['BOL-1'] } }).shippingDocumentNumber).toBe('EXPLICIT');
  });

  it('never cuts a trailer number or document in half to fit 32 / 40 chars', () => {
    expect(formatTrailerField(['AAAAAAAAAA', 'BBBBBBBBBB', 'CCCCCCCCCC', 'D'])).toBe('AAAAAAAAAA BBBBBBBBBB CCCCCCCCCC');
    expect(formatTrailerField([])).toBe('');
    expect(formatShippingDocumentField(['B'.repeat(30), 'C'.repeat(10), 'D'])).toBe(`${'B'.repeat(30)} D`);
    expect(formatShippingDocumentField(['E'.repeat(50)])).toBe('E'.repeat(40));
  });

  it('gives engine power rows the trailers / documents of their home-terminal RODS day (4.8.2.1.9)', () => {
    const snap = snapshot({
      events: [event({ eventSequenceId: 3, eventType: 6, eventCode: 1, eventDateTime: new Date('2026-09-08T02:00:00Z') })],
      // 02:00Z on 09-08 is 22:00 EDT on 09-07.
      tripDetailsByDay: { '2026-09-07': { trailerNumbers: ['TR-7'], shippingDocuments: ['BOL-7'] }, '2026-09-08': { trailerNumbers: ['TR-8'], shippingDocuments: [] } },
    });
    expect(snap.enginePower?.[0]).toMatchObject({ trailerNumbers: 'TR-7', shippingDocumentNumber: 'BOL-7' });
    expect(validateOutputFile(buildOutputFile(snap).csv).issues).toEqual([]);
  });

  it('lists a server-written login/logout pair (origin 1, no editor) under the driver ELD username (4.8.2.1.8)', () => {
    const snap = snapshot({
      events: [
        event({ eventSequenceId: 1 }),
        event({ eventSequenceId: 2, eventType: 5, eventCode: 1, eventDateTime: new Date('2026-09-08T12:00:00Z'), latitude: null, longitude: null }),
        event({ eventSequenceId: 4, eventType: 5, eventCode: 2, eventDateTime: new Date('2026-09-08T20:00:00Z'), latitude: null, longitude: null }),
      ],
    });
    expect(snap.loginLogout?.map((e) => [e.sequenceId, e.eventCode, e.userOrderNumber])).toEqual([
      [2, 1, 1],
      [4, 2, 1],
    ]);
    const csv = buildOutputFile(snap).csv;
    const segment = csv.split('ELD Login/Logout Report:')[1].split('CMV Engine Power-Up')[0];
    // Most recent activity on top; 3rd column is the driver's ELD username.
    expect(segment.trim().split(/\r?\n/).map((line) => line.split(',').slice(0, 3).join(','))).toEqual(['0004,2,jsmith', '0002,1,jsmith']);
    expect(validateOutputFile(csv).issues).toEqual([]);
  });
});

describe('§10.3 warning inputs', () => {
  it('counts days with no certified DailyLog row as uncertified', () => {
    expect(uncertifiedDayCount([{ certified: true }, { certified: false }] as never, 8)).toBe(7);
    expect(uncertifiedDayCount([] as never, 8)).toBe(8);
    expect(uncertifiedDayCount(Array(8).fill({ certified: true }) as never, 8)).toBe(0);
  });

  it('reports a malfunction as active until a matching clear arrives', () => {
    const logged = event({ eventType: 7, eventCode: 1, malfunctionCode: 'P' });
    const cleared = event({ eventType: 7, eventCode: 2, malfunctionCode: 'P', eventSequenceId: 2 });
    expect(activeMalfunctionCodes([logged] as never)).toEqual(['P']);
    expect(activeMalfunctionCodes([logged, cleared] as never)).toEqual([]);
    expect(
      activeMalfunctionCodes([logged, cleared, event({ eventType: 7, eventCode: 1, malfunctionCode: 'E' })] as never),
    ).toEqual(['E']);
  });

  it('ignores diagnostics (codes 3/4) when listing active malfunctions', () => {
    expect(
      activeMalfunctionCodes([event({ eventType: 7, eventCode: 3, diagnosticCode: '5' })] as never),
    ).toEqual([]);
  });
});
