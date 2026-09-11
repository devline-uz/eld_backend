import { format } from 'fast-csv';
import { PassThrough } from 'node:stream';

/**
 * TZ §15 — "Streaming — millions of rows must never be read into memory". Wraps an async
 * generator of rows into a readable CSV stream; rows are pulled and written one at a time
 * (the generator itself paginates its DB query — see each report generator), so the process
 * never holds more than one page of rows plus fast-csv's small internal buffer.
 */
export function csvFromRows<T extends object>(rows: AsyncIterable<T>): PassThrough {
  const out = new PassThrough();
  const csv = format({ headers: true });
  csv.pipe(out);
  void (async () => {
    try {
      for await (const row of rows) {
        if (!csv.write(row)) {
          await new Promise((resolve) => csv.once('drain', resolve));
        }
      }
      csv.end();
    } catch (err) {
      out.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();
  return out;
}
