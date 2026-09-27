import { AppException } from '../../../common/errors/app.exception';
import { ERROR_CODES } from '../../../common/errors/codes';

export interface GeocodeResult {
  lat: number;
  lon: number;
}

/**
 * §20 B-93 — turns a free-text address into a lat/lon for `type: 'ADDRESS'` geofences.
 * Nominatim-shaped (`/search?q=&format=json&limit=1`) — no paid vendor is wired in
 * (decisions.md). `geocoderUrl` is `AppConfigService.get('GEOCODER_URL')`; when unset the
 * caller must reject the request with `GEOCODER_NOT_CONFIGURED` before ever calling this.
 */
/** B-096 — outbound-call bounds: a slow/hostile geocoder must not pin a request worker, and
 * its response is untrusted input. */
export const GEOCODER_TIMEOUT_MS = 5_000;
export const GEOCODER_MAX_RESPONSE_BYTES = 256 * 1024;

export async function geocodeAddress(address: string, geocoderUrl: string): Promise<GeocodeResult> {
  // The caller controls only the `q` value (URL-encoded by URLSearchParams); scheme, host and
  // path come from operator config. `./search` keeps any base path (`https://host/nominatim/`).
  const base = geocoderUrl.endsWith('/') ? geocoderUrl : `${geocoderUrl}/`;
  const url = new URL('./search', base);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  let body: unknown;
  try {
    const response = await fetch(url.toString(), {
      headers: { 'User-Agent': 'onebook-eld/1.0', Accept: 'application/json' },
      // SSRF: never follow a redirect off the configured host (e.g. to 169.254.169.254 or an
      // internal service) — a 3xx is a failed lookup.
      redirect: 'error',
      signal: AbortSignal.timeout(GEOCODER_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AppException(ERROR_CODES.GEOCODE_FAILED, 'The geocoding service rejected the request.', 422);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > GEOCODER_MAX_RESPONSE_BYTES) throw new Error('geocoder response too large');
    const text = await response.text();
    if (text.length > GEOCODER_MAX_RESPONSE_BYTES) throw new Error('geocoder response too large');
    body = JSON.parse(text);
  } catch (err) {
    if (err instanceof AppException) throw err;
    throw new AppException(ERROR_CODES.GEOCODE_FAILED, 'Could not reach the geocoding service.', 422);
  }

  const hit = Array.isArray(body) ? (body[0] as { lat?: unknown; lon?: unknown } | undefined) : undefined;
  const lat = Number(hit?.lat);
  const lon = Number(hit?.lon);
  if (!hit || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new AppException(ERROR_CODES.GEOCODE_FAILED, 'No match found for that address.', 422);
  }
  return { lat, lon };
}
