import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { isBlockedAddress } from '../../common/net/outbound-url';
import { AppConfigService } from '../../core/config/config.service';

/**
 * CODE-082 — `/metrics` (route names, queue depths, error rates) and `/health/deep` (which
 * dependency is down, with latencies) are operator data, not public. They stay `@Public()` (no
 * user JWT — Prometheus has none) but only answer:
 *
 * - a caller on a non-public address — Prometheus on the docker network, the box itself. With
 *   `TRUST_PROXY` set (CODE-004) `req.ip` is the real client behind Caddy, so a request from the
 *   internet relayed by Caddy is still seen as public and refused;
 * - or anyone sending `Authorization: Bearer <METRICS_TOKEN>` (an external scraper).
 *
 * 404, not 403: to the internet these endpoints simply do not exist.
 */
@Injectable()
export class InternalProbeGuard implements CanActivate {
  constructor(private readonly config: AppConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (this.hasValidToken(req.headers.authorization)) return true;
    const ip = req.ip ?? req.socket?.remoteAddress ?? '';
    if (ip && isBlockedAddress(ip)) return true;
    throw new AppException(ERROR_CODES.NOT_FOUND, 'Not found.', 404);
  }

  private hasValidToken(header: string | undefined): boolean {
    const expected = this.config.get('METRICS_TOKEN');
    if (!expected || !header?.startsWith('Bearer ')) return false;
    const given = Buffer.from(header.slice('Bearer '.length).trim());
    const want = Buffer.from(expected);
    return given.length === want.length && timingSafeEqual(given, want);
  }
}
