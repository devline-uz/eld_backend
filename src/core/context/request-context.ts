import { AsyncLocalStorage } from 'node:async_hooks';

/** Identity of the caller for the current request (TZ §6.1 — two subject types). */
export interface ContextUser {
  id: string;
  /**
   * 'user' = back-office account, 'driver' = mobile/tablet driver,
   * 'api-key' = machine caller authenticated with a §6.5 API key (TZ §11.7).
   */
  type: 'user' | 'driver' | 'api-key';
  role?: string;
  permissions?: Readonly<Record<string, 'NONE' | 'READ' | 'FULL'>>;
  /** B-50 — the `Session.id` behind this User access token (undefined for driver/api-key). */
  sessionId?: string;
}

/**
 * TZ §27.1 point 3 — a RequestContext exists on every request.
 * `carrierId` is carried here today even though no table has a `carrierId` column yet
 * (TZ §27.3 forbids adding those columns now); when the SaaS migration happens the
 * BaseRepository filter reads it from here and nothing else changes.
 */
export interface RequestContextData {
  requestId: string;
  traceId: string;
  carrierId?: string;
  user?: ContextUser;
  ip?: string;
  userAgent?: string;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  /** Runs `fn` with `data` bound as the ambient context. */
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },

  /** Ambient context, or undefined outside a request (e.g. worker bootstrap). */
  get(): RequestContextData | undefined {
    return storage.getStore();
  },

  /** Ambient context or throw — for code that must not run detached. */
  require(): RequestContextData {
    const ctx = storage.getStore();
    if (!ctx) throw new Error('RequestContext is not available in this execution context');
    return ctx;
  },

  get traceId(): string | undefined {
    return storage.getStore()?.traceId;
  },

  get user(): ContextUser | undefined {
    return storage.getStore()?.user;
  },

  get carrierId(): string | undefined {
    return storage.getStore()?.carrierId;
  },

  /** Mutates the ambient context in place (used by guards once auth resolves). */
  set<K extends keyof RequestContextData>(key: K, value: RequestContextData[K]): void {
    const ctx = storage.getStore();
    if (ctx) ctx[key] = value;
  },
};
