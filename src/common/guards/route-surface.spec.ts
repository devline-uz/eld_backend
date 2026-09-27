/**
 * TZ §6.4 / tasks.md global gate "Permission test written for every role" — the
 * authorization-coverage gate for the whole HTTP surface.
 *
 * Every route must make an explicit authorization decision: a `@Perm(key, level)`, a
 * `@Public()` (and then it must be in the reviewed public list below), or `DriverGuard` plus
 * self-scoping inside the service. A route that carries none of those is reachable by ANY
 * bearer token — including an API key with an empty `scopes` array — which is how
 * `POST /logs/edit-requests/:id/accept` was able to let a back-office caller activate a
 * carrier edit without the driver (bugs.md). If this test fails after you add a route, add
 * the decorator; do not add the route to an allowlist without writing the reason.
 */
import { PERMISSION_KEYS } from '../decorators/permission.types';
import { collectRoutes, parseController, stripComments } from './route-surface';

const routes = collectRoutes();

/** Unauthenticated by design (TZ §6.3 login family, §22.5 probes). Exact list, not a filter. */
const PUBLIC_ROUTES = new Set([
  'POST /auth/login',
  'POST /auth/login/driver',
  'POST /auth/google',
  'POST /auth/refresh',
  'POST /auth/password/forgot',
  'POST /auth/password/reset',
  // B-84 — email re-verification token is self-authenticating (same convention as
  // password/reset above); no bearer token exists yet if the caller followed the link cold.
  'POST /auth/email/verify',
  'GET /health/live',
  'GET /health/ready',
  'GET /health/deep',
  'GET /metrics',
]);

/**
 * Authenticated but deliberately not permission-gated, because the route only ever touches
 * the CALLER'S OWN data and the service derives the subject from the token, never from a path
 * or body parameter. Each entry is a reviewed decision, not a TODO.
 */
const SELF_SCOPED_ROUTES = new Map<string, string>([
  ['POST /auth/logout', 'Revokes the caller\'s own session family.'],
  ['GET /auth/me', 'Echoes the caller\'s own token claims.'],
  ['GET /me/profile', 'Caller own profile, id taken from the token claims.'],
  ['PATCH /me/profile', 'Caller\'s own name/phone only — never role.'],
  ['GET /me/sessions', 'Caller\'s own sessions.'],
  ['DELETE /me/sessions', 'B-50 "Sign out everywhere" — every OTHER session of the caller, never another user\'s.'],
  ['DELETE /me/sessions/:id', 'Session id is scoped to the caller inside AuthService.'],
  ['POST /me/avatar', 'B-51 — caller\'s own avatar, id taken from the token claims.'],
  ['DELETE /me/avatar', 'B-51 — caller\'s own avatar, id taken from the token claims.'],
  ['GET /me/preferences', 'B-11 — caller\'s own preferences, id taken from the token claims.'],
  ['PUT /me/preferences', 'B-11 — caller\'s own preferences, id taken from the token claims.'],
  ['GET /notifications', 'Caller\'s own inbox (§14 bell icon).'],
  ['POST /notifications/read-all', 'Caller\'s own inbox.'],
  ['POST /notifications/:id/read', 'B-56 — repo update is filtered by the caller\'s own userId/driverId; a foreign id is 404.'],
  [
    'GET /attachments/:id/presign',
    'B-41 — AttachmentsService.mayView walks the owning DVIR/defect/ticket: owning driver, dvir/support READ, or the ticket author; unknown owner chain and foreign ids are 404 (D-096).',
  ],
  [
    'POST /logs/:driverId/certify',
    'A driver certifies their own day (`driverId` from the token); any other principal is treated as on-behalf and needs hosCertifyOnBehalf = FULL inside LogsService.',
  ],
]);

/** Mutating routes whose audit row is written by the service, not the `@Audit` interceptor
 * (they append §395 records or an eRODS transfer row and need the richer before/after). */
const SERVICE_AUDITED_ROUTES = new Set([
  'POST /logs/:driverId/edit-requests',
  'POST /logs/:driverId/events', // B-72 — LogsService.proposeEvent writes LOG_EVENT_PROPOSED
  'POST /transfers',
  'POST /unidentified/:id/assign',
  'POST /unidentified/:id/annotate',
  'POST /unidentified/:id/reject',
  'POST /violations/:id/resolve',
  'POST /integrations/webhook/test',
]);

/** Mutations deliberately gated at READ (tz.md §20 B-12): a user who can only *view* support
 * may still open a ticket/chat or leave feedback about the product — the row is their own and
 * carries no fleet data. Everything else that writes needs FULL. */
const READ_LEVEL_MUTATIONS = new Set(['POST /support/tickets', 'POST /support/chats', 'POST /feedback']);

describe('HTTP surface: every route makes an authorization decision', () => {
  it('found the whole controller surface', () => {
    expect(routes.length).toBeGreaterThan(150);
    expect(new Set(routes.map((route) => route.file)).size).toBeGreaterThan(30);
  });

  it('has no route without @Perm, @Public or DriverGuard outside the reviewed self-scoped list', () => {
    const undecided = routes
      .filter((route) => !route.perm && !route.isPublic && !route.driverOnly)
      .filter((route) => !SELF_SCOPED_ROUTES.has(route.route))
      .map((route) => `${route.route} (${route.file}:${route.line})`);
    expect(undecided).toEqual([]);
  });

  it('keeps the unauthenticated surface exactly as reviewed', () => {
    const actual = routes.filter((route) => route.isPublic).map((route) => route.route);
    expect(new Set(actual)).toEqual(PUBLIC_ROUTES);
    // A public route must never also claim a permission — that combination silently wins for
    // the attacker (JwtAuthGuard returns early and PermissionGuard never sees a principal).
    expect(routes.filter((route) => route.isPublic && route.perm)).toEqual([]);
  });

  it('only uses permission keys that exist in the matrix', () => {
    const known = new Set<string>(PERMISSION_KEYS);
    const bad = routes
      .filter((route) => route.perm && !known.has(route.perm.key))
      .map((route) => `${route.route} -> ${route.perm?.key}`);
    expect(bad).toEqual([]);
    const levels = new Set(routes.filter((r) => r.perm).map((route) => route.perm!.level));
    expect([...levels].sort()).toEqual(['FULL', 'READ']);
  });

  it('never gates a mutation with a READ-level permission', () => {
    const weak = routes
      .filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method))
      .filter((route) => route.perm?.level === 'READ')
      .filter((route) => !READ_LEVEL_MUTATIONS.has(route.route))
      .map((route) => route.route);
    expect(weak).toEqual([]);
  });

  it('audits every permission-gated mutation, by decorator or by the service', () => {
    const unaudited = routes
      .filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method))
      .filter((route) => route.perm && !route.audited && !SERVICE_AUDITED_ROUTES.has(route.route))
      .map((route) => `${route.route} (${route.file}:${route.line})`);
    expect(unaudited).toEqual([]);
  });

  it('keeps ingest and every mobile write on a driver token only', () => {
    const mustBeDriverOnly = routes.filter(
      (route) =>
        route.path.startsWith('/ingest') ||
        (route.path.startsWith('/mobile') && route.method === 'POST'),
    );
    expect(mustBeDriverOnly.length).toBeGreaterThan(8);
    expect(mustBeDriverOnly.filter((route) => !route.driverOnly).map((r) => r.route)).toEqual([]);
  });

  it('keeps the §395.30 accept/reject pair on a driver token only', () => {
    for (const route of ['POST /logs/edit-requests/:id/accept', 'POST /logs/edit-requests/:id/reject']) {
      const found = routes.find((candidate) => candidate.route === route);
      expect(found).toBeDefined();
      expect(found!.driverOnly).toBe(true);
    }
  });
});

describe('route-surface parser', () => {
  const sample = `
import { Controller, Get, Post } from '@nestjs/common';
@ApiTags('things')
@Controller('things')
export class ThingsController {
  @Get(':id')
  @Perm('vehicles', 'READ')
  @ApiOkResponse({ schema: { example: { nested: '@Perm(\\'nope\\', \\'FULL\\')' } } })
  find(@Param('id') id: string) { return id; }

  @Post()
  // an explanatory comment must not detach the guard below from the route above
  @UseGuards(DriverGuard)
  @Audit({ object: 'Thing', action: 'CREATE' })
  create() { return 1; }

  @Public()
  @Delete(':id')
  remove() { return 2; }
}
`;
  const parsed = parseController(sample, 'things.controller.ts');

  it('reads the method, the joined path, the permission and the guard of each route', () => {
    expect(parsed.map((route) => route.route)).toEqual([
      'GET /things/:id',
      'POST /things',
      'DELETE /things/:id',
    ]);
    expect(parsed[0].perm).toEqual({ key: 'vehicles', level: 'READ' });
  });

  it('does not attribute a decorator mentioned inside a string to the route', () => {
    expect(parsed[0].perm?.key).toBe('vehicles');
  });

  it('sees a guard that is separated from its route by a comment', () => {
    expect(parsed[1].driverOnly).toBe(true);
    expect(parsed[1].audited).toBe(true);
    expect(parsed[1].perm).toBeUndefined();
  });

  it('sees a decorator written above the HTTP method decorator', () => {
    expect(parsed[2].isPublic).toBe(true);
  });

  it('blanks comments without moving any other character', () => {
    const source = "const a = 1; // note\n/* block */ const b = 2;";
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    expect(stripped).toContain('const a = 1;');
    expect(stripped).not.toContain('note');
    expect(stripped).not.toContain('block');
  });
});
