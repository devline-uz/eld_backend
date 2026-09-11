import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

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

function escapeHtml(value: unknown): string {
  return toDisplayString(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

function renderTemplate(template: string, data: Record<string, unknown>): string {
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
    sharedBrowserPromise = puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  return sharedBrowserPromise;
}

/** Renders `reports/templates/{name}.html` with `data` and returns the PDF bytes. */
export async function renderPdf(name: string, data: Record<string, unknown>): Promise<Buffer> {
  const templatePath = join(__dirname, '..', 'templates', `${name}.html`);
  const template = readFileSync(templatePath, 'utf8');
  const html = renderTemplate(template, data);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
