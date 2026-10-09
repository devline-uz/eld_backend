import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath, type ReferenceObject, type SchemaObject } from '@nestjs/swagger';

/**
 * Typed Swagger docs for a JSON success response, wrapped the way `TransformInterceptor` wraps it
 * on the wire: `{ data, traceId, timestamp }` (D-131). The `data` payload is a `$ref` to an
 * `@ApiProperty` response class, so clients (the Flutter app's strict `fromJson` models) get a
 * real schema instead of an example only.
 *
 *   `@ApiEnvelopeResponse(BootstrapResponse, { example })`                    -> data: $ref
 *   `@ApiEnvelopeResponse(DefectCatalogItemResponse, { isArray: true, ... })` -> data: array of $ref
 *   `@ApiEnvelopeResponse(SavedSignatureResponse, { nullable: true, ... })`   -> data: $ref | null
 *   `@ApiEnvelopeResponse([TripA, TripB], { discriminator: 'source', mapping: {...} })` -> data: oneOf
 *
 * `example` is the `data` payload only; the helper wraps it in the envelope so the documented
 * example is exactly what the client receives.
 */
export const ENVELOPE_TRACE_ID_EXAMPLE = '01J8X3QK9Z0000000000000000';
export const ENVELOPE_TIMESTAMP_EXAMPLE = '2026-10-08T15:41:00.000Z';

export interface ApiEnvelopeOptions {
  /** 200 (default) or 201 — must match what the route really answers (`@HttpCode`, POST = 201). */
  status?: 200 | 201;
  description?: string;
  isArray?: boolean;
  /** `data` may be `null` (documented as `nullable: true`). */
  nullable?: boolean;
  /** With several models: the discriminating property and its value -> model mapping. */
  discriminator?: { propertyName: string; mapping: Record<string, Type<unknown>> };
  /** The `data` payload as the route returns it. */
  example: unknown;
}

function dataSchema(models: Type<unknown>[], opts: ApiEnvelopeOptions): SchemaObject | ReferenceObject {
  const refs = models.map((model) => ({ $ref: getSchemaPath(model) }));
  let schema: SchemaObject | ReferenceObject;
  if (refs.length > 1) {
    schema = {
      oneOf: refs,
      ...(opts.discriminator
        ? {
            discriminator: {
              propertyName: opts.discriminator.propertyName,
              mapping: Object.fromEntries(
                Object.entries(opts.discriminator.mapping).map(([value, model]) => [value, getSchemaPath(model)]),
              ),
            },
          }
        : {}),
    };
  } else {
    schema = refs[0];
  }
  if (opts.isArray) return { type: 'array', items: schema };
  if (opts.nullable) return refs.length > 1 ? { ...(schema as SchemaObject), nullable: true } : { allOf: [schema], nullable: true };
  return schema;
}

export function envelopeSchema(models: Type<unknown>[], opts: ApiEnvelopeOptions): SchemaObject {
  return {
    type: 'object',
    required: ['data', 'traceId', 'timestamp'],
    properties: {
      data: dataSchema(models, opts),
      traceId: { type: 'string', description: 'Request trace id (same as the §20 error envelope).' },
      timestamp: { type: 'string', format: 'date-time' },
    },
    example: { data: opts.example, traceId: ENVELOPE_TRACE_ID_EXAMPLE, timestamp: ENVELOPE_TIMESTAMP_EXAMPLE },
  };
}

export function ApiEnvelopeResponse(
  model: Type<unknown> | Type<unknown>[],
  opts: ApiEnvelopeOptions,
): MethodDecorator & ClassDecorator {
  const models = Array.isArray(model) ? model : [model];
  return applyDecorators(
    ApiExtraModels(...models),
    ApiResponse({
      status: opts.status ?? 200,
      description: opts.description ?? (opts.status === 201 ? 'Created.' : 'OK.'),
      schema: envelopeSchema(models, opts),
    }),
  );
}
