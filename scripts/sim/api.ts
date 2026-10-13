/**
 * Driver simulator — minimal HTTP client over plain `fetch` (no Prisma, no Nest).
 *
 * - unwraps the `{ data, traceId, timestamp }` envelope (ingest answers are not wrapped);
 * - driver / back-office tokens refresh on 401 (`POST /auth/refresh`, rotating refresh token);
 * - 429 -> `Retry-After` (or exponential) backoff stored on the session, never a hot retry;
 * - logins are paced globally: `/auth/login/driver` is 5/min per IP and that bucket is shared
 *   with every real client behind the same nginx (the dev API has no `trust proxy`).
 */

export interface ApiResult<T = unknown> {
  status: number;
  ok: boolean;
  data: T;
  code?: string;
  message?: string;
  retryAfterMs?: number;
}

export interface Session {
  kind: 'driver' | 'user';
  accessToken: string | null;
  refreshToken: string | null;
  /** Re-login credentials (username or email). */
  login: string;
  /** Epoch ms before which this session must not hit the API (429 backoff). */
  backoffUntil?: number;
  backoffMs?: number;
}

export interface ApiStats {
  ok: number;
  throttled: number;
  errors: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class SimApi {
  readonly stats: ApiStats = { ok: 0, throttled: 0, errors: 0 };
  private lastLoginAt = 0;
  private lastRefreshAt = 0;

  constructor(
    readonly baseUrl: string,
    private readonly password: string,
    private readonly loginGapMs: number,
    private readonly log: (line: string) => void,
    private readonly onTokens: () => void = () => undefined,
  ) {}

  resetStats(): void {
    this.stats.ok = 0;
    this.stats.throttled = 0;
    this.stats.errors = 0;
  }

  private async raw<T>(method: string, path: string, body: unknown, token: string | null): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'onebook-eld-driver-sim/1.0' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      this.stats.errors++;
      return { status: 0, ok: false, data: undefined as T, code: 'NETWORK', message: (err as Error).message };
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    const obj = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
    const data = (Object.hasOwn(obj, 'data') && Object.hasOwn(obj, 'traceId') ? obj.data : json) as T;
    const result: ApiResult<T> = { status: res.status, ok: res.ok, data };
    if (!res.ok) {
      result.code = typeof obj.code === 'string' ? obj.code : undefined;
      result.message = typeof obj.message === 'string' ? obj.message : text.slice(0, 200);
      if (res.status === 429) {
        this.stats.throttled++;
        const ra = Number(res.headers.get('retry-after'));
        result.retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined;
      } else {
        this.stats.errors++;
      }
    } else {
      this.stats.ok++;
    }
    return result;
  }

  /** Paced login; waits for the global gap. Throws on bad credentials. */
  async login(session: Session): Promise<{ driverId?: string }> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = this.lastLoginAt + this.loginGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastLoginAt = Date.now();
      const r =
        session.kind === 'driver'
          ? await this.raw<{ accessToken: string; refreshToken: string; driverId?: string }>('POST', '/auth/login/driver', {
              username: session.login,
              password: this.password,
            }, null)
          : await this.raw<{ accessToken: string; refreshToken: string }>('POST', '/auth/login', {
              email: session.login,
              password: this.password,
            }, null);
      if (r.ok) {
        session.accessToken = r.data.accessToken;
        session.refreshToken = r.data.refreshToken;
        this.onTokens();
        return { driverId: (r.data as { driverId?: string }).driverId };
      }
      if (r.status === 429 || r.status === 0) {
        const backoff = r.retryAfterMs ?? 60_000;
        this.log(`login ${session.login}: ${r.status} ${r.code ?? ''} — waiting ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
        continue;
      }
      throw new Error(`login ${session.login} failed: ${r.status} ${r.code ?? ''} ${r.message ?? ''}`);
    }
    throw new Error(`login ${session.login}: gave up after repeated throttling`);
  }

  /** Rotating refresh (30/min/IP) — falls back to a paced login when the token is dead. */
  private async refresh(session: Session): Promise<boolean> {
    if (session.refreshToken) {
      const wait = this.lastRefreshAt + 2_500 - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRefreshAt = Date.now();
      const r = await this.raw<{ accessToken: string; refreshToken: string }>('POST', '/auth/refresh', {
        refreshToken: session.refreshToken,
        subjectType: session.kind,
      }, null);
      if (r.ok) {
        session.accessToken = r.data.accessToken;
        session.refreshToken = r.data.refreshToken;
        this.onTokens();
        return true;
      }
      if (r.status === 429) return false;
    }
    try {
      await this.login(session);
      return true;
    } catch (err) {
      this.log((err as Error).message);
      return false;
    }
  }

  /**
   * Authenticated call. 401 -> refresh + one retry. 429 -> sets the session backoff and returns
   * the 429 (the caller keeps its payload for the next tick).
   */
  async call<T = unknown>(session: Session, method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    if (session.backoffUntil && Date.now() < session.backoffUntil) {
      return { status: 429, ok: false, data: undefined as T, code: 'LOCAL_BACKOFF' };
    }
    if (!session.accessToken) await this.refresh(session);
    let r = await this.raw<T>(method, path, body, session.accessToken);
    if (r.status === 401) {
      if (await this.refresh(session)) r = await this.raw<T>(method, path, body, session.accessToken);
    }
    if (r.status === 429) {
      const prev = session.backoffMs ?? 2_000;
      const next = r.retryAfterMs ?? Math.min(60_000, prev * 2);
      session.backoffMs = next;
      session.backoffUntil = Date.now() + next;
    } else if (r.ok) {
      session.backoffMs = undefined;
      session.backoffUntil = undefined;
    }
    return r;
  }
}
