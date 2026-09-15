/**
 * TZ §18 / §6.5 — an `AuditLog.before`/`after` snapshot must never leak a secret. Every field
 * name here is a hash or secret that exists somewhere in the schema (`prisma/schema.prisma`):
 * `passwordHash` (User), `refreshHash` (Session, DriverSession), `keyHash` (ApiKey). Add to
 * this set, never remove from it without checking the schema first.
 */
export const AUDIT_REDACTED_FIELDS: ReadonlySet<string> = new Set([
  'passwordHash',
  'refreshHash',
  'keyHash',
]);

export const AUDIT_REDACTED_PLACEHOLDER = '[REDACTED]';

/** Deep-redacts every key in {@link AUDIT_REDACTED_FIELDS}, recursing into nested objects/arrays. */
export function redactSecrets<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => redactUnknown(item));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = AUDIT_REDACTED_FIELDS.has(key) ? AUDIT_REDACTED_PLACEHOLDER : redactUnknown(val);
  }
  return out;
}

/** Converts a Prisma row (Dates, BigInt, etc.) into a plain JSON-serializable value. */
export function toJsonSafe<T>(value: T): T {
  if (value === null || value === undefined) return value;
  const serialized: unknown = JSON.parse(
    JSON.stringify(value, (_key, val: unknown) => (typeof val === 'bigint' ? val.toString() : val)),
  );
  return serialized as T;
}

export interface SnapshotDiff {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * TZ §18 / D-002 — field-level diff. Only keys whose value actually changed are kept, on both
 * sides, so `before`/`after` stay small and an auditor can see exactly what moved. `before ===
 * null` means "didn't exist yet" (CREATE); `after === null` means "no longer exists" (DELETE) —
 * in both of those cases the single available side is kept in full, not diffed against nothing.
 */
export function diffSnapshots(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): SnapshotDiff {
  const safeBefore = before ? toJsonSafe(before) : null;
  const safeAfter = after ? toJsonSafe(after) : null;

  if (!safeBefore) return { before: null, after: safeAfter ? redactSecrets(safeAfter) : null };
  if (!safeAfter) return { before: redactSecrets(safeBefore), after: null };

  const beforeOut: Record<string, unknown> = {};
  const afterOut: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(safeBefore), ...Object.keys(safeAfter)]);
  for (const key of keys) {
    if (!deepEqual(safeBefore[key], safeAfter[key])) {
      beforeOut[key] = safeBefore[key];
      afterOut[key] = safeAfter[key];
    }
  }
  return { before: redactSecrets(beforeOut), after: redactSecrets(afterOut) };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
