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
 *
 * Mobile request #13 (D-131): every 2xx of a route the driver app calls (`/mobile/*`, the driver
 * auth routes, `/notifications`) must also carry a TYPED schema — the Flutter app writes strict
 * `fromJson` models from it — not only an example.
 */
import { INestApplication, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { FIGMA_SCREENS, FIGMA_UNMAPPED_ROUTES } from '../../src/common/decorators/figma-screens';
import { auditOpenApiDocument, auditTypedResponses } from '../../src/common/swagger/openapi-audit';
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

  it('gives every 2xx of the routes the driver app calls a typed schema, not only an example', () => {
    const doc = buildOpenApiDocument(app, 'api');
    const appRoute = (path: string) =>
      /^(\/api)?\/(mobile\/|notifications(\/|$)|auth\/(login\/driver|me|refresh)$)/.test(path);
    const typed = auditTypedResponses(doc, appRoute);
    expect(typed.checked).toBeGreaterThan(55);
    expect(typed.problems).toEqual([]);

    // Every `$ref` the typed responses use resolves to a component.
    const schemas = doc.components?.schemas ?? {};
    const refs = new Set<string>();
    JSON.stringify(doc.paths, (key, value: unknown) => {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      return value;
    });
    JSON.stringify(schemas, (key, value: unknown) => {
      if (key === '$ref' && typeof value === 'string') refs.add(value);
      return value;
    });
    const missing = [...refs].filter((ref) => !(ref.replace('#/components/schemas/', '') in schemas));
    expect(missing).toEqual([]);
  });

  it('documents, for every route the driver app calls, the 2xx status Nest really answers (POST = 201 unless @HttpCode)', () => {
    const doc = buildOpenApiDocument(app, 'api');
    const mismatches: string[] = [];
    let checked = 0;
    for (const moduleRef of app.get(ModulesContainer).values()) {
      for (const wrapper of moduleRef.controllers.values()) {
        const metatype = wrapper.metatype as (new (...a: unknown[]) => unknown) | null;
        if (!metatype?.prototype) continue;
        const base = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
        for (const key of Object.getOwnPropertyNames(metatype.prototype)) {
          const handler = (metatype.prototype as Record<string, unknown>)[key];
          if (key === 'constructor' || typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (method === undefined) continue;
          const path = `/api/${base}/${String(Reflect.getMetadata(PATH_METADATA, handler) ?? '')}`
            .replace(/\/+/g, '/')
            .replace(/\/$/, '')
            .replace(/:([A-Za-z]+)/g, '{$1}');
          if (!/^\/api\/(mobile\/|notifications(\/|$)|auth\/(login\/driver|me|refresh)$)/.test(path)) continue;
          checked += 1;
          const status = String((Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined) ?? (method === RequestMethod.POST ? 201 : 200));
          const op = (doc.paths[path] as Record<string, { responses?: Record<string, unknown> }> | undefined)?.[RequestMethod[method].toLowerCase()];
          const documented = Object.keys(op?.responses ?? {}).filter((s) => s.startsWith('2'));
          if (!documented.includes(status)) mismatches.push(`${RequestMethod[method]} ${path}: answers ${status}, documents ${documented.join(',') || 'nothing'}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(55);
    expect(mismatches).toEqual([]);
  });

  it('documents POST /mobile/conversations with the StartConversationDto body schema', () => {
    const doc = buildOpenApiDocument(app, 'api');
    const path = Object.keys(doc.paths).find((p) => /\/mobile\/conversations$/.test(p)) as string;
    const body = (doc.paths[path].post?.requestBody as { content: Record<string, { schema: Record<string, unknown> }> }).content['application/json'];
    expect(body.schema.$ref ?? body.schema.properties).toBeDefined();
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
