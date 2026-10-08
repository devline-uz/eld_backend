import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { DriverGuard } from '../../common/guards/driver.guard';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { MobileAppConfigController, PING_MAX_BYTES } from './mobile-app-config.controller';
import { MobileAppConfigService, compareVersions } from './mobile-app-config.service';

const mkConfig = (env: Record<string, string | undefined>) =>
  ({ get: (k: string) => env[k] }) as never;

describe('MobileAppConfigService (MR-7 / MR-30)', () => {
  it('everything unset -> nulls, default store url', () => {
    const svc = new MobileAppConfigService(mkConfig({ MOBILE_STORE_URL: 'https://play/x' }));
    expect(svc.getAppConfig('android', '1.0.0')).toEqual(
      expect.objectContaining({ minSupportedVersion: null, latestVersion: null, storeUrl: 'https://play/x', updateRequired: null, userManualUrl: null, minPt30Firmware: null }),
    );
  });

  it('updateRequired / updateAvailable from semver compare', () => {
    const svc = new MobileAppConfigService(mkConfig({ MOBILE_MIN_SUPPORTED_VERSION: '1.0.3', MOBILE_LATEST_VERSION: '1.2.0' }));
    expect(svc.getAppConfig('android', '1.0.2').updateRequired).toBe(true);
    expect(svc.getAppConfig('android', '1.0.10').updateRequired).toBe(false);
    expect(svc.getAppConfig('android', '1.0.10').updateAvailable).toBe(true);
    expect(svc.getAppConfig('android', undefined).updateRequired).toBeNull();
  });

  it('compareVersions handles lengths and build suffix', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0+14', '1.9.9')).toBe(1);
  });

  it('legal returns url from env, html null', () => {
    const svc = new MobileAppConfigService(mkConfig({ MOBILE_PRIVACY_URL: 'https://p', MOBILE_LEGAL_VERSION: '2026-10' }));
    expect(svc.getLegal('privacy')).toEqual({ version: '2026-10', url: 'https://p', html: null });
    expect(svc.getLegal('terms')).toEqual({ version: '2026-10', url: null, html: null });
  });
});

describe('MobileAppConfigController', () => {
  const ctrl = new MobileAppConfigController(new MobileAppConfigService(mkConfig({})));
  const proto = MobileAppConfigController.prototype;

  it('app-config and legal are public and throttled; ping is driver-guarded only', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.appConfig)).toBe(true);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.legal)).toBe(true);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.appConfig)).toBe(60);
    expect(Reflect.getMetadata(GUARDS_METADATA, proto.ping)).toContain(DriverGuard);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.ping)).toBeUndefined();
  });

  it('ping has its own 30/min budget (1 MiB x 600/min default would be ~600 MiB/min per IP)', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', proto.ping)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', proto.ping)).toBe(60_000);
  });

  it('legal rejects unknown kind', () => {
    expect(() => ctrl.legal('cookies')).toThrow(BadRequestException);
  });

  it('ping caps bytes at 1 MiB, clamps negatives, sets no-store via headers', () => {
    const sent: { n?: number } = {};
    const res: Record<string, jest.Mock> = {};
    res.status = jest.fn(() => res);
    res.type = jest.fn(() => res);
    res.set = jest.fn(() => res);
    res.send = jest.fn((b: Buffer) => { sent.n = b.length; });
    ctrl.ping('99999999', res as never);
    expect(sent.n).toBe(PING_MAX_BYTES);
    ctrl.ping('-5', res as never);
    expect(sent.n).toBe(0);
    ctrl.ping('1000', res as never);
    expect(sent.n).toBe(1000);
    expect(Reflect.getMetadata('__headers__', proto.ping)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Cache-Control' })]),
    );
  });
});
