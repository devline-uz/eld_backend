import { DriverLoginDto } from './auth.dto';

const device = { deviceId: '11111111-1111-4111-8111-111111111111', deviceLabel: "Ali's Pixel 8", platform: 'android', formFactor: 'phone', appVersion: '1.0.0+1' };

describe('DriverLoginDto.device (MD-195, B-177)', () => {
  it('accepts a normal device', () => {
    expect(DriverLoginDto.safeParse({ username: 'u', password: 'p', device }).success).toBe(true);
  });

  it.each([
    ['bidi override', 'Pixel‮gnp.exe'],
    ['zero-width', 'Pix​el'],
    ['newline (audit/log injection)', 'Pixel\nAUDIT forged'],
    ['NUL', 'Pixel\u0000'],
    ['line separator', 'Pixel x'],
    ['too long', 'x'.repeat(65)],
  ])('rejects a deviceLabel with %s', (_name, deviceLabel) => {
    expect(DriverLoginDto.safeParse({ username: 'u', password: 'p', device: { ...device, deviceLabel } }).success).toBe(false);
  });

  it('rejects a non-uuid deviceId', () => {
    expect(DriverLoginDto.safeParse({ username: 'u', password: 'p', device: { ...device, deviceId: 'victim-device' } }).success).toBe(false);
  });
});
