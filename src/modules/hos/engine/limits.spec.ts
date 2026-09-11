/** TZ §8.2 — ruleset limits and exception flags. */
import { ADVERSE_DRIVE_BONUS, ADVERSE_SHIFT_BONUS, BREAK_AFTER_DRIVING, BREAK_MIN_DURATION, CYCLE_60, CYCLE_70, DRIVE_LIMIT_PASSENGER, DRIVE_LIMIT_PROPERTY, isPassenger, PC_LOCATION_PRECISION_MI, RESET_REST, RESTART_REST, resolveLimits, SHIFT_LIMIT_PASSENGER, SHIFT_LIMIT_PROPERTY, SPLIT_LONG_MIN, SPLIT_PAIR_MIN, SPLIT_SHORT_MIN } from './limits';
import { driver } from '../../../../test/helpers/hos';

describe('constants', () => {
  it.each([
    ['11 h driving', DRIVE_LIMIT_PROPERTY, 39600],
    ['10 h passenger driving', DRIVE_LIMIT_PASSENGER, 36000],
    ['14 h window', SHIFT_LIMIT_PROPERTY, 50400],
    ['15 h passenger window', SHIFT_LIMIT_PASSENGER, 54000],
    ['adverse driving bonus', ADVERSE_DRIVE_BONUS, 7200],
    ['adverse window bonus', ADVERSE_SHIFT_BONUS, 7200],
    ['8 h before a break', BREAK_AFTER_DRIVING, 28800],
    ['30 min break', BREAK_MIN_DURATION, 1800],
    ['10 h reset', RESET_REST, 36000],
    ['34 h restart', RESTART_REST, 122400],
    ['7 h split long part', SPLIT_LONG_MIN, 25200],
    ['2 h split short part', SPLIT_SHORT_MIN, 7200],
    ['10 h split pair', SPLIT_PAIR_MIN, 36000],
    ['70 h cycle', CYCLE_70, 252000],
    ['60 h cycle', CYCLE_60, 216000],
    ['PC precision', PC_LOCATION_PRECISION_MI, 10],
  ])('%s', (_name, actual, expected) => expect(actual).toBe(expected));
});

describe('isPassenger', () => {
  it.each([
    ['US_70_8_PROPERTY', false],
    ['US_60_7_PROPERTY', false],
    ['US_70_8_PASSENGER', true],
    ['US_60_7_PASSENGER', true],
  ] as const)('%s → %s', (ruleset, expected) => expect(isPassenger(ruleset)).toBe(expected));
});

describe('resolveLimits', () => {
  it('70/8 property is the default shape', () => {
    expect(resolveLimits('US_70_8_PROPERTY', driver())).toMatchObject({
      driveLimitSec: 39600, shiftLimitSec: 50400, cycleLimitSec: 252000, cycleDays: 8,
      cycleViolationType: 'CYCLE_70', breakRequired: true, adverseApplied: false,
    });
  });

  it('60/7 property uses a 7-day window', () => {
    expect(resolveLimits('US_60_7_PROPERTY', driver())).toMatchObject({ cycleLimitSec: 216000, cycleDays: 7, cycleViolationType: 'CYCLE_60' });
  });

  it('passenger raises the window to 15 h and lowers driving to 10 h', () => {
    expect(resolveLimits('US_70_8_PASSENGER', driver())).toMatchObject({ driveLimitSec: 36000, shiftLimitSec: 54000 });
  });

  it('passenger drivers owe no 30-minute break', () => {
    expect(resolveLimits('US_70_8_PASSENGER', driver()).breakRequired).toBe(false);
  });

  it('60/7 passenger combines both', () => {
    expect(resolveLimits('US_60_7_PASSENGER', driver())).toMatchObject({ driveLimitSec: 36000, cycleDays: 7, breakRequired: false });
  });

  it('adverse driving adds two hours to both clocks', () => {
    expect(resolveLimits('US_70_8_PROPERTY', driver({ adverseDrivingEnabled: true }))).toMatchObject({ driveLimitSec: 46800, shiftLimitSec: 57600, adverseApplied: true });
  });

  it('adverse driving applies to the passenger ruleset too', () => {
    expect(resolveLimits('US_70_8_PASSENGER', driver({ adverseDrivingEnabled: true }))).toMatchObject({ driveLimitSec: 43200, shiftLimitSec: 61200 });
  });

  it('the short-haul exception removes the break requirement', () => {
    expect(resolveLimits('US_70_8_PROPERTY', driver({ shortHaulException: true })).breakRequired).toBe(false);
  });

  it('an explicitly false short-haul flag keeps the break', () => {
    expect(resolveLimits('US_70_8_PROPERTY', driver({ shortHaulException: false })).breakRequired).toBe(true);
  });

  it('never lowers the cycle below the ruleset value', () => {
    expect(resolveLimits('US_70_8_PROPERTY', driver({ adverseDrivingEnabled: true })).cycleLimitSec).toBe(252000);
  });
});
