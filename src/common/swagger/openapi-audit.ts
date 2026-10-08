import type { OpenAPIObject } from '@nestjs/swagger';
import { FIGMA_SCREEN_EXTENSION } from '../decorators/figma-screen.decorator';
import { FIGMA_UNMAPPED_ROUTES } from '../decorators/figma-screens';

/**
 * Auditor for the generated OpenAPI document — the machine-checkable half of two
 * tasks.md Global gates:
 *   · "All endpoints documented in Swagger, with example responses"
 *   · "Every new endpoint links to at least one Figma screen"
 *
 * Used by `scripts/generate-openapi.ts` (fails the script) and by
 * `test/e2e/openapi-contract.e2e-spec.ts` (fails CI). Keeping the rules in one place
 * means a new endpoint cannot satisfy one gate and quietly miss the other.
 */
export interface OpenApiAuditResult {
  operationCount: number;
  figmaLinked: number;
  /** Human-readable, one per violation. Empty = both gates hold for every operation. */
  problems: string[];
  /** `METHOD /path` for operations with no Figma link and no documented exemption. */
  missingFigma: string[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

type ResponseLike = {
  description?: string;
  schema?: { example?: unknown; examples?: unknown };
  content?: Record<string, { example?: unknown; examples?: unknown; schema?: { example?: unknown } }>;
};

function hasExample(response: ResponseLike | undefined): boolean {
  if (!response) return false;
  if (response.schema && (response.schema.example !== undefined || response.schema.examples !== undefined)) {
    return true;
  }
  for (const media of Object.values(response.content ?? {})) {
    if (media.example !== undefined || media.examples !== undefined) return true;
    if (media.schema && media.schema.example !== undefined) return true;
  }
  return false;
}

export function auditOpenApiDocument(doc: OpenAPIObject): OpenApiAuditResult {
  const problems: string[] = [];
  const missingFigma: string[] = [];
  let operationCount = 0;
  let figmaLinked = 0;

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as
        | {
            summary?: string;
            responses?: Record<string, ResponseLike>;
            [key: string]: unknown;
          }
        | undefined;
      if (!op) continue;

      operationCount += 1;
      const route = `${method.toUpperCase()} ${path}`;
      const responses = op.responses ?? {};
      const statuses = Object.keys(responses);
      const success = statuses.filter((s) => s.startsWith('2'));
      const failures = statuses.filter((s) => s.startsWith('4') || s.startsWith('5'));

      if (!op.summary || op.summary.trim() === '') {
        problems.push(`${route}: missing @ApiOperation summary.`);
      }
      if (success.length === 0) {
        problems.push(`${route}: no documented 2xx response.`);
      } else if (!success.some((s) => hasExample(responses[s]))) {
        problems.push(`${route}: no example on any 2xx response (Swagger gate needs a concrete example).`);
      }
      if (failures.length === 0) {
        problems.push(`${route}: no documented error response (TZ §20 envelope).`);
      }

      const screens = op[FIGMA_SCREEN_EXTENSION];
      if (Array.isArray(screens) && screens.length > 0) {
        figmaLinked += 1;
      } else if (!FIGMA_UNMAPPED_ROUTES[route]) {
        missingFigma.push(route);
        problems.push(`${route}: no @FigmaScreen link and no entry in FIGMA_UNMAPPED_ROUTES.`);
      }
    }
  }

  return { operationCount, figmaLinked, problems, missingFigma };
}

type SchemaLike = {
  $ref?: string;
  type?: string;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
  allOf?: SchemaLike[];
  oneOf?: SchemaLike[];
  anyOf?: SchemaLike[];
};

/** True for a schema a client can generate a model from: a `$ref`, an object with properties, a combinator or a typed array. */
function isTypedSchema(schema: SchemaLike | undefined): boolean {
  if (!schema) return false;
  if (schema.$ref) return true;
  for (const combinator of [schema.allOf, schema.oneOf, schema.anyOf]) {
    if (Array.isArray(combinator) && combinator.length > 0 && combinator.every((s) => isTypedSchema(s))) return true;
  }
  if (schema.type === 'array') return isTypedSchema(schema.items) || (!!schema.items?.type && schema.items.type !== 'object');
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    // The `{ data, traceId, timestamp }` envelope (D-131): the payload under `data` must be typed too.
    return 'data' in schema.properties ? isTypedSchema(schema.properties.data) : true;
  }
  return false;
}

/**
 * Mobile request #13 (D-131) — every 2xx response of the selected operations must carry a typed
 * schema (`$ref` / properties / combinator), not just an example, so the Flutter app can generate
 * strict `fromJson` models. Non-JSON bodies (CSV, PDF, octet-stream) need a `type`d schema.
 * Returns one human-readable problem per offending `METHOD /path status`.
 */
export function auditTypedResponses(doc: OpenAPIObject, select: (path: string) => boolean): { checked: number; problems: string[] } {
  const problems: string[] = [];
  let checked = 0;
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!select(path)) continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as { responses?: Record<string, ResponseLike> } | undefined;
      if (!op) continue;
      checked += 1;
      const route = `${method.toUpperCase()} ${path}`;
      const success = Object.entries(op.responses ?? {}).filter(([status]) => status.startsWith('2'));
      if (success.length === 0) problems.push(`${route}: no documented 2xx response.`);
      for (const [status, response] of success) {
        const media = Object.entries(response.content ?? {});
        if (media.length === 0) problems.push(`${route} ${status}: no response content/schema.`);
        for (const [mime, body] of media) {
          const schema = (body as { schema?: SchemaLike }).schema;
          const typed = mime.includes('json') ? isTypedSchema(schema) : Boolean(schema?.type);
          if (!typed) problems.push(`${route} ${status} ${mime}: schema is untyped (example only) — use @ApiEnvelopeResponse(Dto).`);
        }
      }
    }
  }
  return { checked, problems };
}
