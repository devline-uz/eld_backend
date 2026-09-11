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
