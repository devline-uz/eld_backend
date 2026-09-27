import { geocodeAddress, GEOCODER_MAX_RESPONSE_BYTES } from './geocoder';

/** B-096 — `GEOCODER_URL` outbound call: SSRF/DoS bounds and untrusted-response validation. */
describe('geocodeAddress', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('keeps host/path from config, URL-encodes the caller text, refuses redirects and sets a timeout', async () => {
    fetchMock.mockResolvedValue(ok([{ lat: '41.88', lon: '-87.63' }]));
    await expect(geocodeAddress('1 Main St/../../admin?x=1#frag', 'https://geo.example.com/nominatim')).resolves.toEqual({ lat: 41.88, lon: -87.63 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://geo.example.com');
    expect(parsed.pathname).toBe('/nominatim/search');
    expect(parsed.searchParams.get('q')).toBe('1 Main St/../../admin?x=1#frag');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps a network error / redirect refusal / timeout to 422 GEOCODE_FAILED', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
  });

  it('rejects out-of-range or non-numeric coordinates instead of storing NaN', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ lat: 'abc', lon: '1' }]));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
    fetchMock.mockResolvedValueOnce(ok([{ lat: '95', lon: '1' }]));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
    fetchMock.mockResolvedValueOnce(ok({ lat: '1', lon: '1' }));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
  });

  it('refuses an oversized response body', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(GEOCODER_MAX_RESPONSE_BYTES + 1), { status: 200 }));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
  });

  it('maps a non-2xx answer to GEOCODE_FAILED', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(geocodeAddress('x', 'https://geo.example.com')).rejects.toMatchObject({ code: 'GEOCODE_FAILED' });
  });
});
