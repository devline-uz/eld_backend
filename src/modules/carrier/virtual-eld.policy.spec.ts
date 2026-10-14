/** pt30_pt40/tz.md §9 — the shared Virtual ELD gate (D-142). */
import { AppConfigService } from '../../core/config/config.service';
import { parseEnv } from '../../core/config/env.schema';
import {
  isReservedVirtualSerial,
  isVirtualDevice,
  resolveVirtualEldEnabled,
  VIRTUAL_SERIAL_PATTERN,
  VirtualEldPolicy,
} from './virtual-eld.policy';

const BASE_ENV = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db', REDIS_URL: 'redis://localhost:6379' };
// CODE-001 — production refuses the public dev secrets, so production cases supply test-only ones.
const PROD_SECRETS = {
  JWT_SECRET: 'q7Vt2LmX9pR4sK8wZ1cN6bH3yJ5fD0gA-uE+oI/TrWv',
  INTEGRATION_ENCRYPTION_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 73 + 11) % 256)).toString('base64'),
};

function policy(opts: { allowed: boolean; carrier: unknown }) {
  const carriers = { get: jest.fn(async () => opts.carrier) };
  const config = { virtualEldAllowed: opts.allowed } as AppConfigService;
  return { policy: new VirtualEldPolicy(config, carriers as never), carriers };
}

describe('VIRTUAL_ELD_ALLOWED (§9.2)', () => {
  const allowed = (env: Record<string, string>) =>
    new AppConfigService(parseEnv({ ...BASE_ENV, ...PROD_SECRETS, ...env })).virtualEldAllowed;

  it('defaults to true outside production and false in production', () => {
    expect(allowed({ NODE_ENV: 'development' })).toBe(true);
    expect(allowed({ NODE_ENV: 'test' })).toBe(true);
    expect(allowed({ NODE_ENV: 'production' })).toBe(false);
  });

  it('an explicit value wins', () => {
    expect(allowed({ NODE_ENV: 'development', VIRTUAL_ELD_ALLOWED: 'false' })).toBe(false);
    expect(allowed({ NODE_ENV: 'production', VIRTUAL_ELD_ALLOWED: 'true' })).toBe(true);
  });

  it('rejects anything but true/false', () => {
    expect(() => parseEnv({ ...BASE_ENV, VIRTUAL_ELD_ALLOWED: 'yes' })).toThrow(/VIRTUAL_ELD_ALLOWED/);
  });
});

describe('serial rules (§9.1)', () => {
  it.each(['VPT30_A1B2', 'VPT40_ABCDEF123456'])('%s is a valid emulator serial', (s) => {
    expect(VIRTUAL_SERIAL_PATTERN.test(s)).toBe(true);
  });

  it.each(['VPT30_A1B', 'VPT50_A1B2', 'PT30_A1B2', 'VPT30_a1b2', 'VPT30_ABCDEFGHIJKLM'])('%s is not', (s) => {
    expect(VIRTUAL_SERIAL_PATTERN.test(s)).toBe(false);
  });

  it('every V… serial (any case) is reserved; real serials are not', () => {
    expect(isReservedVirtualSerial('VPT30_A1B2')).toBe(true);
    expect(isReservedVirtualSerial(' v123')).toBe(true);
    expect(isReservedVirtualSerial('PT30_A86E')).toBe(false);
  });

  it('isVirtualDevice: flag or reserved serial', () => {
    expect(isVirtualDevice({ isVirtual: true, serial: 'X' })).toBe(true);
    expect(isVirtualDevice({ isVirtual: false, serial: 'VPT30_A1B2' })).toBe(true);
    expect(isVirtualDevice({ isVirtual: false, serial: 'PT30_A86E' })).toBe(false);
  });
});

describe('VirtualEldPolicy', () => {
  it('resolveVirtualEldEnabled needs both env permission and the carrier flag', () => {
    expect(resolveVirtualEldEnabled(true, { virtualEldEnabled: true })).toBe(true);
    expect(resolveVirtualEldEnabled(false, { virtualEldEnabled: true })).toBe(false);
    expect(resolveVirtualEldEnabled(true, { virtualEldEnabled: false })).toBe(false);
    expect(resolveVirtualEldEnabled(true, null)).toBe(false);
  });

  it('a real device passes without reading the carrier', async () => {
    const { policy: p, carriers } = policy({ allowed: false, carrier: null });
    await expect(p.assertDeviceUsable({ isVirtual: false, serial: 'PT30_A86E' })).resolves.toBeUndefined();
    expect(carriers.get).not.toHaveBeenCalled();
  });

  it('a virtual device passes while the switch is on', async () => {
    const { policy: p } = policy({ allowed: true, carrier: { virtualEldEnabled: true } });
    await expect(p.assertDeviceUsable({ isVirtual: true, serial: 'VPT30_A1B2' })).resolves.toBeUndefined();
  });

  it.each([
    ['switch off', true, { virtualEldEnabled: false }],
    ['env disallows', false, { virtualEldEnabled: true }],
  ])('a virtual device gets 403 VIRTUAL_ELD_DISABLED when %s', async (_label, allowed, carrier) => {
    const { policy: p } = policy({ allowed, carrier });
    await expect(p.assertDeviceUsable({ isVirtual: true, serial: 'VPT30_A1B2' })).rejects.toMatchObject({
      code: 'VIRTUAL_ELD_DISABLED',
      status: 403,
    });
  });
});
