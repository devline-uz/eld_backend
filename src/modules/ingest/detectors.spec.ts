import {
  CLOCK_DRIFT_LIMIT_SEC,
  clockDriftSec,
  detectMissingData,
  isBleDisconnectedTooLong,
  isDeviceBacklog,
  isTimingMalfunction,
  runWindowChecks,
} from './detectors';
import { DIAGNOSTIC, MALFUNCTION } from './event-codes';

const window = {
  powerOffSec: 0,
  ecmSilenceSec: 0,
  noPositionSec: 0,
  unidentifiedDrivingSec: 0,
  consecutiveTransferFailures: 0,
  storedEventsCount: 0,
  recordsLost: false,
  powerDataMissing: false,
};

describe('ingest/detectors — §7.8 automatic checks', () => {
  describe('T timing (§7.3 rule 5 and §7.8 share ONE 10-minute threshold)', () => {
    it('uses 10 minutes, not 5', () => {
      expect(CLOCK_DRIFT_LIMIT_SEC).toBe(600);
    });

    it('computes signed drift against server UTC', () => {
      const now = new Date('2025-09-10T12:00:00Z');
      expect(clockDriftSec(new Date('2025-09-10T12:05:00Z'), now)).toBe(300);
      expect(clockDriftSec(new Date('2025-09-10T11:55:00Z'), now)).toBe(-300);
    });

    it('trips only above 10 minutes, in both directions', () => {
      expect(isTimingMalfunction(600)).toBe(false);
      expect(isTimingMalfunction(601)).toBe(true);
      expect(isTimingMalfunction(-601)).toBe(true);
    });
  });

  describe('diagnostic 3 — missing data', () => {
    it('fires on a bad checksum', () => {
      expect(
        detectMissingData({ checksumOk: false, missingFields: [], odometerAnomaly: false }),
      ).toMatchObject({ kind: 'diagnostic', code: DIAGNOSTIC.MISSING_DATA });
    });

    it('fires on a missing mandatory field and names it', () => {
      const found = detectMissingData({
        checksumOk: true,
        missingFields: ['latitude'],
        odometerAnomaly: false,
      });
      expect(found?.reason).toContain('latitude');
    });

    it('fires on an odometer anomaly (§4.3)', () => {
      expect(
        detectMissingData({ checksumOk: true, missingFields: [], odometerAnomaly: true }),
      ).not.toBeNull();
    });

    it('stays silent on a clean event', () => {
      expect(
        detectMissingData({ checksumOk: true, missingFields: [], odometerAnomaly: false }),
      ).toBeNull();
    });
  });

  describe('windowed checks', () => {
    const codes = (w: Partial<typeof window>): string[] =>
      runWindowChecks({ ...window, ...w }).map((c) => c.code);

    it('P — 30 minutes of power interruption in 24 h', () => {
      expect(codes({ powerOffSec: 1799 })).not.toContain(MALFUNCTION.POWER);
      expect(codes({ powerOffSec: 1800 })).toContain(MALFUNCTION.POWER);
    });

    it('E — 30 minutes without ECM data, with its companion diagnostic 2', () => {
      const found = codes({ ecmSilenceSec: 1800 });
      expect(found).toContain(MALFUNCTION.ENGINE_SYNC);
      expect(found).toContain(DIAGNOSTIC.ENGINE_SYNC);
    });

    it('L — 60 minutes without a position', () => {
      expect(codes({ noPositionSec: 3599 })).not.toContain(MALFUNCTION.POSITIONING);
      expect(codes({ noPositionSec: 3600 })).toContain(MALFUNCTION.POSITIONING);
    });

    it('R — lost records or a full device memory', () => {
      expect(codes({ recordsLost: true })).toContain(MALFUNCTION.DATA_RECORDING);
      expect(codes({ storedEventsCount: 100 })).toContain(MALFUNCTION.DATA_RECORDING);
      expect(codes({ storedEventsCount: 99 })).not.toContain(MALFUNCTION.DATA_RECORDING);
    });

    it('S — three consecutive transfer failures, with diagnostic 4', () => {
      expect(codes({ consecutiveTransferFailures: 2 })).not.toContain(MALFUNCTION.DATA_TRANSFER);
      const found = codes({ consecutiveTransferFailures: 3 });
      expect(found).toContain(MALFUNCTION.DATA_TRANSFER);
      expect(found).toContain(DIAGNOSTIC.DATA_TRANSFER);
    });

    it('diagnostic 1 — power data missing', () => {
      expect(codes({ powerDataMissing: true })).toContain(DIAGNOSTIC.POWER_DATA);
    });

    it('diagnostic 5 — 30 minutes of unidentified driving in 24 h', () => {
      expect(codes({ unidentifiedDrivingSec: 1799 })).not.toContain(
        DIAGNOSTIC.UNIDENTIFIED_DRIVING,
      );
      expect(codes({ unidentifiedDrivingSec: 1800 })).toContain(DIAGNOSTIC.UNIDENTIFIED_DRIVING);
    });

    it('a healthy window produces nothing', () => {
      expect(runWindowChecks(window)).toEqual([]);
    });
  });

  describe('BLE and backlog alerts (§7.6, §7.7)', () => {
    const now = new Date('2025-09-10T12:00:00Z');

    it('CONNECTED never alerts', () => {
      expect(isBleDisconnectedTooLong('CONNECTED', null, now)).toBe(false);
    });

    it('OUT_OF_RANGE alerts only after 30 minutes', () => {
      expect(
        isBleDisconnectedTooLong('OUT_OF_RANGE', new Date('2025-09-10T11:40:00Z'), now),
      ).toBe(false);
      expect(
        isBleDisconnectedTooLong('OUT_OF_RANGE', new Date('2025-09-10T11:29:00Z'), now),
      ).toBe(true);
    });

    it('a device never seen counts as disconnected', () => {
      expect(isBleDisconnectedTooLong('DISCONNECTED', null, now)).toBe(true);
    });

    it('backlog alert above 100 stored events', () => {
      expect(isDeviceBacklog(100)).toBe(false);
      expect(isDeviceBacklog(101)).toBe(true);
    });
  });
});
