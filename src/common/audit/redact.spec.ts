import { AUDIT_REDACTED_FIELDS, diffSnapshots, redactSecrets, toJsonSafe } from './redact';

describe('redactSecrets (TZ §18 / §6.5 — never log secrets)', () => {
  it('replaces every field named in AUDIT_REDACTED_FIELDS with a placeholder', () => {
    const raw = {
      id: 'usr_1',
      email: 'a@b.com',
      passwordHash: '$argon2id$v=19$...',
    };
    const redacted = redactSecrets(raw);
    expect(redacted.passwordHash).toBe('[REDACTED]');
    expect(redacted.email).toBe('a@b.com');
    expect(redacted.id).toBe('usr_1');
  });

  it('redacts refreshHash and keyHash too (Session/DriverSession, ApiKey)', () => {
    expect(redactSecrets({ refreshHash: 'abc' }).refreshHash).toBe('[REDACTED]');
    expect(redactSecrets({ keyHash: 'abc' }).keyHash).toBe('[REDACTED]');
  });

  it('recurses into nested objects (e.g. User.role snapshot)', () => {
    const raw = { user: { id: 'u1', passwordHash: 'secret' }, role: { key: 'ADMIN' } };
    const redacted = redactSecrets(raw);
    expect((redacted.user as Record<string, unknown>).passwordHash).toBe('[REDACTED]');
    expect((redacted.role as Record<string, unknown>).key).toBe('ADMIN');
  });

  it('recurses into arrays without losing non-secret entries', () => {
    const raw = [{ passwordHash: 'x', id: 1 }, { passwordHash: 'y', id: 2 }];
    const redacted = redactSecrets(raw);
    expect(redacted[0].passwordHash).toBe('[REDACTED]');
    expect(redacted[1].id).toBe(2);
  });

  it('passes through null, undefined, primitives, and Dates unchanged', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets('plain string')).toBe('plain string');
    expect(redactSecrets(42)).toBe(42);
    const date = new Date('2026-01-01T00:00:00Z');
    expect(redactSecrets(date)).toBe(date);
  });

  it('covers every secret field the schema actually defines', () => {
    // A drift check: if this ever shrinks without a schema review, something leaked.
    expect([...AUDIT_REDACTED_FIELDS].sort()).toEqual(['keyHash', 'passwordHash', 'refreshHash'].sort());
  });
});

describe('toJsonSafe', () => {
  it('converts Date fields to ISO strings and BigInt to string', () => {
    const value = toJsonSafe({ createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 5n });
    expect(value).toEqual({ createdAt: '2026-01-01T00:00:00.000Z', id: '5' });
  });

  it('passes null/undefined through untouched', () => {
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeUndefined();
  });
});

describe('diffSnapshots (D-002 — field-level diff)', () => {
  it('CREATE: before is null, after is the full redacted entity', () => {
    const after = { id: 'r1', name: 'Dispatcher', passwordHash: 'nope' };
    const diff = diffSnapshots(null, after);
    expect(diff.before).toBeNull();
    expect(diff.after).toEqual({ id: 'r1', name: 'Dispatcher', passwordHash: '[REDACTED]' });
  });

  it('DELETE: after is null, before is the full redacted entity', () => {
    const before = { id: 'r1', name: 'Dispatcher', keyHash: 'nope' };
    const diff = diffSnapshots(before, null);
    expect(diff.after).toBeNull();
    expect(diff.before).toEqual({ id: 'r1', name: 'Dispatcher', keyHash: '[REDACTED]' });
  });

  it('UPDATE: keeps only fields that changed, on both sides', () => {
    const before = { id: 'r1', name: 'Old', description: 'same', permissions: { trips: 'READ' } };
    const after = { id: 'r1', name: 'New', description: 'same', permissions: { trips: 'READ' } };
    const diff = diffSnapshots(before, after);
    expect(diff.before).toEqual({ name: 'Old' });
    expect(diff.after).toEqual({ name: 'New' });
  });

  it('UPDATE: a changed nested object is kept in full on both sides, not merged', () => {
    const before = { permissions: { trips: 'READ' } };
    const after = { permissions: { trips: 'FULL' } };
    const diff = diffSnapshots(before, after);
    expect(diff.before).toEqual({ permissions: { trips: 'READ' } });
    expect(diff.after).toEqual({ permissions: { trips: 'FULL' } });
  });

  it('redacts secret fields even when they are the only thing that changed', () => {
    const before = { passwordHash: 'old-hash', name: 'Same' };
    const after = { passwordHash: 'new-hash', name: 'Same' };
    const diff = diffSnapshots(before, after);
    expect(diff.before).toEqual({ passwordHash: '[REDACTED]' });
    expect(diff.after).toEqual({ passwordHash: '[REDACTED]' });
  });

  it('both null returns both null', () => {
    expect(diffSnapshots(null, null)).toEqual({ before: null, after: null });
  });
});
