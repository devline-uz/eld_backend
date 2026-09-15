/**
 * OneBook ELD — mock-data framework shared context (see prisma/mock/README.md).
 *
 * Every generator receives a `MockContext` built once by `index.ts`. Nothing in this file
 * touches the DB except the one `carrier.findUniqueOrThrow` used to resolve `carrierId`/`from`.
 */
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { createHash } from 'crypto';

/** Marker used in free-text fields that have no FK back to a mock driver/vehicle/user. */
export const MOCK_TAG = 'mock';

/** Mock-identity conventions — every generator MUST use these, never invent its own. */
export const MOCK_USERNAME_PREFIX = 'mock_';
export const MOCK_UNIT_PREFIX = 'M1';
export const MOCK_TRAILER_PREFIX = 'MOCKTRL-';
export const MOCK_DEVICE_PREFIX = 'MOCKPT30-';
export const MOCK_EMAIL_DOMAIN = '@mock.onebook.example';

/**
 * Fixed namespace for every deterministic mock id (see `mockId` below) — generated once with
 * `crypto.randomUUID()`, never changes. Anyone regenerating this constant would silently change
 * every mock row's id on the next run, so it lives here as a literal, not a computation.
 */
const MOCK_UUID_NAMESPACE = '2450a2de-2c44-4807-8faa-e22e346af41f';

/**
 * RFC 4122 UUID v5 (namespace + name, SHA-1). Deliberately hand-rolled instead of pulling in the
 * `uuid` package: it is not a declared dependency of this project, and this is the only place
 * that would need it. Deterministic — the same (namespace, name) pair always yields the same id.
 */
function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic id for a mock row, derived from its natural key — e.g.
 * `mockId('driver', username)`, `mockId('vehicle', unitNumber)`. Every generator MUST derive a
 * mock row's `id` this way (never `randomUUID()`/`crypto.randomUUID()`) so that re-running a
 * generator against rows that already exist is a same-id UPSERT, never a delete+recreate that
 * would orphan every other table's FK to that row (see decisions.md D-055).
 */
export function mockId(domain: string, naturalKey: string): string {
  return uuidV5(MOCK_UUID_NAMESPACE, `${domain}:${naturalKey}`);
}

/**
 * Small, fast, seeded PRNG (mulberry32) — deterministic across runs so re-running a generator
 * with the same seed reproduces the same dataset (idempotency does not depend on this, but
 * reviewability does). Do NOT use `Math.random()` anywhere in a generator.
 */
export interface MockRng {
  /** Next float in [0, 1). */
  next(): number;
  /** Random integer in [a, b] inclusive. */
  int(a: number, b: number): number;
  /** Random float in [a, b). */
  float(a: number, b: number): number;
  /** Random element of a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** True with probability p (0..1). */
  chance(p: number): boolean;
  /** Fisher-Yates shuffle — returns a new array, does not mutate the input. */
  shuffle<T>(arr: readonly T[]): T[];
}

export function createRng(seed: number): MockRng {
  let a = seed >>> 0;
  function nextRaw(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next: nextRaw,
    int(min: number, max: number): number {
      return Math.floor(nextRaw() * (max - min + 1)) + min;
    },
    float(min: number, max: number): number {
      return nextRaw() * (max - min) + min;
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('MockRng.pick(): empty array');
      return arr[Math.floor(nextRaw() * arr.length) % arr.length];
    },
    chance(p: number): boolean {
      return nextRaw() < p;
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(nextRaw() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

export interface MockContext {
  prisma: PrismaClient;
  rng: MockRng;
  carrierId: string;
  /** now - 6 months, start of day, carrier timezone. */
  from: Date;
  /** now, never later — no generator may write a timestamp after this. */
  to: Date;
  log: (msg: string) => void;
}

/** Fixed seed so every generator run (and re-run) is reproducible; override with MOCK_SEED. */
const DEFAULT_SEED = 20260914;

export async function buildContext(prisma: PrismaClient, log: (msg: string) => void): Promise<MockContext> {
  const carrier = await prisma.carrier.findUniqueOrThrow({ where: { id: 'carrier' } });
  const now = DateTime.now().setZone(carrier.timezone);
  const from = now.minus({ months: 6 }).startOf('day');
  const seed = process.env.MOCK_SEED ? Number(process.env.MOCK_SEED) : DEFAULT_SEED;
  return {
    prisma,
    rng: createRng(seed),
    carrierId: carrier.id,
    from: from.toJSDate(),
    to: now.toJSDate(),
    log,
  };
}

/** Clamp any generated timestamp so it can never land after `ctx.to` (tz.md B-044). */
export function clampToNow(date: Date, ctx: MockContext): Date {
  return date.getTime() > ctx.to.getTime() ? ctx.to : date;
}
