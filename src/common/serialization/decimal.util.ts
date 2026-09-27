import { Prisma } from '@prisma/client';

/**
 * Coordinator follow-up (2026-09-24, bugs.md B-111) — every Prisma `Decimal` column
 * (`TelemetryPoint.latitude/longitude`, `Geofence.centerLat/centerLon/radiusMi`,
 * `WorkOrder.costUsd`, `Defect.laborHours/partsCostUsd`, `Dvir.latitude/longitude`, etc.)
 * serializes via `Prisma.Decimal.prototype.toJSON()`, which returns a STRING (`"38.897639"`),
 * not a number — `JSON.stringify` then emits a quoted string even though OpenAPI/DTOs declare
 * these fields `number`. Any handler that returns a raw Prisma row/array (rather than mapping
 * every field into a hand-built DTO, the way `VehiclesService.histories()` already does with
 * its own `Number(p.latitude)` calls) leaks this.
 *
 * `serializeDecimals` recursively walks a response body and converts every `Prisma.Decimal`
 * instance to a `number` in place (a copy, not a mutation of the original), wired into the
 * global `TransformInterceptor` so no individual handler has to remember to do this — the
 * fix applies to every current AND future endpoint, not just the ones audited by hand.
 */
export function serializeDecimals<T>(value: T): T {
  return walk(value, new Set()) as T;
}

function walk(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Prisma.Decimal) return value.toNumber();
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value)) return value; // defensive: response bodies are plain data, never cyclic
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => walk(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(val, seen);
  }
  return out;
}
