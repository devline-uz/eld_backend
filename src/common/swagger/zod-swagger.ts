import type { INestApplication } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ModulesContainer } from '@nestjs/core';
import { ApiBody, ApiQuery, DECORATORS, type OpenAPIObject } from '@nestjs/swagger';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe';
import { isZodSchema, zodObjectFields, ZodSchemaRegistry } from './zod-openapi';
import type { ZodType } from 'zod';

/**
 * Documents every `@Body(zodBody(X))` / `@Query(zodBody(X))` in the OpenAPI document without
 * per-controller decorators (tasks.md Phase 13B, D-1xx in decisions.md).
 *
 * `applyZodSwagger(app)` runs before `SwaggerModule.createDocument`: it walks every controller
 * in the Nest container, reads the route-arg metadata Nest itself stores for `@Body`/`@Query`
 * (the pipe instances are kept there), pulls the zod schema out of each `ZodValidationPipe`, and
 * applies `@ApiBody` / `@ApiQuery` programmatically. Anything a controller already declares by
 * hand (an explicit `@ApiBody`, or an `@ApiQuery` with the same name) wins and is not duplicated —
 * except an example-only `@ApiBody`, which gets the zod schema and keeps its example (D-131).
 * `attachZodComponents(doc)` then adds the referenced DTOs to `components.schemas`.
 */

type RouteArg = { index: number; data?: unknown; pipes?: unknown[] };
type ExistingParam = {
  in?: string;
  name?: string;
  schema?: unknown;
  type?: unknown;
  enum?: unknown;
  required?: boolean;
  examples?: Record<string, { value: unknown }>;
};

const TYPED_SCHEMA_KEYS = ['$ref', 'type', 'properties', 'allOf', 'oneOf', 'anyOf', 'items'];

/** A declared schema that only holds an `example` (no `$ref`/`type`/`properties`/combinator). */
function isExampleOnly(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  return !TYPED_SCHEMA_KEYS.some((k) => k in (schema as Record<string, unknown>));
}

/** One registry per process: controller metadata is global, so names and $refs must be stable. */
let registry: ZodSchemaRegistry | undefined;
const processed = new WeakSet<object>();
const BODY_ARG: number = RouteParamtypes.BODY;
const QUERY_ARG: number = RouteParamtypes.QUERY;

function getRegistry(): ZodSchemaRegistry {
  if (!registry) {
    registry = new ZodSchemaRegistry();
    registerExportedSchemas(registry);
  }
  return registry;
}

/**
 * Names components after the exported DTO constant (`export const CreateTripDto = z.object(...)`)
 * by scanning the already-loaded `src/` modules. Unnamed schemas stay inline.
 */
function registerExportedSchemas(reg: ZodSchemaRegistry): void {
  // `require.cache` is empty under some loaders (e.g. Jest) — then every schema is inlined.
  const cache = (typeof require !== 'undefined' ? require.cache : {});
  const files = Object.keys(cache)
    .filter((f) => !f.includes('node_modules') && /[\\/](src|dist)[\\/]/.test(f))
    .sort();
  for (const file of files) {
    const exported = cache[file]?.exports as Record<string, unknown> | undefined;
    if (!exported || typeof exported !== 'object') continue;
    for (const [name, value] of Object.entries(exported)) {
      if (/^[A-Z]/.test(name) && isZodSchema(value)) reg.register(value, name);
    }
  }
}

function zodSchemaOf(pipes: unknown[] | undefined): ZodType | undefined {
  for (const pipe of pipes ?? []) {
    if (pipe instanceof ZodValidationPipe) {
      const schema = (pipe as unknown as { schema: unknown }).schema;
      if (isZodSchema(schema)) return schema;
    }
  }
  return undefined;
}

function applyToMethod(target: object, prototype: object, key: string, reg: ZodSchemaRegistry): void {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
  const handler = descriptor?.value as object | undefined;
  if (!descriptor || typeof handler !== 'function' || processed.has(handler)) return;
  processed.add(handler);

  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, key) as
    | Record<string, RouteArg>
    | undefined;
  if (!args) return;

  const existing = (): ExistingParam[] =>
    (Reflect.getMetadata(DECORATORS.API_PARAMETERS, handler) as ExistingParam[] | undefined) ?? [];

  for (const [argKey, arg] of Object.entries(args)) {
    const paramtype = Number(argKey.split(':')[0]);
    // Only whole-object DTOs: `@Body('field', pipe)` / `@Query('name', pipe)` are already named params.
    if (arg.data !== undefined) continue;
    const schema = zodSchemaOf(arg.pipes);
    if (!schema) continue;

    if (paramtype === BODY_ARG) {
      const declaredBody = existing().find((p) => p.in === 'body');
      if (declaredBody) {
        // D-131 — a hand-written `@ApiBody({ schema: { example } })` carries no type: keep its
        // example (as a media-type example) but document the zod DTO as the body schema.
        // (`ApiBody` fills `type: String` by default, so that value still means "no type given".)
        if (isExampleOnly(declaredBody.schema) && (declaredBody.type === undefined || declaredBody.type === String)) {
          const { example } = declaredBody.schema as { example?: unknown };
          declaredBody.schema = reg.toSchema(schema);
          declaredBody.required = true;
          if (example !== undefined) declaredBody.examples = { default: { value: example } };
        }
        continue;
      }
      ApiBody({ required: true, schema: reg.toSchema(schema) })(prototype, key, descriptor);
    } else if (paramtype === QUERY_ARG) {
      for (const field of zodObjectFields(schema)) {
        const fieldSchema = reg.toSchema(field.schema);
        const declared = existing().find((p) => p.in === 'query' && p.name === field.name);
        if (declared) {
          // A bare `@ApiQuery({ name })` renders as `schema: {}` — give it the zod type.
          if (declared.schema === undefined && declared.type === undefined && !declared.enum) {
            declared.schema = fieldSchema;
          }
          continue;
        }
        ApiQuery({
          name: field.name,
          required: field.required,
          schema: fieldSchema,
          ...('description' in fieldSchema && fieldSchema.description
            ? { description: fieldSchema.description }
            : {}),
        })(prototype, key, descriptor);
      }
    }
  }
}

/** Call before `SwaggerModule.createDocument`. Idempotent. */
export function applyZodSwagger(app: INestApplication): void {
  const reg = getRegistry();
  for (const moduleRef of app.get(ModulesContainer).values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const metatype = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
      if (!metatype?.prototype) continue;
      const prototype = metatype.prototype as object;
      for (const key of Object.getOwnPropertyNames(prototype)) {
        if (key === 'constructor') continue;
        applyToMethod(prototype, prototype, key, reg);
      }
    }
  }
}

/** Call after `SwaggerModule.createDocument`: adds every referenced DTO to `components.schemas`. */
export function attachZodComponents(doc: OpenAPIObject): OpenAPIObject {
  stripEnumComponentDescriptions(doc);
  const components = getRegistry().components;
  const sorted = Object.fromEntries(Object.keys(components).sort().map((k) => [k, components[k]]));
  doc.components = { ...doc.components, schemas: { ...doc.components?.schemas, ...sorted } };
  return doc;
}

/**
 * D-131 — `@nestjs/swagger` copies the `description` of the FIRST `@ApiProperty({ enumName })` it
 * meets onto the shared enum component (`DutyStatus` would read "Latest active duty status of the
 * co-driver."). The property keeps its own description next to the `$ref`, so the component's copy
 * is dropped. Only enum-only components produced by `@ApiProperty` are touched (zod components are
 * merged in afterwards).
 */
function stripEnumComponentDescriptions(doc: OpenAPIObject): void {
  for (const schema of Object.values(doc.components?.schemas ?? {})) {
    const s = schema as { enum?: unknown; properties?: unknown; description?: unknown };
    if (Array.isArray(s.enum) && s.properties === undefined && 'description' in s) delete s.description;
  }
}
