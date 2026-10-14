import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AUDIT_EVENT, type AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { AppConfigService } from '../../core/config/config.service';
import { EventBusService } from '../../core/events/event-bus.service';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import type { RequestMeta } from './auth.service';
import { emailChangeHoldUntil } from './lib/driver-email-hold';
import { buildPasswordResetCodeEmail } from './lib/password-reset-code-email';
import { hashPassword } from './lib/password.util';
import { PasswordResetCodeRepository } from './repositories/password-reset-code.repository';
import { SessionRepository } from './repositories/session.repository';
import { UserAuthRepository, type UserWithRole } from './repositories/user-auth.repository';

/** How long an emailed code is accepted. */
export const RESET_CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong guesses allowed on one code before it is locked (a new code must be requested). */
export const RESET_CODE_MAX_ATTEMPTS = 5;
/** Minimum gap between two codes for the same account ("Resend code" cooldown). */
export const RESET_CODE_RESEND_COOLDOWN_MS = 60 * 1000;

export interface PasswordResetCodeSent {
  success: true;
  /** The stored address (case as on file), for the next step's request body. */
  email: string;
  expiresInSec: number;
  resendAfterSec: number;
  /** Echoed only where `DEV_ECHO_SECRETS` allows one-time secrets (never NODE_ENV=production). */
  code?: string;
}

/**
 * Web panel "Forgot password?" for back-office `User`s (never drivers — mobile has MR-31).
 *
 * 1. `requestCode(email)` — always the same 200 (CODE-081, no account enumeration); only an
 *    ACTIVE user outside the email-change hold and the resend cooldown actually gets a 6-digit
 *    code. Only its HMAC is stored, with a 15 min TTL and a 5-guess limit.
 * 2. `resetWithCode(email, code, newPassword)` — proves ownership of the mailbox, sets the new
 *    Argon2id hash, consumes the code and revokes every refresh session of the user.
 *
 * Follows `POST /auth/login`: with `AUTH_MODE=production` password sign-in is off (B-25), so a
 * self-service password reset would be useless there and is refused the same way (403).
 */
@Injectable()
export class PasswordResetCodeService {
  private readonly logger = new Logger(PasswordResetCodeService.name);

  constructor(
    private readonly users: UserAuthRepository,
    private readonly codes: PasswordResetCodeRepository,
    private readonly sessions: SessionRepository,
    private readonly config: AppConfigService,
    private readonly events: EventBusService,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
  ) {}

  async requestCode(email: string, meta: RequestMeta = {}): Promise<PasswordResetCodeSent> {
    this.assertPasswordAuthEnabled();
    const user = await this.findActiveUser(email);
    // CODE-081 — unknown / INVITED / DISABLED address: the same answer as a real send, so this
    // public endpoint cannot be used to find out who has an account. Step 2 then fails with the
    // ordinary "code expired or already used" for an address that never got a code.
    // Stored addresses are trimmed + lower-cased, so echoing the input that way leaks nothing either.
    if (!user) return this.sentResponse(email.trim().toLowerCase());

    // B-84 email-change hold — the address was confirmed too recently to be trusted for recovery
    // (if the change was not the owner's, the old address can still revert it). No code is mailed;
    // the org admins get an in-app notice instead (same fallback as the driver forgot flow).
    const holdUntil = emailChangeHoldUntil(user.emailChangedAt, this.config.get('USER_EMAIL_CHANGE_HOLD_HOURS'));
    if (holdUntil && Date.now() < holdUntil.getTime()) {
      await this.codes
        .notifyAdminsOfHeldReset(user, new Date(Date.now() - RESET_CODE_TTL_MS))
        .catch((err: unknown) => this.logger.warn({ userId: user.id, err: String(err) }, 'Held password-reset admin notice failed'));
      this.audit('PASSWORD_RESET_HELD', user.id, meta);
      // CODE-081 — no distinct 409 here either (it would confirm the account exists); the admins
      // were notified above, and the generic step-2 copy tells the user to contact them.
      return this.sentResponse(user.email);
    }

    const latest = await this.codes.findLatestActive(user.id);
    if (latest) {
      const waitMs = latest.createdAt.getTime() + RESET_CODE_RESEND_COOLDOWN_MS - Date.now();
      // CODE-081 — inside the 60 s cooldown the live code stays valid and nothing new is mailed;
      // a 429 only for real accounts would itself be the enumeration signal.
      if (waitMs > 0) return this.sentResponse(user.email);
    }

    // One live code per account: a resend retires the previous one.
    await this.codes.invalidateAllForUser(user.id);
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const row = await this.codes.create({
      userId: user.id,
      codeHash: this.hashCode(user.id, code),
      expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
    });

    const result = await this.mail.send(
      buildPasswordResetCodeEmail({
        to: user.email,
        firstName: user.firstName,
        code,
        ttlMinutes: RESET_CODE_TTL_MS / 60_000,
      }),
    );
    const echo = this.config.echoOneTimeSecrets;
    if (!result.delivered && !echo) {
      // Nobody can ever see this code — retire it and say so instead of a dead-end step 2.
      await this.codes.consume(row.id);
      this.logger.warn({ userId: user.id, reason: result.reference }, 'Password reset code email was not delivered');
      throw new AppException(
        ERROR_CODES.SERVICE_UNAVAILABLE,
        "We couldn't send the email right now. Try again later or contact your administrator.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    this.audit('PASSWORD_RESET_CODE_SENT', user.id, meta);
    return { ...this.sentResponse(user.email), ...(echo ? { code } : {}) };
  }

  /** The one response shape for every outcome of step 1 (CODE-081). */
  private sentResponse(email: string): PasswordResetCodeSent {
    return {
      success: true,
      email,
      expiresInSec: RESET_CODE_TTL_MS / 1000,
      resendAfterSec: RESET_CODE_RESEND_COOLDOWN_MS / 1000,
    };
  }

  async resetWithCode(email: string, code: string, newPassword: string, meta: RequestMeta = {}): Promise<void> {
    this.assertPasswordAuthEnabled();
    const user = await this.findActiveUser(email);
    const row = user ? await this.codes.findLatestActive(user.id) : null;
    if (!user || !row || row.expiresAt.getTime() <= Date.now() || row.attempts >= RESET_CODE_MAX_ATTEMPTS) {
      if (row && row.attempts >= RESET_CODE_MAX_ATTEMPTS) await this.codes.consume(row.id);
      throw this.expired();
    }

    if (!this.matches(this.hashCode(user.id, code), row.codeHash)) {
      const attempts = await this.codes.incrementAttempts(row.id);
      const attemptsRemaining = Math.max(0, RESET_CODE_MAX_ATTEMPTS - attempts);
      if (attemptsRemaining === 0) {
        await this.codes.consume(row.id);
        throw this.expired('Too many incorrect attempts. Request a new code.');
      }
      const message = `Incorrect code. ${attemptsRemaining} ${attemptsRemaining === 1 ? 'attempt' : 'attempts'} left.`;
      throw AppException.unprocessable(ERROR_CODES.RESET_CODE_INVALID, message, { code: message, attemptsRemaining });
    }

    // Single use even under a double submit: only the request that flips `consumedAt` proceeds.
    if (!(await this.codes.consume(row.id))) throw this.expired();

    await this.users.updatePasswordHash(user.id, await hashPassword(newPassword));
    await this.codes.invalidateAllForUser(user.id);
    await this.sessions.revokeAllForUser(user.id);
    this.audit('PASSWORD_RESET', user.id, meta);
  }

  private assertPasswordAuthEnabled(): void {
    if (this.config.get('AUTH_MODE') === 'production') {
      throw new AppException(
        ERROR_CODES.PASSWORD_LOGIN_DISABLED,
        'Password sign-in is disabled in production — sign in with Google.',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /** ACTIVE back-office users only: INVITED accept through Google, DISABLED are locked out. */
  private async findActiveUser(email: string): Promise<UserWithRole | null> {
    const user = await this.users.findByEmailWithRole(email);
    return user && user.status === 'ACTIVE' ? user : null;
  }

  private expired(message = 'This code has expired or was already used. Request a new code.'): AppException {
    return AppException.unprocessable(ERROR_CODES.RESET_CODE_EXPIRED, message, { code: message });
  }

  /** Keyed with the server secret so a leaked table cannot be brute-forced offline in 10^6 tries. */
  private hashCode(userId: string, code: string): string {
    return createHmac('sha256', this.config.get('JWT_SECRET')).update(`${userId}:${code}`).digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && timingSafeEqual(left, right);
  }

  /** TZ §18 — same event the `@Audit` interceptor emits; the actor is the account itself. */
  private audit(action: string, userId: string, meta: RequestMeta): void {
    const payload: AuditEventPayload = {
      actorId: userId,
      actorType: 'user',
      action,
      objectType: 'User',
      objectId: userId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    };
    void this.events.publish(AUDIT_EVENT, payload);
  }
}
