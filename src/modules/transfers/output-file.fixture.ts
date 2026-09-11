/**
 * Shared Appendix A fixture: one 8-day RODS snapshot with every segment populated.
 * Used by `output-file.spec.ts`, `validator.spec.ts` and the integration test.
 */
import type { OutputFileEvent, OutputFileInput } from './output-file';

const TZ_OFFSET_MIN = -240; // America/New_York, EDT

export function fixtureEvent(overrides: Partial<OutputFileEvent> = {}): OutputFileEvent {
  return {
    sequenceId: 1,
    recordStatus: 1,
    recordOrigin: 1,
    eventType: 1,
    eventCode: 3,
    dateTime: new Date('2026-09-04T13:00:00Z'),
    timezoneOffsetMin: TZ_OFFSET_MIN,
    totalVehicleMiles: 120_345,
    totalEngineHours: 4321.4,
    latitude: 41.318511,
    longitude: -72.928932,
    locationPrecisionMi: 1,
    distanceSinceLastValidCoords: 0,
    cmvOrderNumber: 1,
    userOrderNumber: 1,
    malfunctionIndicator: false,
    diagnosticIndicator: false,
    ...overrides,
  };
}

export function fixtureOutputFileInput(overrides: Partial<OutputFileInput> = {}): OutputFileInput {
  return {
    driver: {
      lastName: 'Smith',
      firstName: 'John',
      username: 'jsmith',
      licenseState: 'CT',
      licenseNumber: 'W8569238',
      multidayBasis: 8,
      exempt: false,
      timezoneOffsetMin: TZ_OFFSET_MIN,
    },
    coDriver: null,
    currentCmv: { powerUnitNumber: '101', vin: '1FUJGLDR9CSBK1234', trailerNumbers: 'TR-88' },
    shippingDocumentNumber: 'BOL-55120',
    carrier: { usdotNumber: '3355123', name: 'OneBook Logistics, LLC' },
    eldIdentifier: 'OBK1',
    eldRegistrationId: 'OBK1',
    eldAuthenticationValue: 'A1B2C3D4',
    outputFileComment: 'Roadside inspection — I-95 NB mile 48',
    generatedAt: new Date('2026-09-11T17:04:05Z'),
    users: [
      { orderNumber: 1, username: 'jsmith', lastName: 'Smith', firstName: 'John', accountType: 'D' },
      { orderNumber: 2, username: 'dispatch1', lastName: 'Ortiz', firstName: 'Maria', accountType: 'S' },
    ],
    cmvs: [{ orderNumber: 1, powerUnitNumber: '101', vin: '1FUJGLDR9CSBK1234' }],
    malfunctions: [
      fixtureEvent({
        sequenceId: 90,
        eventType: 7,
        eventCode: 1,
        malfunctionCode: 'P',
        dateTime: new Date('2026-09-05T09:15:00Z'),
      }),
      fixtureEvent({
        sequenceId: 91,
        eventType: 7,
        eventCode: 3,
        diagnosticCode: '5',
        dateTime: new Date('2026-09-05T09:20:00Z'),
      }),
    ],
    events: [
      fixtureEvent({ sequenceId: 1, eventCode: 1, dateTime: new Date('2026-09-04T10:00:00Z') }),
      fixtureEvent({ sequenceId: 2, eventCode: 4, dateTime: new Date('2026-09-04T12:00:00Z') }),
      fixtureEvent({ sequenceId: 3, eventCode: 3, dateTime: new Date('2026-09-04T12:30:00Z') }),
      // PC record: 10-mile precision -> 1 decimal on lat/long.
      fixtureEvent({
        sequenceId: 4,
        eventType: 3,
        eventCode: 1,
        locationPrecisionMi: 10,
        dateTime: new Date('2026-09-04T22:00:00Z'),
      }),
      // Superseded by a driver self-edit (recordStatus 2) plus its replacement (origin 2).
      fixtureEvent({ sequenceId: 5, eventCode: 4, recordStatus: 2, dateTime: new Date('2026-09-05T11:00:00Z') }),
      fixtureEvent({ sequenceId: 6, eventCode: 4, recordOrigin: 2, dateTime: new Date('2026-09-05T11:00:00Z') }),
      // Intermediate log with no position fix at all.
      fixtureEvent({
        sequenceId: 7,
        eventType: 2,
        eventCode: 2,
        latitude: null,
        longitude: null,
        distanceSinceLastValidCoords: 4,
        dateTime: new Date('2026-09-06T14:00:00Z'),
      }),
      fixtureEvent({ sequenceId: 65535, eventType: 5, eventCode: 1, dateTime: new Date('2026-09-07T08:00:00Z') }),
    ],
    annotations: [
      {
        sequenceId: 6,
        userOrderNumber: 1,
        text: "Forgot to switch to ON duty — fueling stop, O'Hare",
        dateTime: new Date('2026-09-05T11:05:00Z'),
        timezoneOffsetMin: TZ_OFFSET_MIN,
      },
      {
        sequenceId: 6,
        userOrderNumber: 2,
        text: 'x'.repeat(80),
        dateTime: new Date('2026-09-05T11:06:00Z'),
        timezoneOffsetMin: TZ_OFFSET_MIN,
      },
    ],
    certifications: [
      {
        sequenceId: 40,
        eventCode: 1,
        dateTime: new Date('2026-09-05T03:10:00Z'),
        timezoneOffsetMin: TZ_OFFSET_MIN,
        certifiedDate: new Date('2026-09-04T00:00:00Z'),
      },
      {
        sequenceId: 41,
        eventCode: 9,
        dateTime: new Date('2026-09-06T03:10:00Z'),
        timezoneOffsetMin: TZ_OFFSET_MIN,
        certifiedDate: new Date('2026-09-05T00:00:00Z'),
      },
    ],
    unidentified: [
      fixtureEvent({
        sequenceId: 12,
        recordOrigin: 4,
        eventCode: 3,
        userOrderNumber: null,
        dateTime: new Date('2026-09-08T02:30:00Z'),
      }),
    ],
    ...overrides,
  };
}
