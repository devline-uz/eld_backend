import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service';

/** D-158 — outbound timeout; the forward is fire-and-forget and must never pin anything. */
export const CLIENT_ERROR_FORWARD_TIMEOUT_MS = 2_000;

/** Payload shape the local Telegram error bot accepts on `POST /report`. */
export interface ErrorBotReport {
  source: 'admin' | 'mobile';
  level: 'error' | 'fatal';
  title: string;
  message: string;
  stack?: string;
  url?: string;
  route?: string;
  appVersion?: string;
  platform?: string;
  device?: string;
  release?: string;
  user?: string;
  traceId?: string;
  time?: string;
}

/**
 * Outbound adapter to the error bot (takes the repository slot in the layering — this module has
 * no DB). Fire-and-forget: `forward` returns synchronously, the HTTP call settles in the
 * background. Failures and drops are logged at warn/debug ONLY — the bot tails this process's
 * pino ERROR/FATAL lines itself, so an error-level log here would double-report every client
 * error as a backend error.
 */
@Injectable()
export class ClientErrorForwarder {
  private readonly logger = new Logger(ClientErrorForwarder.name);

  constructor(private readonly config: AppConfigService) {}

  forward(reports: ErrorBotReport[]): void {
    if (reports.length === 0) return;
    const secret = this.config.get('ERROR_REPORT_SECRET');
    if (!secret) {
      this.logger.debug({ count: reports.length }, 'ERROR_REPORT_SECRET unset — client error reports dropped.');
      return;
    }
    const url = this.config.get('ERROR_REPORT_URL');
    void this.send(url, secret, reports);
  }

  private async send(url: string, secret: string, reports: ErrorBotReport[]): Promise<void> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
        body: JSON.stringify(reports.length === 1 ? reports[0] : reports),
        redirect: 'error',
        signal: AbortSignal.timeout(CLIENT_ERROR_FORWARD_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn({ status: response.status, count: reports.length }, 'Error bot rejected client error reports.');
      }
    } catch (err) {
      this.logger.warn(
        { reason: err instanceof Error ? err.message : String(err), count: reports.length },
        'Client error reports could not be forwarded to the error bot.',
      );
    }
  }
}
