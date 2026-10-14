import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Lint guard: Prisma passes `equals` (insensitive) / `contains` / `startsWith` / `endsWith` values
 * into LIKE / ILIKE unescaped, so every such filter in `src/` must be built by
 * `common/text/insensitive.ts` (which escapes `\`, `%`, `_`). Raw SQL LIKE must carry an explicit
 * `ESCAPE` and an `escapeLike`d parameter.
 */
const SRC = join(__dirname, '..', '..');
const HELPER = 'common/text/insensitive.ts';

/** `path` -> why a hit there is fine. Keep this short; prefer the helpers. */
const ALLOWLIST: Record<string, string> = {};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
  });
}

/** Drops block and line comments (good enough for this code base: no `//` inside strings that matter). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const RULES: Array<{ name: string; re: RegExp; ok?: (line: string) => boolean }> = [
  { name: "mode: 'insensitive'", re: /\bmode\s*:\s*(['"]insensitive['"]|(Prisma\.)?QueryMode\.insensitive)/ },
  { name: 'contains/startsWith/endsWith filter', re: /\b(contains|startsWith|endsWith)\s*:/ },
  { name: 'raw SQL LIKE without ESCAPE', re: /\bI?LIKE\b/, ok: (line) => /\bESCAPE\b/.test(line) },
];

function findViolations(): string[] {
  const out: string[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (rel === HELPER || ALLOWLIST[rel]) continue;
    stripComments(readFileSync(file, 'utf8'))
      .split('\n')
      .forEach((line, i) => {
        for (const rule of RULES) if (rule.re.test(line) && !rule.ok?.(line)) out.push(`${rel}:${i + 1} ${rule.name}: ${line.trim()}`);
      });
  }
  return out;
}

describe('LIKE-filter guard (src/ must use common/text/insensitive.ts)', () => {
  it('finds no hand-built insensitive / LIKE-based string filters', () => {
    expect(walk(SRC).length).toBeGreaterThan(100); // really scanning src/
    expect(findViolations()).toEqual([]);
  });

  it('detects the patterns it guards against', () => {
    const probe = [
      "where: { number: { equals: n, mode: 'insensitive' } }",
      'where: { vin: { contains: q } }',
      'where: { serial: { startsWith: s } }',
      'Prisma.sql`SELECT 1 WHERE x ILIKE ${q}`',
    ];
    for (const line of probe) expect(RULES.some((r) => r.re.test(line) && !r.ok?.(line))).toBe(true);
    expect(RULES.some((r) => r.re.test("x ILIKE $1 ESCAPE '\\'") && !r.ok?.("x ILIKE $1 ESCAPE '\\'"))).toBe(false);
  });
});
