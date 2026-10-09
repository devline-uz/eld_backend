/* Generates backend/test/conformance/erods fixtures by running the BACKEND TS writer (read-only use). */
import * as fs from 'fs';
import * as path from 'path';
import { buildOutputFile, OutputFileEvent, OutputFileInput } from '../../../src/modules/transfers/output-file';
import { fixtureOutputFileInput, fixtureEvent } from '../../../src/modules/transfers/output-file.fixture';
import { validateOutputFile } from '../../../src/modules/transfers/validator';
import { buildOutputFileName } from '../../../src/modules/transfers/filename';

const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

function write(name: string, input: OutputFileInput, nameInput: { rangeStart: string; rangeEnd: string; sequence: number }) {
  const out = buildOutputFile(input);
  const v = validateOutputFile(out.csv);
  if (!v.valid) throw new Error(`${name}: TS validator rejected: ${JSON.stringify(v.issues)}`);
  const fileName = buildOutputFileName({
    lastName: input.driver.lastName,
    cdlNumber: input.driver.licenseNumber,
    sequence: nameInput.sequence,
    // Appendix A 4.8.2.2(d): creation date in home-terminal time = the header's Current Date.
    createdAt: input.generatedAt,
    timezoneOffsetMin: input.driver.timezoneOffsetMin,
  });
  fs.writeFileSync(path.join(OUT, `${name}.input.json`), JSON.stringify({ ...input, fileNameInput: nameInput }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, `${name}.expected.csv`), out.csv);
  fs.writeFileSync(
    path.join(OUT, `${name}.expected.json`),
    JSON.stringify({ fileName, fileCheckValue: out.fileCheckValue, lineCount: out.lineCount, sizeBytes: Buffer.byteLength(out.csv), counts: v.counts }, null, 2) + '\n',
  );
  console.log(name, fileName, out.fileCheckValue, out.lineCount);
}

// 01 — the backend's own full fixture: every segment populated, superseded + edited records,
// PC 10-mile precision, 65535 sequence id, 80-char annotation, non-ASCII comment, login/logout
// and engine power-up/shut-down segments, current position, accumulated miles / elapsed hours.
write('01_full_8day', fixtureOutputFileInput(), { rangeStart: '2026-09-04', rangeEnd: '2026-09-11', sequence: 1 });

// 02 — empty range: no records at all, co-driver line, exempt driver, 60/7 basis, empty
// registration id (TEST mode), over-long comment with commas/CRLF/tab, unicode names.
write(
  '02_empty_codriver_exempt',
  fixtureOutputFileInput({
    driver: {
      lastName: "O'Brien-Núñez, Jr.",
      firstName: 'Seán',
      username: 'obrien',
      licenseState: 'NY',
      licenseNumber: 'ny 55-21 b',
      multidayBasis: 7,
      exempt: true,
      timezoneOffsetMin: -300,
    },
    coDriver: { lastName: 'Webb', firstName: 'Marcus', username: 'marcuswebb' },
    currentCmv: { powerUnitNumber: '', vin: '', trailerNumbers: '' },
    shippingDocumentNumber: '',
    eldRegistrationId: '',
    eldAuthenticationValue: '',
    outputFileComment: 'ROADSIDE, INSPECTION\r\n\t2025-09-10 ' + 'X'.repeat(80),
    generatedAt: new Date('2025-01-15T05:00:00Z'),
    current: null,
    users: [
      { orderNumber: 1, username: 'obrien', lastName: "O'Brien", firstName: 'Sean', accountType: 'D' },
      { orderNumber: 2, username: 'marcuswebb', lastName: 'Webb', firstName: 'Marcus', accountType: 'D' },
      { orderNumber: 3, username: 'unidentified', lastName: 'Unidentified', firstName: 'Driver', accountType: 'D' },
    ],
    cmvs: [],
    malfunctions: [],
    loginLogout: [],
    enginePower: [],
    events: [],
    annotations: [],
    certifications: [],
    unidentified: [],
  }),
  { rangeStart: '2025-01-15', rangeEnd: '2025-01-15', sequence: 12 },
);

// 03 — DST fall-back day (America/New_York, Sun Nov 2 2025: 25-hour RODS day). Per-event
// offsets switch -240 → -300; rounding ties and sequence-id wrap-around (7.24: 0..FFFF).
const EDT = -240;
const EST = -300;
const dst = (o: Partial<OutputFileEvent>): OutputFileEvent => fixtureEvent({ timezoneOffsetMin: EDT, ...o });
write(
  '03_dst_fallback_day',
  fixtureOutputFileInput({
    driver: {
      lastName: 'Ng',
      firstName: 'Li',
      username: 'ling',
      licenseState: 'OH',
      licenseNumber: '7',
      multidayBasis: 8,
      exempt: false,
      timezoneOffsetMin: EST,
    },
    generatedAt: new Date('2025-11-02T23:30:00Z'),
    outputFileComment: 'ROADSIDE INSPECTION 2025-11-02',
    users: [
      { orderNumber: 1, username: 'ling', lastName: 'Ng', firstName: 'Li', accountType: 'D' },
      { orderNumber: 2, username: 'unidentified', lastName: 'Unidentified', firstName: 'Driver', accountType: 'D' },
    ],
    current: { latitude: 41.25, longitude: -81.75, locationPrecisionMi: 1, totalVehicleMiles: 120_400, totalEngineHours: 4330.25 },
    loginLogout: [dst({ sequenceId: 91, eventType: 5, eventCode: 1, dateTime: new Date('2025-11-02T04:30:00Z'), username: 'ling' })],
    enginePower: [dst({ sequenceId: 92, eventType: 6, eventCode: 2, locationPrecisionMi: 10, dateTime: new Date('2025-11-02T04:20:00Z'), latitude: 0.125, longitude: -72.125 })],
    malfunctions: [
      dst({ sequenceId: 70, eventType: 7, eventCode: 3, diagnosticCode: '1', dateTime: new Date('2025-11-02T05:59:59Z'), totalEngineHours: 0.05 }),
    ],
    events: [
      // 00:00 EDT — midnight of the long day.
      dst({ sequenceId: 1, eventCode: 1, dateTime: new Date('2025-11-02T04:00:00Z'), latitude: 0.125, longitude: -72.125, totalEngineHours: 4321.45 }),
      // 01:30 EDT (first pass).
      dst({ sequenceId: 2, eventCode: 4, dateTime: new Date('2025-11-02T05:30:00Z'), totalVehicleMiles: 120345.9, latitude: 39.995, longitude: -83.005 }),
      // 01:30 EST (second pass, same wall clock).
      dst({ sequenceId: 3, eventCode: 3, dateTime: new Date('2025-11-02T06:30:00Z'), timezoneOffsetMin: EST, latitude: -0.001, longitude: 179.999 }),
      // PC at reduced precision.
      dst({ sequenceId: 4, eventType: 3, eventCode: 1, locationPrecisionMi: 10, dateTime: new Date('2025-11-02T12:00:00Z'), timezoneOffsetMin: EST, latitude: 41.25, longitude: -81.75 }),
      // Intermediate with nothing known.
      dst({ sequenceId: 65536, eventType: 2, eventCode: 1, dateTime: new Date('2025-11-02T18:00:00Z'), timezoneOffsetMin: EST, totalVehicleMiles: null, totalEngineHours: null, accumulatedVehicleMiles: null, elapsedEngineHours: null, latitude: null, longitude: null, distanceSinceLastValidCoords: null, cmvOrderNumber: null, userOrderNumber: null }),
      // 23:59:59 EST — last second of the 25-hour day, sequence 0 stays 0000 (65536 above wraps to 0000).
      dst({ sequenceId: 0, eventCode: 1, dateTime: new Date('2025-11-03T04:59:59Z'), timezoneOffsetMin: EST, malfunctionIndicator: true, diagnosticIndicator: true }),
    ],
    annotations: [
      { sequenceId: 2, username: 'ling', text: '  Pre-trip,   fuel\tstop  ', dateTime: new Date('2025-11-02T05:31:00Z'), timezoneOffsetMin: EDT },
    ],
    certifications: [
      { sequenceId: 90, eventCode: 1, dateTime: new Date('2025-11-03T04:30:00Z'), timezoneOffsetMin: EST, certifiedDate: new Date('2025-11-02T00:00:00Z'), cmvOrderNumber: 1 },
    ],
    unidentified: [],
  }),
  { rangeStart: '2025-11-02', rangeEnd: '2025-11-02', sequence: 100 },
);
