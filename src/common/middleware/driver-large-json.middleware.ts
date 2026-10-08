import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { ContextUser } from '../../core/context/request-context';

/** The one method this gate needs from `TokenService` / the `TokenVerifier` port. */
export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<ContextUser>;
}

/**
 * B-148 — a large JSON body parser (`POST /mobile/signature`, invoice PDF as base64) that only
 * runs for a caller whose bearer token verifies as a DRIVER access token. Body parsing happens
 * before Nest guards, so without this gate any unauthenticated client could make the API buffer
 * and `JSON.parse` 14 MB per request. Everyone else falls through untouched to the global 1 MB
 * parser (so a forged/missing/user token gets 413 on a big body, or the guard's normal 401).
 *
 * The JWT check is a single HMAC verify (no DB/Redis); `JwtAuthGuard` + `DriverGuard` still run
 * afterwards and stay the authoritative authorization. With no verifier available (a test module
 * without AuthModule) the gate fails closed: the large parser is never used.
 */
export function driverOnlyLargeJson(verifier: AccessTokenVerifier | null, limit: string): RequestHandler {
  const parser = json({ limit });
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!verifier || req.method !== 'POST' || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      next();
      return;
    }
    verifier.verifyAccessToken(header.slice('Bearer '.length)).then(
      (user) => (user.type === 'driver' ? parser(req, res, next) : next()),
      () => next(),
    );
  };
}
