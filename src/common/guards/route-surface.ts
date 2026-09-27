import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static inventory of the HTTP surface, read straight from the controller sources.
 *
 * Why static and not a Nest bootstrap: the question this answers is "does every route carry
 * an explicit authorization decision?", and a decorator that was never written cannot be
 * observed at runtime — an unguarded route simply succeeds. Parsing the source makes the
 * absence itself assertable, cheaply, in the unit project (no DB, no Redis).
 *
 * Consumed by `route-surface.spec.ts` (the permission-matrix coverage gate, tasks.md
 * "Permission test written for every role" / TZ §6.4).
 */
export interface RouteInfo {
  file: string;
  line: number;
  method: string;
  path: string;
  /** `METHOD controllerPath/handlerPath` — the stable identity used by the allowlist. */
  route: string;
  decorators: string[];
  perm?: { key: string; level: string };
  isPublic: boolean;
  driverOnly: boolean;
  audited: boolean;
}

const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options']);

/** Reads a decorator starting at `@`, consuming balanced (), [] and {} so multi-line
 * `@ApiOkResponse({ ... })` blocks do not break decorator grouping. */
function readDecorator(text: string, start: number): { source: string; end: number } {
  let i = start + 1;
  while (i < text.length && /[\w.]/.test(text[i])) i += 1;
  if (text[i] !== '(') return { source: text.slice(start, i), end: i };
  let depth = 0;
  let inString: string | null = null;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inString = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return { source: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return { source: text.slice(start), end: text.length };
}

function firstStringArg(decorator: string): string {
  const match = /\(\s*'([^']*)'/.exec(decorator);
  return match ? match[1] : '';
}

function decoratorName(decorator: string): string {
  const match = /^@([\w.]+)/.exec(decorator);
  return match ? match[1] : '';
}

function joinPath(controllerPath: string, handlerPath: string): string {
  const parts = [controllerPath, handlerPath].filter(Boolean).join('/');
  return `/${parts.replace(/\/+/g, '/').replace(/^\/|\/$/g, '')}`;
}

/** Parses one controller file into its routes. */
export function parseController(source: string, file: string): RouteInfo[] {
  const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
  const routes: RouteInfo[] = [];
  // Comments blanked out, positions preserved: used to decide whether two decorators are
  // adjacent, so an explanatory comment between them does not split a handler's run.
  const uncommented = stripComments(source);

  // Decorators in source order, each with its position.
  const decorators: Array<{ source: string; at: number; after: number }> = [];
  let i = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < source.length) {
    const ch = source[i];
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && source[i + 1] === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inString) {
      if (ch === '\\') i += 2;
      else {
        if (ch === inString) inString = null;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === '@') {
      const { source: decoratorSource, end } = readDecorator(source, i);
      decorators.push({ source: decoratorSource, at: i, after: end });
      i = end;
      continue;
    }
    i += 1;
  }

  const controllerDecorator = decorators.find((d) => decoratorName(d.source) === 'Controller');
  const controllerPath = controllerDecorator ? firstStringArg(controllerDecorator.source) : '';
  const classIndex = source.indexOf('export class');
  const classDecorators = decorators.filter((d) => d.at < classIndex).map((d) => d.source);

  for (let index = 0; index < decorators.length; index += 1) {
    const current = decorators[index];
    if (current.at < classIndex) continue;
    const name = decoratorName(current.source);
    if (!HTTP_DECORATORS.has(name)) continue;

    // Own decorators: the contiguous run this HTTP decorator belongs to. Walk backwards over
    // decorators separated only by whitespace, and forwards the same way — a handler
    // signature (non-whitespace, non-decorator text) ends the run.
    const own = [current.source];
    for (let back = index - 1; back >= 0; back -= 1) {
      const between = uncommented.slice(decorators[back].after, decorators[back + 1].at);
      if (between.trim() !== '' || decorators[back].at < classIndex) break;
      if (HTTP_DECORATORS.has(decoratorName(decorators[back].source))) break;
      own.push(decorators[back].source);
    }
    for (let forward = index + 1; forward < decorators.length; forward += 1) {
      const between = uncommented.slice(decorators[forward - 1].after, decorators[forward].at);
      if (between.trim() !== '') break;
      if (HTTP_DECORATORS.has(decoratorName(decorators[forward].source))) break;
      own.push(decorators[forward].source);
    }

    const all = [...classDecorators, ...own];
    // B-13 — `@PermAny(['vehicles', 'FULL'], ['trips', 'FULL'])` is still an explicit
    // authorization decision; its first pair stands in for `route.perm` below (this
    // surface only needs "is the route decided", not the full OR-set).
    const permDecorator = own.find((d) => decoratorName(d) === 'Perm' || decoratorName(d) === 'PermAny') ??
      classDecorators.find((d) => decoratorName(d) === 'Perm' || decoratorName(d) === 'PermAny');
    const permMatch = permDecorator
      ? /\(\s*\[?\s*'([^']*)'\s*,\s*'([^']*)'/.exec(permDecorator)
      : null;

    routes.push({
      file,
      line: lineOf(current.at),
      method: name.toUpperCase(),
      path: joinPath(controllerPath, firstStringArg(current.source)),
      route: `${name.toUpperCase()} ${joinPath(controllerPath, firstStringArg(current.source))}`,
      decorators: all.map((d) => decoratorName(d)),
      perm: permMatch ? { key: permMatch[1], level: permMatch[2] } : undefined,
      isPublic: all.some((d) => decoratorName(d) === 'Public'),
      driverOnly: all.some((d) => decoratorName(d) === 'UseGuards' && d.includes('DriverGuard')),
      audited: all.some((d) => decoratorName(d) === 'Audit'),
    });
  }

  return routes;
}

/** Replaces every comment with spaces, keeping every other character at its original index. */
export function stripComments(source: string): string {
  const out = source.split('');
  let i = 0;
  let inString: string | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === inString) inString = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

/** Every route of every `*.controller.ts` under `src/`. */
export function collectRoutes(srcDir: string = join(__dirname, '..', '..')): RouteInfo[] {
  return walk(srcDir)
    .sort()
    .flatMap((file) => parseController(readFileSync(file, 'utf8'), file.slice(file.indexOf('src/'))));
}
