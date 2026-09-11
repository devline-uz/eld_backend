import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ERROR_CODES, ErrorCode } from './codes';

/**
 * Swagger documentation for the TZ §20 error envelope.
 *
 * tasks.md Global gate: "All endpoints documented in Swagger, with example responses".
 * Success examples live next to each route (`@ApiOkResponse({ schema: { example } })`);
 * failures are documented here so every endpoint shows the SAME envelope shape with a
 * real code from `common/errors/codes.ts` (codes are append-only — §20).
 *
 * The envelope is declared as an inline OpenAPI schema rather than a `@ApiProperty`
 * class: `ErrorEnvelope` is an interface (no runtime metadata), and an inline schema keeps
 * the generated document free of unresolved `$ref`s / missing-schema warnings.
 */
const ERROR_ENVELOPE_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'code', 'message', 'traceId', 'timestamp'],
  properties: {
    statusCode: { type: 'number' },
    code: { type: 'string', description: 'Stable code from common/errors/codes.ts (append-only).' },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
    traceId: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
  },
};

export interface ApiErrorSpec {
  status: number;
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  /** Overrides the Swagger `description` (defaults to the example message). */
  description?: string;
}

/** Builds a §20 envelope example — also used by tests that assert on documented codes. */
export function errorEnvelopeExample(spec: ApiErrorSpec): Record<string, unknown> {
  return {
    statusCode: spec.status,
    code: spec.code,
    message: spec.message,
    ...(spec.details ? { details: spec.details } : {}),
    traceId: '01J8X3QK9Z0000000000000000',
    timestamp: '2026-09-11T15:41:00.000Z',
  };
}

/** One documented failure response. */
export function ApiErrorResponse(spec: ApiErrorSpec): MethodDecorator & ClassDecorator {
  return ApiResponse({
    status: spec.status,
    description: spec.description ?? `${spec.code} — ${spec.message}`,
    schema: { ...ERROR_ENVELOPE_SCHEMA, example: errorEnvelopeExample(spec) },
  });
}

export const apiError = {
  validation: (message = 'Request validation failed.'): ApiErrorSpec => ({
    status: 422,
    code: ERROR_CODES.VALIDATION_FAILED,
    message,
    details: { issues: [{ path: 'field', code: 'invalid_type', message: 'Required' }] },
  }),
  unauthorized: (message = 'Authentication required.'): ApiErrorSpec => ({
    status: 401,
    code: ERROR_CODES.UNAUTHORIZED,
    message,
  }),
  forbidden: (message = 'Insufficient permissions for this action.'): ApiErrorSpec => ({
    status: 403,
    code: ERROR_CODES.FORBIDDEN,
    message,
  }),
  notFound: (code: ErrorCode, message: string): ApiErrorSpec => ({ status: 404, code, message }),
  conflict: (code: ErrorCode, message: string): ApiErrorSpec => ({ status: 409, code, message }),
  unprocessable: (code: ErrorCode, message: string): ApiErrorSpec => ({ status: 422, code, message }),
  rateLimited: (message = 'Too many requests — try again later.'): ApiErrorSpec => ({
    status: 429,
    code: ERROR_CODES.RATE_LIMITED,
    message,
  }),
};

/**
 * The failure set every endpoint shares, plus any route-specific ones.
 *
 *   `@ApiStandardErrors()`                                   -> 401 · 403 · 422
 *   `@ApiStandardErrors({ public: true })`                   -> 422 only (no auth on the route)
 *   `@ApiStandardErrors({ errors: [apiError.notFound(...)] })` adds to the default set
 */
export function ApiStandardErrors(
  opts: { public?: boolean; validation?: boolean; errors?: ApiErrorSpec[] } = {},
): MethodDecorator & ClassDecorator {
  const specs: ApiErrorSpec[] = [];
  if (!opts.public) specs.push(apiError.unauthorized(), apiError.forbidden());
  if (opts.validation !== false) specs.push(apiError.validation());
  specs.push(...(opts.errors ?? []));

  // Nest merges same-status @ApiResponse decorators by overwriting, so de-duplicate on
  // status and let a route-specific spec win over the generic one.
  const byStatus = new Map<number, ApiErrorSpec>();
  for (const spec of specs) byStatus.set(spec.status, spec);

  return applyDecorators(...[...byStatus.values()].map((spec) => ApiErrorResponse(spec)));
}
