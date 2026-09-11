import { csvFromRows } from './csv-stream';

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

describe('csvFromRows (TZ §15 streaming CSV)', () => {
  it('streams rows from an async generator into CSV text with a header', async () => {
    async function* rows() {
      yield { a: 1, b: 'x' };
      yield { a: 2, b: 'y' };
    }
    const text = await collect(csvFromRows(rows()));
    expect(text).toBe('a,b\n1,x\n2,y');
  });

  it('produces just the header for an empty generator', async () => {
    async function* rows(): AsyncGenerator<{ a: number }> {
      // no rows
    }
    const text = await collect(csvFromRows(rows()));
    expect(text.trim()).toBe('');
  });

  it('propagates a generator error as a stream error instead of hanging', async () => {
    async function* rows(): AsyncGenerator<{ a: number }> {
      yield { a: 1 };
      throw new Error('boom');
    }
    const stream = csvFromRows(rows());
    await expect(collect(stream)).rejects.toThrow('boom');
  });
});
