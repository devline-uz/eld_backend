import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { AccessTokenVerifier } from './driver-large-json.middleware';

/**
 * Web panel — a larger JSON body parser for a back-office bulk route (`POST /vehicles/import`,
 * up to 2,000 rows; a worst-case row is ~1 KB of JSON, so a full file can exceed the global 1 MB
 * limit). Same B-148 reasoning as `driverOnlyLargeJson`: parsing runs before Nest guards, so the
 * larger parser only runs for a caller whose bearer token verifies as a back-office USER access
 * token. Everyone else falls through untouched to the global 1 MB parser. `JwtAuthGuard` +
 * `@Perm` still run afterwards and stay the authoritative authorization. No verifier → fail closed.
 */
export function panelUserLargeJson(verifier: AccessTokenVerifier | null, limit: string): RequestHandler {
  const parser = json({ limit });
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!verifier || req.method !== 'POST' || typeof header !== 'string' || !header.startsWith('Bearer ')) {
      next();
      return;
    }
    verifier.verifyAccessToken(header.slice('Bearer '.length)).then(
      (user) => (user.type === 'user' ? parser(req, res, next) : next()),
      () => next(),
    );
  };
}
