import { escapeHtml, renderPdf, renderTemplate } from './pdf-render';

/** B-098 — PDF/HTML templates render user-typed text (DVIR notes, defect descriptions, driver
 * and location names) — it must come out as literal text, never markup or template syntax. */
describe('pdf-render templating', () => {
  it('HTML-escapes user text', () => {
    const html = renderTemplate('<div>{{notes}}</div>', { notes: '<img src=x onerror=alert(1)><script>fetch("http://169.254.169.254")</script>' });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes attribute-breaking quotes', () => {
    expect(renderTemplate('<td class="{{severity}}">', { severity: 'x" onmouseover="alert(1)' })).toBe('<td class="x&quot; onmouseover=&quot;alert(1)">');
  });

  it('never expands template syntax that came from data inside an {{#each}} block', () => {
    const html = renderTemplate('{{#each defects}}<td>{{description}}</td>{{/each}}|{{secret}}', {
      secret: 'S3CR3T',
      defects: [{ description: '{{secret}}' }],
    });
    expect(html).toBe('<td>&#123;&#123;secret&#125;&#125;</td>|S3CR3T');
  });

  it('escapeHtml stringifies non-string values safely', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(3)).toBe('3');
    expect(escapeHtml({ a: '<b>' })).toBe('&#123;&quot;a&quot;:&quot;&lt;b&gt;&quot;&#125;');
  });
});

/**
 * B-1NN — a live Chrome launch, not just the templating helpers above: puppeteer's pinned
 * build for the installed version can go missing from `~/.cache/puppeteer` (this box only
 * had a newer Chrome cached, not the exact pinned one) without any of the tests above
 * catching it, since none of them ever call `renderPdf()`. Skipped automatically when no
 * usable Chrome is on disk at all (CI images without a browser cache) rather than failing.
 */
describe('renderPdf (real headless Chrome launch)', () => {
  it('produces real PDF bytes from an actual template', async () => {
    const pdf = await renderPdf('dvir-report', {
      carrier: { name: 'Universal Logistics Inc.' },
      rows: [{ dvirId: 'dvir_1', defectCount: 0, openDefects: 0, criticalOpenDefects: 0 }],
    });
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  }, 30_000);
});
