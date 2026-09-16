/**
 * OneBook ELD — live simulator HTTP client (dev only, see prisma/mock/README.md).
 *
 * The simulator plays the MOBILE APP, not the PT30: every `/ingest/*` call carries a DRIVER JWT
 * (tz.md §3.1 / §7.1). Tokens are minted locally with the same `JWT_SECRET` + claims shape the
 * API's `TokenService.signDriverAccessToken` uses (`{ sub, typ: 'driver' }`, HS256) because
 * `/auth/login/driver` is throttled to 5 attempts/min per IP (§6.5) — logging 100+ mock drivers
 * in through it would take half an hour. The same token could be obtained interactively with
 * `POST /api/auth/login/driver { username: 'mock_…', password: 'Onebook2026' }`.
 */
import jwt from 'jsonwebtoken';

export interface ApiClientOptions {
  /** e.g. http://127.0.0.1:3002/api */
  baseUrl: string;
  jwtSecret: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const TOKEN_TTL_SEC = 6 * 3600;
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class IngestApiClient {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly opts: ApiClientOptions) {}

  driverToken(driverId: string): string {
    const now = Date.now();
    const cached = this.tokens.get(driverId);
    if (cached && cached.expiresAt - now > REFRESH_MARGIN_MS) return cached.token;
    const token = jwt.sign({ sub: driverId, typ: 'driver' }, this.opts.jwtSecret, {
      expiresIn: TOKEN_TTL_SEC,
    });
    this.tokens.set(driverId, { token, expiresAt: now + TOKEN_TTL_SEC * 1000 });
    return token;
  }

  async post(path: string, driverId: string, body: unknown): Promise<ApiResponse> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.driverToken(driverId)}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      /* non-JSON body (e.g. empty) — keep the raw text */
    }
    return { status: res.status, body: parsed };
  }
}
