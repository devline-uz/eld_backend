import { RefreshGraceStore } from './refresh-grace.store';

const mem = new Map<string, { v: string; ex: number }>();
jest.mock('ioredis', () => ({
  Redis: jest.fn().mockImplementation(() => ({
    set: jest.fn(async (k: string, v: string, _ex: string, ttl: number) => {
      mem.set(k, { v, ex: ttl });
      return 'OK';
    }),
    get: jest.fn(async (k: string) => mem.get(k)?.v ?? null),
    disconnect: jest.fn(),
  })),
}));

const config = { get: jest.fn((k: string) => ({ JWT_SECRET: 's'.repeat(32), REFRESH_REUSE_GRACE_SECONDS: 60, REDIS_URL: 'redis://x', REDIS_DB: 1 })[k]) };

describe('RefreshGraceStore (MG-32)', () => {
  const store = new RefreshGraceStore(config as never);
  beforeEach(() => mem.clear());

  it('round-trips the pair with the old token, with a 60 s TTL, and never stores plaintext', async () => {
    await store.put('old-token', 'oldhash', { accessToken: 'AAA', refreshToken: 'RRR' });
    const [{ v, ex }] = [...mem.values()];
    expect(ex).toBe(60);
    expect(v).not.toContain('AAA');
    expect(v).not.toContain('RRR');
    await expect(store.get('old-token', 'oldhash')).resolves.toEqual({ accessToken: 'AAA', refreshToken: 'RRR' });
  });

  it('a different presented token cannot decrypt the stored pair', async () => {
    await store.put('old-token', 'oldhash', { accessToken: 'AAA', refreshToken: 'RRR' });
    await expect(store.get('other-token', 'oldhash')).resolves.toBeNull();
  });

  it('window 0 stores nothing', async () => {
    config.get.mockImplementationOnce(() => 0);
    await store.put('t', 'h', { accessToken: 'a', refreshToken: 'r' });
    expect(mem.size).toBe(0);
  });
});
