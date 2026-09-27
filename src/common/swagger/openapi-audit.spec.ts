import type { OpenAPIObject } from '@nestjs/swagger';
import { auditOpenApiDocument } from './openapi-audit';
import { FIGMA_SCREENS } from '../decorators/figma-screens';

/** Minimal document factory — only the fields the auditor reads. */
function docWith(op: Record<string, unknown>, path = '/api/things'): OpenAPIObject {
  return { openapi: '3.0.0', info: { title: 't', version: '1' }, paths: { [path]: { get: op } } } as unknown as OpenAPIObject;
}

const goodOp = {
  summary: 'Lists things.',
  responses: {
    200: { description: 'ok', schema: { example: { items: [] } } },
    401: { description: 'UNAUTHORIZED', schema: { example: { code: 'UNAUTHORIZED' } } },
  },
  'x-figma-screens': [{ id: 'web/vehicles', title: 'Vehicles', source: 'x' }],
};

describe('auditOpenApiDocument (tasks.md Swagger + Figma global gates)', () => {
  it('accepts a fully documented operation', () => {
    const result = auditOpenApiDocument(docWith(goodOp));
    expect(result).toMatchObject({ operationCount: 1, figmaLinked: 1, problems: [], missingFigma: [] });
  });

  it('flags a missing summary', () => {
    const result = auditOpenApiDocument(docWith({ ...goodOp, summary: '   ' }));
    expect(result.problems).toEqual(['GET /api/things: missing @ApiOperation summary.']);
  });

  it('flags a 2xx response with no example', () => {
    const result = auditOpenApiDocument(
      docWith({ ...goodOp, responses: { 200: { description: 'ok' }, 401: { description: 'no' } } }),
    );
    expect(result.problems).toEqual([
      'GET /api/things: no example on any 2xx response (Swagger gate needs a concrete example).',
    ]);
  });

  it('accepts an example supplied through a content media type (file downloads)', () => {
    const result = auditOpenApiDocument(
      docWith({
        ...goodOp,
        responses: {
          200: { content: { 'text/csv': { schema: { type: 'string' }, example: 'Header,ONEB01\n' } } },
          403: { description: 'FORBIDDEN', schema: { example: {} } },
        },
      }),
    );
    expect(result.problems).toEqual([]);
  });

  it('flags an operation with no 2xx and no error response', () => {
    const result = auditOpenApiDocument(docWith({ ...goodOp, responses: {} }));
    expect(result.problems).toEqual([
      'GET /api/things: no documented 2xx response.',
      'GET /api/things: no documented error response (TZ §20 envelope).',
    ]);
  });

  it('flags a route with neither a Figma link nor a documented exemption', () => {
    const { 'x-figma-screens': _omitted, ...noFigma } = goodOp;
    const result = auditOpenApiDocument(docWith(noFigma));
    expect(result.missingFigma).toEqual(['GET /api/things']);
  });

  it('accepts an exempt route (FIGMA_UNMAPPED_ROUTES) without a link', () => {
    const { 'x-figma-screens': _omitted, ...noFigma } = goodOp;
    const result = auditOpenApiDocument(docWith(noFigma, '/health/live'));
    expect(result.missingFigma).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it('every registry screen cites the eld.docs export it was transcribed from', () => {
    for (const [id, screen] of Object.entries(FIGMA_SCREENS)) {
      expect(screen.title.length).toBeGreaterThan(0);
      expect(screen.source).toMatch(/^eld\.docs\//);
      expect(id).toMatch(/^web\//);
    }
  });
});
