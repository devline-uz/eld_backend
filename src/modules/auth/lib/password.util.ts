import * as argon2 from 'argon2';

/**
 * TZ §6.5 — Argon2id, memoryCost=19456 (19 MiB), timeCost=2, parallelism=1.
 * Pure function, no Nest DI — kept in `lib/` so it can be reused by seed scripts / CLIs.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain, ARGON2_OPTIONS);
  } catch {
    // argon2.verify throws on malformed/foreign hash formats (e.g. legacy seed placeholders)
    // rather than returning false — treat that as "does not match" instead of a 500.
    return false;
  }
}
