/**
 * tasks.md Global gates:
 *   · "All endpoints documented in Swagger, with example responses"
 *   · "Every new endpoint links to at least one Figma screen"
 *
 * Builds the SAME OpenAPI document `main.ts` serves at `/docs` (via `buildOpenApiDocument`)
 * from the real AppModule, then asserts, for every operation: a summary, a 2xx response
 * carrying a concrete example, at least one documented error response (the TZ §20
 * envelope), and a `x-figma-screens` link — unless the route is listed, with a reason, in
 * `FIGMA_UNMAPPED_ROUTES`.
 *
 * A new controller therefore fails CI until it is documented, which is the only way these
 * gates stay true after this commit.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { FIGMA_SCREENS, FIGMA_UNMAPPED_ROUTES } from '../../src/common/decorators/figma-screens';
import { auditOpenApiDocument } from '../../src/common/swagger/openapi-audit';
import { buildOpenApiDocument, configureApp } from '../../src/main';

describe('OpenAPI document contract (e2e)', () => {
  let app: INestApplication;
  let audit: ReturnType<typeof auditOpenApiDocument>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    audit = auditOpenApiDocument(buildOpenApiDocument(app, 'api'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every operation with a summary, a 2xx example and a §20 error response', () => {
    expect(audit.operationCount).toBeGreaterThan(50);
    // Printed verbatim so a failure names the offending route instead of just a count.
    expect(audit.problems).toEqual([]);
  });

  it('links every operation to a Figma screen, or to a documented exemption', () => {
    expect(audit.missingFigma).toEqual([]);
    expect(audit.figmaLinked + Object.keys(FIGMA_UNMAPPED_ROUTES).length).toBeGreaterThanOrEqual(
      audit.operationCount,
    );
  });

  it('only uses Figma screen ids that exist in the registry', () => {
    const known = new Set(Object.keys(FIGMA_SCREENS));
    const doc = buildOpenApiDocument(app, 'api');
    const used = new Set<string>();
    for (const pathItem of Object.values(doc.paths ?? {})) {
      for (const op of Object.values(pathItem as Record<string, unknown>)) {
        const screens = (op as { 'x-figma-screens'?: { id: string }[] })?.['x-figma-screens'];
        if (Array.isArray(screens)) for (const s of screens) used.add(s.id);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((id) => !known.has(id))).toEqual([]);
  });
});
