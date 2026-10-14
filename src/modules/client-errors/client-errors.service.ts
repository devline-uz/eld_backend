import { Injectable } from '@nestjs/common';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import { RequestContext } from '../../core/context/request-context';
import { ClientErrorForwarder, type ErrorBotReport } from './client-error-forwarder';
import { scrubOptional, scrubSecrets } from './client-error-scrub';
import type { ClientErrorItemDto } from './dto/client-errors.dto';

const API_KEY_PREFIX = 'obk_';
const TITLE_MAX = 200;

/**
 * D-158 — public client error intake for the admin web panel and the driver app. Validated items
 * are scrubbed, mapped to the error-bot payload and forwarded fire-and-forget; the response never
 * waits on, or fails because of, the bot.
 */
@Injectable()
export class ClientErrorsService {
  constructor(
    private readonly tokens: TokenVerifier,
    private readonly forwarder: ClientErrorForwarder,
  ) {}

  async report(items: ClientErrorItemDto[], authorization: string | undefined): Promise<{ accepted: number }> {
    const user = await this.resolveUser(authorization);
    const traceId = RequestContext.traceId;
    this.forwarder.forward(items.map((item) => toBotReport(item, user, traceId)));
    return { accepted: items.length };
  }

  /**
   * Optional auth: a valid user/driver ACCESS token yields `user:<id>` / `driver:<id>` (ids only,
   * never names or emails). Missing, malformed, expired or API-key credentials are ignored — an
   * error that happens before login (or because the token expired) must still be reportable.
   */
  async resolveUser(authorization: string | undefined): Promise<string | undefined> {
    if (!authorization?.startsWith('Bearer ')) return undefined;
    const token = authorization.slice('Bearer '.length).trim();
    if (!token || token.startsWith(API_KEY_PREFIX)) return undefined;
    try {
      const principal = await this.tokens.verifyAccessToken(token);
      return principal.type === 'user' || principal.type === 'driver' ? `${principal.type}:${principal.id}` : undefined;
    } catch {
      return undefined;
    }
  }
}

export function toBotReport(item: ClientErrorItemDto, user: string | undefined, traceId: string | undefined): ErrorBotReport {
  const message = scrubSecrets(item.message);
  const firstLine = message.split(/\r?\n/, 1)[0].trim() || message;
  return {
    source: item.source,
    level: item.level,
    title: firstLine.slice(0, TITLE_MAX),
    message,
    stack: scrubOptional(item.stack),
    url: scrubOptional(item.url),
    route: scrubOptional(item.route),
    appVersion: scrubOptional(item.appVersion),
    platform: scrubOptional(item.platform),
    device: scrubOptional(item.device),
    release: scrubOptional(item.release),
    user,
    traceId,
    time: item.occurredAt,
  };
}
