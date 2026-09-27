import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';
import { ZodFirstPartyTypeKind, ZodType } from 'zod';

/**
 * zod (v3) → OpenAPI 3.0 schema converter — tasks.md Phase 13B / backend_tasks.md [1].
 *
 * Every request DTO in this codebase is a zod schema (TZ §6.5), which `@nestjs/swagger` cannot
 * see, so the document had no `requestBody`, no query params for `@Query(zodBody(...))` and no
 * `components.schemas`. This converter documents the **input** side of a schema (what a client
 * sends): `.transform()`/`.refine()` are transparent, `.default()` makes a field optional,
 * `.nullable()` becomes OpenAPI 3.0 `nullable: true` (B-1/B-3 on the web side).
 *
 * Named schemas (exported DTO constants, see `ZodSchemaRegistry`) are emitted once into
 * `components.schemas` and referenced by `$ref`, including when nested inside another DTO.
 */
export type OpenApiSchema = SchemaObject | ReferenceObject;

/** Loose view of a zod v3 `_def`; the fields we read vary by `typeName`. */
type AnyDef = { typeName: ZodFirstPartyTypeKind; [key: string]: unknown };
type ZodCheck = { kind: string; value?: unknown; inclusive?: boolean; regex?: RegExp };

const MAX_DEPTH = 24;

export class ZodSchemaRegistry {
  /** schema instance → component name (exported DTO name). */
  private readonly names = new Map<ZodType, string>();
  /** component name → emitted schema, filled lazily as schemas are referenced. */
  readonly components: Record<string, SchemaObject> = {};
  private readonly emitting = new Set<string>();

  /** Registers `schema` under `name`; a name clash with a different schema gets a numeric suffix. */
  register(schema: ZodType, name: string): string {
    const existing = this.names.get(schema);
    if (existing) return existing;
    const taken = new Set(this.names.values());
    let unique = name;
    for (let i = 2; taken.has(unique); i += 1) unique = `${name}${i}`;
    this.names.set(schema, unique);
    return unique;
  }

  nameOf(schema: ZodType): string | undefined {
    return this.names.get(schema);
  }

  /** `$ref` to the component for a named schema (emitting it on first use), or an inline schema. */
  toSchema(schema: ZodType): OpenApiSchema {
    const name = this.names.get(schema);
    if (!name) return convert(schema, this, 0);
    this.emit(name, schema);
    return { $ref: `#/components/schemas/${name}` };
  }

  private emit(name: string, schema: ZodType): void {
    if (this.components[name] || this.emitting.has(name)) return;
    this.emitting.add(name);
    this.components[name] = convert(schema, this, 0, true) as SchemaObject;
    this.emitting.delete(name);
  }
}

/** Unwraps optional/default/effects/etc. to the node that carries the object shape. */
export function unwrapZod(schema: ZodType): ZodType {
  let cur: ZodType = schema;
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    const def = cur._def as AnyDef;
    switch (def.typeName) {
      case ZodFirstPartyTypeKind.ZodOptional:
      case ZodFirstPartyTypeKind.ZodNullable:
      case ZodFirstPartyTypeKind.ZodDefault:
      case ZodFirstPartyTypeKind.ZodCatch:
      case ZodFirstPartyTypeKind.ZodReadonly:
        cur = def.innerType as ZodType;
        break;
      case ZodFirstPartyTypeKind.ZodBranded:
        cur = def.type as ZodType;
        break;
      case ZodFirstPartyTypeKind.ZodEffects:
        cur = def.schema as ZodType;
        break;
      case ZodFirstPartyTypeKind.ZodPipeline:
        cur = def.in as ZodType;
        break;
      case ZodFirstPartyTypeKind.ZodLazy:
        cur = (def.getter as () => ZodType)();
        break;
      default:
        return cur;
    }
  }
  return cur;
}

/** True when a client may omit the field (`.optional()`, `.default()`, accepts `undefined`). */
export function isZodOptional(schema: ZodType): boolean {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

/**
 * Top-level fields of an object-like schema (object, `.merge`, `.and`, effects around an
 * object, union of objects). Used to spread a query DTO into individual `in: query` params.
 */
export function zodObjectFields(schema: ZodType): Array<{ name: string; schema: ZodType; required: boolean }> {
  const node = unwrapZod(schema);
  const def = node._def as AnyDef;
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def.shape as () => Record<string, ZodType>)();
      return Object.entries(shape).map(([name, s]) => ({ name, schema: s, required: !isZodOptional(s) }));
    }
    case ZodFirstPartyTypeKind.ZodIntersection:
      return mergeFields([
        ...zodObjectFields(def.left as ZodType),
        ...zodObjectFields(def.right as ZodType),
      ]);
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = [...((def.options as Iterable<ZodType>) ?? [])];
      // A field present in only some branches is never required.
      return mergeFields(options.flatMap((o) => zodObjectFields(o))).map((f) => ({ ...f, required: false }));
    }
    default:
      return [];
  }
}

function mergeFields(
  fields: Array<{ name: string; schema: ZodType; required: boolean }>,
): Array<{ name: string; schema: ZodType; required: boolean }> {
  const byName = new Map<string, { name: string; schema: ZodType; required: boolean }>();
  for (const f of fields) {
    const prev = byName.get(f.name);
    byName.set(f.name, prev ? { ...prev, required: prev.required && f.required } : f);
  }
  return [...byName.values()];
}

function withNullable(schema: OpenApiSchema): OpenApiSchema {
  if ('$ref' in schema) return { allOf: [schema], nullable: true };
  return { ...schema, nullable: true };
}

function checksOf(def: AnyDef): ZodCheck[] {
  return (def.checks as ZodCheck[] | undefined) ?? [];
}

function convertString(def: AnyDef): SchemaObject {
  const out: SchemaObject = { type: 'string' };
  for (const c of checksOf(def)) {
    switch (c.kind) {
      case 'min':
        out.minLength = c.value as number;
        break;
      case 'max':
        out.maxLength = c.value as number;
        break;
      case 'length':
        out.minLength = c.value as number;
        out.maxLength = c.value as number;
        break;
      case 'email':
      case 'uuid':
      case 'uri':
        out.format = c.kind;
        break;
      case 'url':
        out.format = 'uri';
        break;
      case 'datetime':
        out.format = 'date-time';
        break;
      case 'date':
        out.format = 'date';
        break;
      case 'time':
        out.format = 'time';
        break;
      case 'ip':
        out.format = 'ip';
        break;
      case 'regex':
        if (c.regex) out.pattern = c.regex.source;
        break;
      default:
        break;
    }
  }
  return out;
}

function convertNumber(def: AnyDef): SchemaObject {
  const out: SchemaObject = { type: 'number' };
  for (const c of checksOf(def)) {
    if (c.kind === 'int') out.type = 'integer';
    else if (c.kind === 'min') {
      out.minimum = c.value as number;
      if (c.inclusive === false) out.exclusiveMinimum = true;
    } else if (c.kind === 'max') {
      out.maximum = c.value as number;
      if (c.inclusive === false) out.exclusiveMaximum = true;
    } else if (c.kind === 'multipleOf') out.multipleOf = c.value as number;
  }
  return out;
}

function literalSchema(value: unknown): SchemaObject {
  if (value === null) return { nullable: true, enum: [null] };
  const t = typeof value;
  const type = t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
  return { type, enum: [value] };
}

function convert(schema: ZodType, reg: ZodSchemaRegistry, depth: number, root = false): OpenApiSchema {
  if (depth > MAX_DEPTH) return {};
  // Nested named DTOs become $refs so shared shapes appear once in components.schemas.
  if (!root && depth > 0 && reg.nameOf(schema)) return reg.toSchema(schema);

  const def = schema._def as AnyDef;
  const next = (s: ZodType): OpenApiSchema => convert(s, reg, depth + 1);
  const description = typeof def.description === 'string' ? def.description : undefined;
  const out = convertNode(def, next);
  if (description && !('$ref' in out)) out.description = description;
  return out;
}

function convertNode(def: AnyDef, next: (s: ZodType) => OpenApiSchema): OpenApiSchema {
  switch (def.typeName) {
    case ZodFirstPartyTypeKind.ZodString:
      return convertString(def);
    case ZodFirstPartyTypeKind.ZodNumber:
      return convertNumber(def);
    case ZodFirstPartyTypeKind.ZodBigInt:
      return { type: 'integer', format: 'int64' };
    case ZodFirstPartyTypeKind.ZodBoolean:
      return { type: 'boolean' };
    case ZodFirstPartyTypeKind.ZodDate:
      return { type: 'string', format: 'date-time' };
    case ZodFirstPartyTypeKind.ZodNull:
      return { nullable: true, enum: [null] };
    case ZodFirstPartyTypeKind.ZodAny:
    case ZodFirstPartyTypeKind.ZodUnknown:
    case ZodFirstPartyTypeKind.ZodUndefined:
    case ZodFirstPartyTypeKind.ZodVoid:
    case ZodFirstPartyTypeKind.ZodNever:
      return {};
    case ZodFirstPartyTypeKind.ZodLiteral:
      return literalSchema(def.value);
    case ZodFirstPartyTypeKind.ZodEnum:
      return { type: 'string', enum: [...(def.values as string[])] };
    case ZodFirstPartyTypeKind.ZodNativeEnum: {
      const obj = def.values as Record<string, string | number>;
      // TS numeric enums carry reverse mappings; keep only the real values.
      const values = Object.keys(obj)
        .filter((k) => typeof obj[obj[k]] !== 'number')
        .map((k) => obj[k]);
      return { type: values.every((v) => typeof v === 'number') ? 'number' : 'string', enum: values };
    }
    case ZodFirstPartyTypeKind.ZodObject: {
      const shape = (def.shape as () => Record<string, ZodType>)();
      const properties: Record<string, OpenApiSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = next(value);
        if (!isZodOptional(value)) required.push(key);
      }
      const out: SchemaObject = { type: 'object', properties };
      if (required.length) out.required = required;
      const catchall = def.catchall as ZodType | undefined;
      const catchallKind = (catchall?._def as AnyDef | undefined)?.typeName;
      if (catchall && catchallKind !== ZodFirstPartyTypeKind.ZodNever) out.additionalProperties = next(catchall);
      else if (def.unknownKeys === 'passthrough') out.additionalProperties = true;
      return out;
    }
    case ZodFirstPartyTypeKind.ZodArray: {
      const out: SchemaObject = { type: 'array', items: next(def.type as ZodType) };
      const min = def.minLength as { value: number } | null;
      const max = def.maxLength as { value: number } | null;
      const exact = def.exactLength as { value: number } | null;
      if (min) out.minItems = min.value;
      if (max) out.maxItems = max.value;
      if (exact) out.minItems = out.maxItems = exact.value;
      return out;
    }
    case ZodFirstPartyTypeKind.ZodSet:
      return { type: 'array', uniqueItems: true, items: next(def.valueType as ZodType) };
    case ZodFirstPartyTypeKind.ZodTuple: {
      const items = (def.items as ZodType[]).map(next);
      return { type: 'array', minItems: items.length, maxItems: items.length, items: items.length === 1 ? items[0] : { oneOf: items } };
    }
    case ZodFirstPartyTypeKind.ZodRecord:
    case ZodFirstPartyTypeKind.ZodMap:
      return { type: 'object', additionalProperties: next(def.valueType as ZodType) };
    case ZodFirstPartyTypeKind.ZodUnion:
    case ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
      const options = [...(def.options as Iterable<ZodType>)];
      const nonNull = options.filter((o) => (o._def as AnyDef).typeName !== ZodFirstPartyTypeKind.ZodNull);
      const branches = nonNull.map(next);
      const out: OpenApiSchema = branches.length === 1 ? branches[0] : { oneOf: branches };
      if (typeof def.discriminator === 'string' && !('$ref' in out)) {
        (out).discriminator = { propertyName: def.discriminator };
      }
      return nonNull.length < options.length ? withNullable(out) : out;
    }
    case ZodFirstPartyTypeKind.ZodIntersection:
      return { allOf: [next(def.left as ZodType), next(def.right as ZodType)] };
    case ZodFirstPartyTypeKind.ZodOptional:
    case ZodFirstPartyTypeKind.ZodReadonly:
    case ZodFirstPartyTypeKind.ZodCatch:
      return next(def.innerType as ZodType);
    case ZodFirstPartyTypeKind.ZodNullable:
      return withNullable(next(def.innerType as ZodType));
    case ZodFirstPartyTypeKind.ZodDefault: {
      const inner = next(def.innerType as ZodType);
      const value = (def.defaultValue as () => unknown)();
      if ('$ref' in inner || value instanceof Date || typeof value === 'function') return inner;
      return { ...inner, default: value };
    }
    case ZodFirstPartyTypeKind.ZodBranded:
      return next(def.type as ZodType);
    case ZodFirstPartyTypeKind.ZodEffects:
      return next(def.schema as ZodType);
    case ZodFirstPartyTypeKind.ZodPipeline:
      return next(def.in as ZodType);
    case ZodFirstPartyTypeKind.ZodLazy:
      return next((def.getter as () => ZodType)());
    case ZodFirstPartyTypeKind.ZodPromise:
      return next(def.type as ZodType);
    default:
      return {};
  }
}

/** Duck-typed check that also works across duplicate zod copies. */
export function isZodSchema(value: unknown): value is ZodType {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === 'function' &&
    typeof ((value as { _def?: { typeName?: unknown } })._def?.typeName) === 'string'
  );
}
