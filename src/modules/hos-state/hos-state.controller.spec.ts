/** TZ §11.8 — `POST /v1/mobile/hos-state` wiring: driver token, DTO, engine version. */
import { HOS_ENGINE_VERSION } from '../hos/hos.constants';
import { HosStateDto } from './dto/hos-state.dto';
import { HosStateController } from './hos-state.controller';
import type { HosStateService, HosStateSubmitResult } from './hos-state.service';

const payload = {
  computedAt: '2026-03-10T15:41:00Z',
  hosEngineVersion: HOS_ENGINE_VERSION,
  state: {
    currentStatus: 'ON',
    driveRemainingSec: 0,
    shiftRemainingSec: 1140,
    breakRemainingSec: 7440,
    cycleRemainingSec: 46140,
    dailyTotals: { off: 27000, sb: 7200, drive: 41160, on: 11040 },
    violations: [{ type: 'DRIVING_11', exceededBySec: 1560 }],
  },
};

describe('HosStateDto', () => {
  it('accepts the §8.6 example payload verbatim', () => {
    const parsed = HosStateDto.parse(payload);
    expect(parsed.computedAt).toBeInstanceOf(Date);
    expect(parsed.state.violations[0]).toEqual({ type: 'DRIVING_11', exceededBySec: 1560 });
  });

  it('defaults an omitted violations list to empty', () => {
    const parsed = HosStateDto.parse({ ...payload, state: { ...payload.state, violations: undefined } });
    expect(parsed.state.violations).toEqual([]);
  });

  it('accepts an app platform', () => {
    expect(HosStateDto.parse({ ...payload, appPlatform: 'IOS' }).appPlatform).toBe('IOS');
  });

  it.each([
    ['a computedAt without an offset', { computedAt: '2026-03-10T15:41:00' }],
    ['a negative counter', { state: { ...payload.state, driveRemainingSec: -1 } }],
    ['a fractional counter', { state: { ...payload.state, shiftRemainingSec: 1.5 } }],
    ['an unknown duty status', { state: { ...payload.state, currentStatus: 'PC' } }],
    ['an unknown violation type', { state: { ...payload.state, violations: [{ type: 'NOPE', exceededBySec: 1 }] } }],
    ['a missing engine version', { hosEngineVersion: '' }],
    ['missing dailyTotals', { state: { ...payload.state, dailyTotals: undefined } }],
  ])('rejects %s', (_label, over) => {
    expect(() => HosStateDto.parse({ ...payload, ...over })).toThrow();
  });

  it('rejects a counter beyond a week of seconds', () => {
    expect(() => HosStateDto.parse({ ...payload, state: { ...payload.state, cycleRemainingSec: 7 * 24 * 3600 + 1 } })).toThrow();
  });
});

describe('HosStateController', () => {
  it('submits the parsed payload under the token driver id', async () => {
    const service = { submit: jest.fn(async () => ({ accepted: true }) as unknown as HosStateSubmitResult) };
    const controller = new HosStateController(service as unknown as HosStateService);
    const dto = HosStateDto.parse(payload);
    await controller.hosStateSubmit(dto, 'driver-9');
    expect(service.submit).toHaveBeenCalledWith('driver-9', dto);
  });
});
