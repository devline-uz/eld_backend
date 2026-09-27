import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

/**
 * B-1NN (2026-09-24): `puppeteer@24.43.1`'s pinned build (Chrome 148.0.7778.97) is not what
 * this box has installed — only 152.0.7977.75 is present under `~/.cache/puppeteer/chrome`
 * (`puppeteer.executablePath()` still resolves to the 148 path, which doesn't exist, so every
 * PDF endpoint threw ENOENT on launch). Resolution order: `PUPPETEER_EXECUTABLE_PATH` env
 * (explicit operator override) -> puppeteer's own pinned path IF it exists on disk -> the
 * newest `linux-*` Chrome build actually present in puppeteer's cache. This keeps `npm i`
 * (which re-pins the expected version) authoritative while tolerating a cache that has since
 * moved on, instead of hard-coding "152" anywhere.
 */
function resolveExecutablePath(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const pinned = puppeteer.executablePath();
  if (existsSync(pinned)) return pinned;
  try {
    const cacheRoot = join(pinned.split('/.cache/puppeteer/')[0] ?? '', '.cache', 'puppeteer', 'chrome');
    const builds = readdirSync(cacheRoot)
      .filter((d) => d.startsWith('linux-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const build of builds) {
      const candidate = join(cacheRoot, build, 'chrome-linux64', 'chrome');
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // fall through — let puppeteer.launch() report its own error with the pinned path
  }
  return undefined;
}

/** TZ §15 — "PDF: Puppeteer, shablon `reports/templates/`". A handlebars-lite templating:
 * `{{path.to.value}}` and `{{#each list}}...{{/each}}` are enough for the two report PDFs
 * this phase ships; a real template engine is a one-line swap if the need grows. */
function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj);
}

function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Also escapes `{`/`}` (B-098): `{{#each}}` output is fed through the plain `{{path}}` pass
 * a second time, so a driver-typed `{{carrier.name}}` in a defect note or DVIR remark used to
 * be expanded as a template expression instead of printed literally. */
export function escapeHtml(value: unknown): string {
  return toDisplayString(value).replace(
    /[&<>"'{}]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;' })[c] as string,
  );
}

/** Every http(s) URL the render data itself carries (presigned signature images). The page may
 * fetch those and nothing else — no other network access from the PDF browser (B-098). */
function collectDataUrls(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectDataUrls(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectDataUrls(item, out);
  }
  return out;
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  // {{#each list}} ... {{/each}}
  let html = template.replace(/{{#each\s+([\w.]+)}}([\s\S]*?){{\/each}}/g, (_m, path: string, body: string) => {
    const list = get(data, path);
    if (!Array.isArray(list)) return '';
    return list
      .map((item) => body.replace(/{{\s*([\w.]+)\s*}}/g, (_m2, p: string) => escapeHtml(p === '.' ? item : get(item, p))))
      .join('');
  });
  // plain {{path}}
  html = html.replace(/{{\s*([\w.]+)\s*}}/g, (_m, p: string) => escapeHtml(get(data, p)));
  return html;
}

let sharedBrowserPromise: ReturnType<typeof puppeteer.launch> | null = null;
async function getBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch({
      headless: true,
      executablePath: resolveExecutablePath(),
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return sharedBrowserPromise;
}

/** Renders `reports/templates/{name}.html` with `data` and returns the PDF bytes. */
export async function renderPdf(name: string, data: Record<string, unknown>): Promise<Buffer> {
  const templatePath = join(__dirname, '..', 'templates', `${name}.html`);
  const template = readFileSync(templatePath, 'utf8');
  const html = renderTemplate(template, data);
  const allowedUrls = collectDataUrls(data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // B-098 defence in depth: templates are static, values are escaped — still, the renderer
    // runs no script and reaches no host except the exact presigned URLs passed in `data`
    // (no SSRF into the VPC/metadata endpoint if an escaping gap ever appears).
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url === 'about:blank' || allowedUrls.has(url)) void request.continue();
      else void request.abort('blockedbyclient');
    });
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
