import { hashPassword, verifyPassword } from './password.util';

describe('password.util (TZ §6.5 — Argon2id)', () => {
  it('hashes with the argon2id prefix and required cost params', async () => {
    const hash = await hashPassword('Onebook2026');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain('m=19456');
    expect(hash).toContain('t=2');
    expect(hash).toContain('p=1');
  });

  it('verifies a matching password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    await expect(verifyPassword(hash, 'wrong')).resolves.toBe(false);
  });

  it('returns false (not a throw) for a malformed/legacy hash', async () => {
    await expect(verifyPassword('scrypt$deadbeef', 'anything')).resolves.toBe(false);
  });
});
