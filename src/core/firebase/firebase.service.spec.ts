const getApps = jest.fn((): unknown[] => []);
const initializeApp = jest.fn((): unknown => ({ name: '[DEFAULT]' }));
const cert = jest.fn((x: unknown): unknown => x);
const verifyIdToken = jest.fn();
const send = jest.fn();
const getAuth = jest.fn((): { verifyIdToken: typeof verifyIdToken } => ({ verifyIdToken }));
const getMessaging = jest.fn((): { send: typeof send } => ({ send }));

jest.mock('firebase-admin/app', () => ({
  getApps: (...args: unknown[]): unknown => getApps(...args),
  initializeApp: (...args: unknown[]): unknown => initializeApp(...args),
  cert: (...args: unknown[]): unknown => cert(...args),
}));
jest.mock('firebase-admin/auth', () => ({ getAuth: (...args: unknown[]): unknown => getAuth(...args) }));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: (...args: unknown[]): unknown => getMessaging(...args) }));
jest.mock('node:fs', () => ({ readFileSync: jest.fn((): string => '{"project_id":"p"}') }));

import { FirebaseService } from './firebase.service';

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    FIREBASE_CREDENTIALS_FILE: '/tmp/creds.json',
    FIREBASE_PROJECT_ID: 'proj-1',
    ...overrides,
  };
  return { get: (key: string) => values[key] };
}

describe('FirebaseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getApps.mockReturnValue([]);
    initializeApp.mockReturnValue({ name: '[DEFAULT]' });
  });

  it('is disabled when FIREBASE_CREDENTIALS_FILE is unset', () => {
    const service = new FirebaseService(makeConfig({ FIREBASE_CREDENTIALS_FILE: undefined }) as never);
    expect(service.enabled).toBe(false);
  });

  it('initializes a new app when none exists yet', () => {
    const service = new FirebaseService(makeConfig() as never);
    expect(service.enabled).toBe(true);
    expect(initializeApp).toHaveBeenCalled();
  });

  it('reuses the existing app instead of re-initializing', () => {
    getApps.mockReturnValue([{ name: '[DEFAULT]' }]);
    const service = new FirebaseService(makeConfig() as never);
    expect(service.enabled).toBe(true);
    expect(initializeApp).not.toHaveBeenCalled();
  });

  it('verifyIdToken() delegates to firebase-admin/auth once enabled', async () => {
    verifyIdToken.mockResolvedValue({ uid: 'u1' });
    const service = new FirebaseService(makeConfig() as never);
    const result = await service.verifyIdToken('idtok');
    expect(result).toEqual({ uid: 'u1' });
    expect(verifyIdToken).toHaveBeenCalledWith('idtok', true);
  });

  it('verifyIdToken() throws when Firebase is not configured', () => {
    const service = new FirebaseService(makeConfig({ FIREBASE_CREDENTIALS_FILE: undefined }) as never);
    expect(() => service.verifyIdToken('idtok')).toThrow(/not configured/);
  });

  it('sendToToken() delegates to firebase-admin/messaging once enabled', async () => {
    send.mockResolvedValue('message-id-1');
    const service = new FirebaseService(makeConfig() as never);
    const result = await service.sendToToken('device-tok', { title: 't', body: 'b' }, { k: 'v' });
    expect(result).toBe('message-id-1');
    expect(send).toHaveBeenCalledWith({
      token: 'device-tok',
      notification: { title: 't', body: 'b' },
      data: { k: 'v' },
    });
  });

  it('sendToToken() throws when Firebase is not configured', async () => {
    const service = new FirebaseService(makeConfig({ FIREBASE_CREDENTIALS_FILE: undefined }) as never);
    await expect(service.sendToToken('device-tok', { title: 't', body: 'b' })).rejects.toThrow(/not configured/);
  });
});
