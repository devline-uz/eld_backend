/**
 * Unit tests for the pure builders in generators/users.ts — no DB, no Prisma client
 * instantiation. Run with `npm run test:unit` (this file is opted into the `unit` jest
 * project via jest.config.js `testMatch`).
 */
import { EditorType } from '@prisma/client';
import { createRng } from '../context';
import {
  buildMockRoleDefs,
  buildMockUserPlans,
  buildMockSessionPlans,
  buildMockApiKeyPlans,
  buildAuditPlans,
  MOCK_ROLE_PREFIX,
} from './users';
import { PERMISSION_KEYS } from '../../../src/common/decorators/permission.types';
import { DEFAULT_ROLE_MATRIX } from '../../../src/modules/roles/permission-matrix';

const FROM = new Date('2026-03-14T00:00:00.000Z');
const TO = new Date('2026-09-14T00:00:00.000Z');

describe('mock users generator — pure builders', () => {
  describe('buildMockRoleDefs', () => {
    const defs = buildMockRoleDefs();

    it('every key is prefixed and every permission value is one of NONE|READ|FULL over the 22 keys', () => {
      for (const def of defs) {
        expect(def.key.startsWith(MOCK_ROLE_PREFIX)).toBe(true);
        expect(Object.keys(def.permissions).sort()).toEqual([...PERMISSION_KEYS].sort());
        for (const level of Object.values(def.permissions)) {
          expect(['NONE', 'READ', 'FULL']).toContain(level);
        }
      }
    });

    it('keys are unique', () => {
      const keys = defs.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('each custom matrix actually differs from every default system matrix (not a disguised copy)', () => {
      for (const def of defs) {
        for (const base of Object.values(DEFAULT_ROLE_MATRIX)) {
          expect(def.permissions).not.toEqual(base);
        }
      }
    });
  });

  describe('buildMockUserPlans', () => {
    const rng = createRng(1);
    const customKeys = buildMockRoleDefs().map((d) => d.key);
    const plans = buildMockUserPlans(rng, customKeys, FROM, TO);

    it('produces one plan per role slot (3 ADMIN + 10 FLEET_MANAGER + 12 DISPATCHER + 10 VIEWER + N custom)', () => {
      expect(plans.length).toBe(3 + 10 + 12 + 10 + customKeys.length);
    });

    it('every email is unique and ends with the mock domain', () => {
      const emails = plans.map((p) => p.email);
      expect(new Set(emails).size).toBe(emails.length);
      expect(emails.every((e) => e.endsWith('@mock.onebook.example'))).toBe(true);
    });

    it('never produces a timestamp after `to`', () => {
      for (const p of plans) {
        expect(p.createdAt.getTime()).toBeLessThanOrEqual(TO.getTime());
        if (p.lastActiveAt) expect(p.lastActiveAt.getTime()).toBeLessThanOrEqual(TO.getTime());
        if (p.invitedAt) expect(p.invitedAt.getTime()).toBeLessThanOrEqual(TO.getTime());
      }
    });

    it('INVITED users have no lastActiveAt (never logged in)', () => {
      for (const p of plans) {
        if (p.status === 'INVITED') expect(p.lastActiveAt).toBeNull();
      }
    });

    it('is deterministic for a fixed seed', () => {
      const again = buildMockUserPlans(createRng(1), customKeys, FROM, TO);
      expect(again.map((p) => p.email)).toEqual(plans.map((p) => p.email));
    });
  });

  describe('buildMockSessionPlans', () => {
    const rng = createRng(2);
    const customKeys = buildMockRoleDefs().map((d) => d.key);
    const users = buildMockUserPlans(rng, customKeys, FROM, TO);

    it('never creates a session for an INVITED (never-logged-in) user', () => {
      const sessions = buildMockSessionPlans(rng, users, TO);
      const invitedIndices = new Set(users.filter((u) => u.status === 'INVITED').map((u) => u.index));
      expect(sessions.some((s) => invitedIndices.has(s.userIndex))).toBe(false);
    });

    it('every session lastSeenAt is <= to, and expiresAt is exactly 30 days after lastSeenAt (tz §6 refresh window)', () => {
      const sessions = buildMockSessionPlans(rng, users, TO);
      for (const s of sessions) {
        expect(s.lastSeenAt.getTime()).toBeLessThanOrEqual(TO.getTime());
        expect(s.expiresAt.getTime() - s.lastSeenAt.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
      }
    });
  });

  describe('buildMockApiKeyPlans', () => {
    const rng = createRng(3);

    it('covers all three lifecycle states (active/revoked/expired) and every scope matches "<key>:<READ|FULL>"', () => {
      const plans = buildMockApiKeyPlans(rng, [0, 1, 2], TO);
      const states = new Set(plans.map((p) => p.state));
      expect(states.has('ACTIVE')).toBe(true);
      expect(states.has('REVOKED')).toBe(true);
      expect(states.has('EXPIRED')).toBe(true);
      const scopePattern = new RegExp(`^(${PERMISSION_KEYS.join('|')}):(READ|FULL)$`);
      for (const p of plans) {
        for (const scope of p.scopes) expect(scope).toMatch(scopePattern);
      }
    });

    it('an EXPIRED key has no lastUsedAt/revokedAt and a past expiresAt; a REVOKED key has a revokedAt', () => {
      const plans = buildMockApiKeyPlans(rng, [0, 1, 2], TO);
      for (const p of plans) {
        if (p.state === 'EXPIRED') {
          expect(p.lastUsedAt).toBeNull();
          expect(p.revokedAt).toBeNull();
          expect(p.expiresAt).not.toBeNull();
        }
        if (p.state === 'REVOKED') expect(p.revokedAt).not.toBeNull();
      }
    });
  });

  describe('buildAuditPlans', () => {
    const rng = createRng(4);
    const actorIds = ['actor-1', 'actor-2', 'actor-3'];
    const objectIdsByType = { User: actorIds, Vehicle: ['veh-1'], Driver: [] as string[] };

    it('produces exactly `count` rows, all within [from, to], actorType USER', () => {
      const plans = buildAuditPlans(rng, 250, actorIds, objectIdsByType, FROM, TO);
      expect(plans.length).toBe(250);
      for (const p of plans) {
        expect(p.createdAt.getTime()).toBeGreaterThanOrEqual(FROM.getTime());
        expect(p.createdAt.getTime()).toBeLessThanOrEqual(TO.getTime());
        expect(p.actorType).toBe(EditorType.USER);
        expect(actorIds).toContain(p.actorId);
      }
    });

    it('falls back to an actorId (never crashes) when an objectType pool is empty', () => {
      const plans = buildAuditPlans(rng, 50, actorIds, { ...objectIdsByType, Driver: [] }, FROM, TO);
      for (const p of plans) {
        if (p.objectType === 'Driver') expect(actorIds).toContain(p.objectId);
      }
    });

    it('never includes a redacted-field name (passwordHash/refreshHash/keyHash) in before/after', () => {
      const plans = buildAuditPlans(rng, 500, actorIds, objectIdsByType, FROM, TO);
      for (const p of plans) {
        const blob = JSON.stringify([p.before, p.after]);
        expect(blob).not.toMatch(/passwordHash|refreshHash|keyHash/);
      }
    });
  });
});
