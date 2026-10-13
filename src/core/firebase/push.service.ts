import { Injectable, Logger } from '@nestjs/common';
import { PushTokenRepository } from './push-token.repository';
import { FirebaseService } from './firebase.service';

/** FCM error codes that mean the stored token can never receive a push again. */
export const DEAD_TOKEN_CODES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
  'messaging/invalid-registration-token',
]);

/**
 * Drops keys whose value is null/undefined/empty so FCM `data` never carries `""` for a
 * missing deep-link field. All FCM data values must be strings.
 */
export function compactData(data: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Single FCM fan-out used by the alert worker, vehicle assignment and chat. Sends to ALL of a
 * driver's `PushToken` rows (phone + tablet), never throws, and deletes tokens FCM reports as
 * dead (TZ §12.7) so they do not accumulate.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly tokensRepo: PushTokenRepository,
  ) {}

  async sendToDriver(
    driverId: string,
    notification: { title: string; body: string },
    data: Record<string, string | null | undefined>,
  ): Promise<void> {
    if (!this.firebase.enabled) return;
    try {
      const tokens = await this.tokensRepo.findByDriver(driverId);
      const payload = compactData(data);
      const results = await Promise.allSettled(
        tokens.map((t) => this.firebase.sendToToken(t.token, notification, payload)),
      );
      const dead: string[] = [];
      results.forEach((r, i) => {
        if (r.status !== 'rejected') return;
        const code = (r.reason as { code?: string } | undefined)?.code ?? '';
        if (DEAD_TOKEN_CODES.has(code)) dead.push(tokens[i].token);
        else this.logger.warn({ driverId, code }, 'FCM send failed (token kept)');
      });
      if (dead.length) {
        await this.tokensRepo.deleteTokens(dead);
        this.logger.log({ driverId, removed: dead.length }, 'Removed dead FCM tokens');
      }
    } catch (err) {
      this.logger.warn({ driverId, err: err instanceof Error ? err.message : String(err) }, 'FCM push failed');
    }
  }
}
