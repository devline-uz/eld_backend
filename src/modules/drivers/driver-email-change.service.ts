import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Driver, Prisma } from '@prisma/client';
import ms from 'ms';
import { diffSnapshots } from '../../common/audit/redact';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AUDIT_EVENT, AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { AppConfigService } from '../../core/config/config.service';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { AuthService } from '../auth/auth.service';
import { emailChangeHoldUntil, isInEmailChangeHold, maskEmail } from '../auth/lib/driver-email-hold';
import { PrincipalStateService } from '../auth/principal-state.service';
import { TokenService } from '../auth/token.service';
import { DriversRepository } from './drivers.repository';
import { DRIVER_CONFLICT_MESSAGES, normalizeEmail } from './lib/driver-uniques';

type DriverView = Omit<Driver, 'passwordHash'>;

function toView(driver: Driver): DriverView {
  const { passwordHash: _hash, ...view } = driver;
  return view;
}

/** `PATCH /drivers/:id` response addition — same shape as the users flow (B-84). */
export interface EmailVerificationView {
  pendingEmail: string;
  /** Whether the confirm link reached the mail server (false without SMTP). */
  emailDelivered: boolean;
  /** Only with `DEV_ECHO_SECRETS` outside production (B-093). */
  verifyToken?: string;
}

export interface ReauthProof {
  currentPassword?: string;
  reauthIdToken?: string;
}

const emailTaken = () =>
  new AppException(ERROR_CODES.EMAIL_TAKEN, DRIVER_CONFLICT_MESSAGES.email, 409, { email: DRIVER_CONFLICT_MESSAGES.email });

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

const CLEAR_PENDING = {
  pendingEmail: null,
  pendingEmailRequestedAt: null,
  pendingEmailRequestedById: null,
} satisfies Prisma.DriverUpdateManyMutationInput;

/**
 * Driver email change, end to end:
 *
 * 1. `PATCH /drivers/:id { email, currentPassword }` — the acting web user re-authenticates; the
 *    new address goes to `pendingEmail` (never `email`) and a signed, expiring confirm link is
 *    mailed to it. The OLD address (if any) gets a "your email is being changed to j***@g***.com"
 *    notice with a signed "this wasn't me" link.
 * 2. `POST /auth/driver/email/confirm { token }` (public, from the link) swaps `email`, stamps
 *    `emailVerifiedAt` / `emailChangedAt`, clears the pending change and revokes every driver
 *    session. That starts the `DRIVER_EMAIL_CHANGE_HOLD_HOURS` hold.
 * 3. `POST /auth/driver/email/cancel { token }` (public, from the old-address link) cancels a
 *    pending change, or — inside the hold — reverts a confirmed one and revokes sessions again.
 *
 * Every step is audited (`EMAIL_CHANGE_REQUEST` / `_CONFIRM` / `_CANCEL` / `_REVERT` / `_RESEND`).
 * Mail goes through the real SMTP transport (`TRANSACTIONAL_MAIL`).
 */
@Injectable()
export class DriverEmailChangeService {
  private readonly logger = new Logger(DriverEmailChangeService.name);

  constructor(
    private readonly drivers: DriversRepository,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
    @Optional() private readonly events?: EventBusService,
    @Optional() private readonly principals?: PrincipalStateService,
  ) {}

  // ------------------------------------------------------------------ policy

  get holdHours(): number {
    return this.config.get('DRIVER_EMAIL_CHANGE_HOLD_HOURS');
  }

  private get confirmTtlMs(): number {
    const parsed = ms(this.config.get('DRIVER_EMAIL_CHANGE_TTL') as ms.StringValue);
    return typeof parsed === 'number' && parsed > 0 ? parsed : 24 * 3_600_000;
  }

  /** Pending changes requested before this instant have expired: they no longer reserve the address. */
  pendingCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.confirmTtlMs);
  }

  isInHold(driver: Pick<Driver, 'emailChangedAt'>, now: Date = new Date()): boolean {
    return isInEmailChangeHold(driver.emailChangedAt, this.holdHours, now);
  }

  holdUntil(driver: Pick<Driver, 'emailChangedAt'>): Date | null {
    return emailChangeHoldUntil(driver.emailChangedAt, this.holdHours);
  }

  // ------------------------------------------------------------------ 1. request

  /**
   * Gate for a requested change (run after the uniqueness check): refused while the previous
   * change's hold is open (else a second change could defeat the old address's revert link),
   * only a signed-in back-office user may request it, and that user must re-authenticate.
   */
  async assertRequestable(current: Driver, actor: ContextUser | undefined, proof: ReauthProof): Promise<void> {
    if (this.isInHold(current)) {
      const holdUntil = this.holdUntil(current)?.toISOString();
      const message = 'This driver\'s email was changed recently. Another change is possible after the security hold ends.';
      throw new AppException(ERROR_CODES.EMAIL_CHANGE_ON_HOLD, message, 409, { email: message, holdUntil });
    }
    if (!actor || actor.type !== 'user') {
      throw new AppException(
        ERROR_CODES.REAUTH_REQUIRED,
        'Only a signed-in web user can change a driver\'s email.',
        403,
        { currentPassword: 'Sign in to the web panel to change a driver\'s email.' },
      );
    }
    await this.auth.assertUserReauth(actor.id, proof);
  }

  /** The columns a request writes (merged into the same `PATCH` update as the other fields). */
  pendingInput(newEmail: string, requestedById: string, now: Date): Prisma.DriverUpdateInput {
    return { pendingEmail: newEmail, pendingEmailRequestedAt: now, pendingEmailRequestedById: requestedById };
  }

  /** After the pending change is stored: mail the confirm link to the new address and the notice
   * to the old one, and record `EMAIL_CHANGE_REQUEST`. */
  async notifyRequested(driver: Driver, before: Driver): Promise<EmailVerificationView> {
    const pendingEmail = driver.pendingEmail as string;
    const requestedAt = driver.pendingEmailRequestedAt as Date;
    const token = this.tokens.signDriverEmailChangeToken(driver.id, pendingEmail, requestedAt);
    const delivered = await this.sendConfirmLink(driver, pendingEmail, token);
    const oldEmail = normalizeEmail(before.email);
    if (oldEmail) {
      const cancelToken = this.tokens.signDriverEmailChangeCancelToken(driver.id, pendingEmail, oldEmail, requestedAt);
      await this.sendOldAddressNotice(driver, oldEmail, pendingEmail, cancelToken);
    }
    this.audit('EMAIL_CHANGE_REQUEST', driver.id, before, driver);
    return { pendingEmail, emailDelivered: delivered, ...(this.config.echoOneTimeSecrets ? { verifyToken: token } : {}) };
  }

  // ------------------------------------------------------------------ 1b. clear (email removed)

  /**
   * The columns a CLEAR writes (`PATCH /drivers/:id { email: '' | null }` on a driver that has one;
   * run `assertRequestable` first). Applied at once — there is no new owner to confirm — but it is
   * a change like any other: `emailChangedAt` starts the hold (no further change until it ends, so
   * "clear, then add a new address" cannot skip the old-address notice), `previousEmail` keeps the
   * address the revert link restores, and any pending change is dropped (its confirm link dies).
   */
  clearInput(current: Driver, now: Date): Prisma.DriverUpdateInput {
    return {
      email: null,
      emailVerifiedAt: null,
      emailChangedAt: now,
      previousEmail: normalizeEmail(current.email) ?? null,
      ...CLEAR_PENDING,
    };
  }

  /** After a clear is stored: tell the old address, with a "this wasn't me" link that reverts the
   * clear inside the hold (same cancel token, `email: ''` = "no address"), and record `EMAIL_CHANGE_CLEAR`. */
  async notifyCleared(driver: Driver, before: Driver): Promise<void> {
    const oldEmail = normalizeEmail(before.email);
    if (oldEmail) {
      const cancelToken = this.tokens.signDriverEmailChangeCancelToken(
        driver.id,
        '',
        oldEmail,
        driver.emailChangedAt ?? new Date(),
      );
      await this.sendClearedNotice(driver, oldEmail, cancelToken);
    }
    this.audit('EMAIL_CHANGE_CLEAR', driver.id, before, driver);
  }

  // ------------------------------------------------------------------ resend / cancel (web)

  /** `POST /drivers/:id/email-change/resend` — a fresh confirm link for the SAME request (same
   * `requestedAt`, so the old address's cancel link keeps working). */
  async resend(driverId: string): Promise<EmailVerificationView & { emailedTo: string }> {
    const driver = await this.getPending(driverId);
    const pendingEmail = driver.pendingEmail as string;
    const existing = await this.drivers.findByEmail(pendingEmail);
    if (existing && existing.id !== driverId) throw emailTaken();
    const token = this.tokens.signDriverEmailChangeToken(driver.id, pendingEmail, driver.pendingEmailRequestedAt as Date);
    const delivered = await this.sendConfirmLink(driver, pendingEmail, token);
    return {
      pendingEmail,
      emailedTo: pendingEmail,
      emailDelivered: delivered,
      ...(this.config.echoOneTimeSecrets ? { verifyToken: token } : {}),
    };
  }

  /** `DELETE /drivers/:id/email-change` — drops the pending change (audited by the controller). */
  async cancelPending(driverId: string): Promise<DriverView> {
    const driver = await this.getPending(driverId);
    await this.drivers.updateIfState(
      driverId,
      { pendingEmail: driver.pendingEmail, pendingEmailRequestedAt: driver.pendingEmailRequestedAt },
      CLEAR_PENDING,
    );
    return toView(await this.load(driverId));
  }

  // ------------------------------------------------------------------ 2. confirm (public link)

  async confirm(token: string): Promise<{ success: true; email: string }> {
    const claims = this.tokens.verifyDriverEmailChangeToken(token);
    const invalid = () => new AppException(ERROR_CODES.TOKEN_INVALID, 'This confirmation link is no longer valid.', 401);
    const before = await this.drivers.findById({ id: claims.driverId });
    if (
      !before ||
      before.deletedAt ||
      before.pendingEmail !== claims.email ||
      before.pendingEmailRequestedAt?.getTime() !== claims.requestedAt
    ) {
      throw invalid();
    }
    const existing = await this.drivers.findByEmail(claims.email);
    if (existing && existing.id !== before.id) throw emailTaken();
    const now = new Date();
    const applied = await this.uniqueSafe(
      this.drivers.updateIfState(
        before.id,
        { pendingEmail: claims.email, pendingEmailRequestedAt: new Date(claims.requestedAt) },
        {
          email: claims.email,
          emailVerifiedAt: now,
          emailChangedAt: now,
          previousEmail: before.email,
          ...CLEAR_PENDING,
        },
      ),
    );
    if (!applied) throw invalid();
    // The account's recovery address moved: every refresh token (phone) must sign in again.
    await this.drivers.revokeAllSessions(before.id);
    await this.principals?.invalidateDriver(before.id);
    this.audit('EMAIL_CHANGE_CONFIRM', before.id, before, await this.load(before.id), { id: before.id, type: 'driver' });
    return { success: true, email: claims.email };
  }

  // ------------------------------------------------------------------ 3. cancel / revert (public link)

  async cancelFromLink(token: string): Promise<{ success: true; result: 'CANCELLED' | 'REVERTED' }> {
    const claims = this.tokens.verifyDriverEmailChangeCancelToken(token);
    const before = await this.drivers.findById({ id: claims.driverId });
    if (!before || before.deletedAt) {
      throw new AppException(ERROR_CODES.TOKEN_INVALID, 'This link is no longer valid.', 401);
    }
    const requestedAt = new Date(claims.requestedAt);
    const actor: ContextUser = { id: before.id, type: 'driver' };

    // Still pending → just drop it.
    if (before.pendingEmail === claims.email && before.pendingEmailRequestedAt?.getTime() === claims.requestedAt) {
      const done = await this.drivers.updateIfState(
        before.id,
        { pendingEmail: claims.email, pendingEmailRequestedAt: requestedAt },
        CLEAR_PENDING,
      );
      if (done) {
        this.audit('EMAIL_CHANGE_CANCEL', before.id, before, await this.load(before.id), actor);
        return { success: true, result: 'CANCELLED' };
      }
    }

    // Already confirmed (or cleared: `claims.email === ''`), still inside the hold → put the old
    // address back.
    if (
      (before.email ?? '') === claims.email &&
      before.previousEmail === claims.oldEmail &&
      before.emailChangedAt &&
      before.emailChangedAt.getTime() >= claims.requestedAt &&
      this.isInHold(before)
    ) {
      const existing = await this.drivers.findByEmail(claims.oldEmail);
      if (existing && existing.id !== before.id) throw emailTaken();
      const done = await this.uniqueSafe(
        this.drivers.updateIfState(
          before.id,
          { email: claims.email || null, previousEmail: claims.oldEmail, emailChangedAt: before.emailChangedAt },
          {
            email: claims.oldEmail,
            // Clicked from the old mailbox: that address is proven again.
            emailVerifiedAt: new Date(),
            emailChangedAt: null,
            previousEmail: null,
            ...CLEAR_PENDING,
          },
        ),
      );
      if (done) {
        await this.drivers.revokeAllSessions(before.id);
    await this.principals?.invalidateDriver(before.id);
        this.audit('EMAIL_CHANGE_REVERT', before.id, before, await this.load(before.id), actor);
        return { success: true, result: 'REVERTED' };
      }
    }

    throw new AppException(
      ERROR_CODES.TOKEN_INVALID,
      'This link can no longer cancel the change. Contact your carrier.',
      401,
    );
  }

  // ------------------------------------------------------------------ B-29/B-31 verify (public link)

  /**
   * `POST /auth/driver/email/verify { token }` — the public landing of the link mailed by
   * `POST /drivers/:id/send-verification`. The driver id comes from the token (bound to the
   * driver AND the address it was sent to), so a link only ever verifies the address it reached;
   * once `Driver.email` changes, older links stop working. A second click reports
   * `alreadyVerified` and writes nothing.
   */
  async verifyEmailFromLink(token: string): Promise<{ success: true; email: string; alreadyVerified: boolean }> {
    const claims = this.tokens.verifyDriverEmailVerifyToken(token);
    const invalid = () => new AppException(ERROR_CODES.TOKEN_INVALID, 'This verification link is no longer valid.', 401);
    const before = await this.drivers.findById({ id: claims.driverId });
    if (!before || before.deletedAt || !before.email || before.email !== claims.email) throw invalid();
    if (before.emailVerifiedAt) return { success: true, email: before.email, alreadyVerified: true };
    const applied = await this.drivers.updateIfState(before.id, { email: claims.email, emailVerifiedAt: null }, { emailVerifiedAt: new Date() });
    if (!applied) {
      // Lost a race: either a parallel click verified it (fine) or the address changed meanwhile.
      const now = await this.load(before.id);
      if (now.email === claims.email && now.emailVerifiedAt) return { success: true, email: claims.email, alreadyVerified: true };
      throw invalid();
    }
    this.audit('VERIFY_EMAIL', before.id, before, await this.load(before.id), { id: before.id, type: 'driver' });
    return { success: true, email: claims.email, alreadyVerified: false };
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<Driver> {
    const driver = await this.drivers.findById({ id });
    if (!driver || driver.deletedAt) throw new AppException(ERROR_CODES.DRIVER_NOT_FOUND, 'Driver not found.', 404);
    return driver;
  }

  private async getPending(id: string): Promise<Driver> {
    const driver = await this.load(id);
    if (!driver.pendingEmail || !driver.pendingEmailRequestedAt) {
      throw new AppException(ERROR_CODES.EMAIL_CHANGE_NOT_PENDING, 'This driver has no pending email change.', 404);
    }
    return driver;
  }

  private async uniqueSafe(write: Promise<boolean>): Promise<boolean> {
    try {
      return await write;
    } catch (err) {
      if (isUniqueViolation(err)) throw emailTaken();
      throw err;
    }
  }

  private link(path: string, token: string): string {
    const url = new URL(path, this.config.get('WEB_APP_URL'));
    url.searchParams.set('token', token);
    return url.toString();
  }

  private async sendConfirmLink(driver: Driver, to: string, token: string): Promise<boolean> {
    const hours = Math.round(this.confirmTtlMs / 3_600_000);
    const result = await this.mail.send({
      to,
      subject: 'Confirm your new OneBook ELD driver email',
      text:
        `Your carrier asked to change the email on your OneBook ELD driver account (${driver.username}) to this address.\n\n` +
        `Confirm it here: ${this.link('/driver-email/confirm', token)}\n\n` +
        `The link expires in ${hours} hour${hours === 1 ? '' : 's'}. Until you confirm, the old address stays on the account ` +
        'and you will be signed out of the driver app once you do.\n\n' +
        'If you did not expect this, ignore this email.',
    });
    if (!result.delivered) this.logger.warn({ driverId: driver.id, reason: result.reference }, 'Driver email-change confirm link was not delivered');
    return result.delivered;
  }

  private async sendOldAddressNotice(driver: Driver, to: string, newEmail: string, cancelToken: string): Promise<void> {
    const result = await this.mail.send({
      to,
      subject: 'Your OneBook ELD driver email is being changed',
      text:
        `Your carrier requested to change the email on your OneBook ELD driver account (${driver.username}) to ${maskEmail(newEmail)}.\n\n` +
        `If this wasn't you, or you don't recognise it, cancel the change: ${this.link('/driver-email/cancel', cancelToken)}\n\n` +
        `The same link can also undo the change for ${this.holdHours} hours after it is confirmed. ` +
        'During that time no password-reset code is sent to the new address.',
    });
    if (!result.delivered) this.logger.warn({ driverId: driver.id, reason: result.reference }, 'Driver email-change notice to the old address was not delivered');
  }

  private async sendClearedNotice(driver: Driver, to: string, cancelToken: string): Promise<void> {
    const result = await this.mail.send({
      to,
      subject: 'The email was removed from your OneBook ELD driver account',
      text:
        `Your carrier removed this email address from your OneBook ELD driver account (${driver.username}). ` +
        'Password-reset codes and account notices will no longer be sent here.\n\n' +
        `If this wasn't you, or you don't recognise it, restore your email: ${this.link('/driver-email/cancel', cancelToken)}\n\n` +
        `The link works for ${this.holdHours} hours. During that time no other email can be added to the account.`,
    });
    if (!result.delivered) this.logger.warn({ driverId: driver.id, reason: result.reference }, 'Driver email-removed notice to the old address was not delivered');
  }

  /** TZ §18 — the same event the `@Audit` interceptor emits, for steps that have no `:id` route
   * (public links) or that need their own action name next to the PATCH's `UPDATE`. */
  private audit(action: string, driverId: string, before: Driver, after: Driver, actor?: ContextUser): void {
    if (!this.events) return;
    const rc = RequestContext.get();
    const who = actor ?? rc?.user;
    const diff = diffSnapshots(
      before,
      after,
    );
    const payload: AuditEventPayload = {
      actorId: who?.id,
      actorType: who?.type,
      action,
      objectType: 'Driver',
      objectId: driverId,
      before: diff.before,
      after: diff.after,
      ip: rc?.ip,
      userAgent: rc?.userAgent,
      traceId: rc?.traceId,
    };
    void this.events.publish(AUDIT_EVENT, payload);
  }
}
