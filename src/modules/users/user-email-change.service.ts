import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma, User } from '@prisma/client';
import ms from 'ms';
import { diffSnapshots } from '../../common/audit/redact';
import { normalizeEmail } from '../../common/email/email-lookup';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AUDIT_EVENT, AuditEventPayload } from '../../common/interceptors/audit.interceptor';
import { AppConfigService } from '../../core/config/config.service';
import { RequestContext, type ContextUser } from '../../core/context/request-context';
import { EventBusService } from '../../core/events/event-bus.service';
import { TRANSACTIONAL_MAIL, TransactionalMailPort } from '../../core/mail/mail.port';
import { AuthService } from '../auth/auth.service';
import { emailChangeHoldUntil, isInEmailChangeHold, maskEmail } from '../auth/lib/driver-email-hold';
import { TokenService } from '../auth/token.service';
import { UsersRepository } from './users.repository';

/** `PATCH /users/:id` response addition when the email changes (B-84). */
export interface UserEmailVerificationView {
  pendingEmail: string;
  /** Whether the confirm link reached the mail server (false without SMTP). */
  emailDelivered: boolean;
  /** Only with `DEV_ECHO_SECRETS` outside production (B-093). */
  verifyToken?: string;
}

export interface UserReauthProof {
  currentPassword?: string;
  reauthIdToken?: string;
}

export const USER_EMAIL_TAKEN_MESSAGE = 'A user with this email address already exists.';
export const USER_EMAIL_PENDING_MESSAGE = 'This email address is already waiting for confirmation on another account.';

/** 409 EMAIL_TAKEN with `details.email` — shared by the email-change flow and `POST /users` (invite). */
export const emailTakenConflict = (message: string = USER_EMAIL_TAKEN_MESSAGE) =>
  new AppException(ERROR_CODES.EMAIL_TAKEN, message, 409, { email: message });
const conflict = emailTakenConflict;

/** Prisma unique-constraint violation (a racing write took the address between check and write). */
export const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

const CLEAR_PENDING = {
  pendingEmail: null,
  pendingEmailRequestedAt: null,
  pendingEmailRequestedById: null,
} satisfies Prisma.UserUpdateManyMutationInput;

/** Trim + lower-case: every address is stored in one canonical form (`User.email` is unique on
 * `lower(email)`) and compared case-insensitively. Alias of `normalizeEmail`. */
export const normalizeUserEmail = normalizeEmail;

/**
 * B-84 web-user email change, end to end — the same design as the driver flow
 * (`DriverEmailChangeService`):
 *
 * 1. `PATCH /users/:id { email, currentPassword | reauthIdToken }` — the acting web user
 *    re-authenticates; the new address goes to `pendingEmail` (never `email`) and a signed confirm
 *    link (bound to the user, the pending address AND the request time, `USER_EMAIL_CHANGE_TTL`) is
 *    mailed to it. The OLD address gets a notice with the new address masked and a signed
 *    "this wasn't me" link.
 * 2. `POST /auth/email/verify { token }` (public) swaps `email` (only while the token still matches
 *    the stored pending change — a newer request or a cancel kills older links), stamps
 *    `emailChangedAt` / `previousEmail`, unbinds the old Google identity and revokes every session.
 *    That starts the `USER_EMAIL_CHANGE_HOLD_HOURS` hold.
 * 3. `POST /auth/email/cancel { token }` (public, old-address link) drops a pending change, or —
 *    inside the hold — reverts a confirmed one and revokes every session again.
 *
 * Audited: `EMAIL_CHANGE_REQUEST` / `_CONFIRM` / `_CANCEL` / `_REVERT` here, `_RESEND` and the
 * panel `_CANCEL` by the controller's `@Audit`.
 */
@Injectable()
export class UserEmailChangeService {
  private readonly logger = new Logger(UserEmailChangeService.name);

  constructor(
    private readonly users: UsersRepository,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
    @Optional() private readonly events?: EventBusService,
  ) {}

  // ------------------------------------------------------------------ policy

  get holdHours(): number {
    return this.config.get('USER_EMAIL_CHANGE_HOLD_HOURS');
  }

  private get confirmTtlMs(): number {
    const parsed = ms(this.config.get('USER_EMAIL_CHANGE_TTL') as ms.StringValue);
    return typeof parsed === 'number' && parsed > 0 ? parsed : 24 * 3_600_000;
  }

  /** Pending changes requested before this instant have expired: they no longer reserve the address. */
  pendingCutoff(now: Date = new Date()): Date {
    return new Date(now.getTime() - this.confirmTtlMs);
  }

  isInHold(user: Pick<User, 'emailChangedAt'>, now: Date = new Date()): boolean {
    return isInEmailChangeHold(user.emailChangedAt, this.holdHours, now);
  }

  holdUntil(user: Pick<User, 'emailChangedAt'>): Date | null {
    return emailChangeHoldUntil(user.emailChangedAt, this.holdHours);
  }

  // ------------------------------------------------------------------ 1. request

  /** 409 EMAIL_TAKEN when another account signs in with the address, or has an unexpired pending
   * change to it (two links racing for one address would end in a unique-index failure).
   * `userId` omitted (invite of a brand-new user) means every existing account counts. */
  async assertAvailable(email: string, userId?: string): Promise<void> {
    const owner = await this.users.findByEmailInsensitive(email);
    if (owner && owner.id !== userId) throw conflict(USER_EMAIL_TAKEN_MESSAGE);
    if (await this.users.findIdByPendingEmail(email, this.pendingCutoff(), userId)) throw conflict(USER_EMAIL_PENDING_MESSAGE);
  }

  /**
   * Gate for a requested change (run after the availability check): refused while the previous
   * change's hold is open (else a second change could defeat the old address's revert link), and
   * the ACTING user must re-authenticate (`AuthService.assertUserReauth` — password, or a fresh
   * Google ID token for a Google-only account), whether they edit someone else or themselves.
   */
  async assertRequestable(current: User, actorId: string, proof: UserReauthProof): Promise<void> {
    if (this.isInHold(current)) {
      const holdUntil = this.holdUntil(current)?.toISOString();
      const message = "This user's email was changed recently. Another change is possible after the security hold ends.";
      throw new AppException(ERROR_CODES.EMAIL_CHANGE_ON_HOLD, message, 409, { email: message, holdUntil });
    }
    await this.auth.assertUserReauth(actorId, proof);
  }

  /** The columns a request writes (merged into the same `PATCH` update as the other fields). */
  pendingInput(newEmail: string, requestedById: string, now: Date): Prisma.UserUpdateInput {
    return { pendingEmail: newEmail, pendingEmailRequestedAt: now, pendingEmailRequestedById: requestedById };
  }

  /** After the pending change is stored: confirm link to the new address, notice to the old one,
   * `EMAIL_CHANGE_REQUEST` audit. */
  async notifyRequested(user: User, before: User): Promise<UserEmailVerificationView> {
    const pendingEmail = user.pendingEmail as string;
    const requestedAt = user.pendingEmailRequestedAt as Date;
    const token = this.tokens.signUserEmailChangeToken(user.id, pendingEmail, requestedAt);
    const delivered = await this.sendConfirmLink(user, pendingEmail, token);
    const cancelToken = this.tokens.signUserEmailChangeCancelToken(user.id, pendingEmail, before.email, requestedAt);
    await this.sendOldAddressNotice(user, before.email, pendingEmail, cancelToken);
    this.audit('EMAIL_CHANGE_REQUEST', user.id, before, user);
    return { pendingEmail, emailDelivered: delivered, ...(this.config.echoOneTimeSecrets ? { verifyToken: token } : {}) };
  }

  // ------------------------------------------------------------------ resend / cancel (panel)

  /** `POST /users/:id/email-change/resend` — a fresh confirm link for the SAME request (same
   * `requestedAt`, so the old address's cancel link keeps working). */
  async resend(userId: string): Promise<UserEmailVerificationView & { emailedTo: string }> {
    const user = await this.getPending(userId);
    const pendingEmail = user.pendingEmail as string;
    const owner = await this.users.findByEmailInsensitive(pendingEmail);
    if (owner && owner.id !== userId) throw conflict(USER_EMAIL_TAKEN_MESSAGE);
    const token = this.tokens.signUserEmailChangeToken(user.id, pendingEmail, user.pendingEmailRequestedAt as Date);
    const delivered = await this.sendConfirmLink(user, pendingEmail, token);
    return {
      pendingEmail,
      emailedTo: pendingEmail,
      emailDelivered: delivered,
      ...(this.config.echoOneTimeSecrets ? { verifyToken: token } : {}),
    };
  }

  /** `DELETE /users/:id/email-change` — drops the pending change; its links stop working. */
  async cancelPending(userId: string): Promise<void> {
    const user = await this.getPending(userId);
    await this.users.updateIfState(
      userId,
      { pendingEmail: user.pendingEmail, pendingEmailRequestedAt: user.pendingEmailRequestedAt },
      CLEAR_PENDING,
    );
  }

  // ------------------------------------------------------------------ 2. confirm (public link)

  async confirm(token: string): Promise<{ success: true; email: string; alreadyVerified: boolean }> {
    const claims = this.tokens.verifyUserEmailChangeToken(token);
    const invalid = () => new AppException(ERROR_CODES.TOKEN_INVALID, 'This confirmation link is no longer valid.', 401);
    const before = await this.users.findById({ id: claims.userId });
    if (!before) throw invalid();
    const matchesPending =
      before.pendingEmail === claims.email && before.pendingEmailRequestedAt?.getTime() === claims.requestedAt;
    if (!matchesPending) {
      // A second click on the link that already did the change: nothing to write, say so.
      if (before.email === claims.email && before.emailChangedAt && before.emailChangedAt.getTime() >= claims.requestedAt) {
        return { success: true, email: before.email, alreadyVerified: true };
      }
      throw invalid();
    }
    const owner = await this.users.findByEmailInsensitive(claims.email);
    if (owner && owner.id !== before.id) throw conflict(USER_EMAIL_TAKEN_MESSAGE);
    const now = new Date();
    const applied = await this.uniqueSafe(
      this.users.updateIfState(
        before.id,
        { pendingEmail: claims.email, pendingEmailRequestedAt: new Date(claims.requestedAt) },
        {
          email: claims.email,
          emailChangedAt: now,
          previousEmail: before.email,
          // The old Google identity was bound to the previous address and must not silently
          // authenticate the new one (TZ §6.2) — the next Google sign-in with the new address binds again.
          googleUid: null,
          ...CLEAR_PENDING,
        },
      ),
    );
    if (!applied) throw invalid();
    // The account's sign-in / recovery address moved: every refresh session must sign in again.
    await this.auth.revokeAllUserSessions(before.id);
    this.audit('EMAIL_CHANGE_CONFIRM', before.id, before, await this.load(before.id), { id: before.id, type: 'user' });
    return { success: true, email: claims.email, alreadyVerified: false };
  }

  // ------------------------------------------------------------------ 3. cancel / revert (public link)

  async cancelFromLink(token: string): Promise<{ success: true; result: 'CANCELLED' | 'REVERTED' }> {
    const claims = this.tokens.verifyUserEmailChangeCancelToken(token);
    const before = await this.users.findById({ id: claims.userId });
    if (!before) throw new AppException(ERROR_CODES.TOKEN_INVALID, 'This link is no longer valid.', 401);
    const requestedAt = new Date(claims.requestedAt);
    const actor: ContextUser = { id: before.id, type: 'user' };

    // Still pending → just drop it.
    if (before.pendingEmail === claims.email && before.pendingEmailRequestedAt?.getTime() === claims.requestedAt) {
      const done = await this.users.updateIfState(
        before.id,
        { pendingEmail: claims.email, pendingEmailRequestedAt: requestedAt },
        CLEAR_PENDING,
      );
      if (done) {
        this.audit('EMAIL_CHANGE_CANCEL', before.id, before, await this.load(before.id), actor);
        return { success: true, result: 'CANCELLED' };
      }
    }

    // Already confirmed, still inside the hold → put the old address back.
    if (
      before.email === claims.email &&
      before.previousEmail === claims.oldEmail &&
      before.emailChangedAt &&
      before.emailChangedAt.getTime() >= claims.requestedAt &&
      this.isInHold(before)
    ) {
      const owner = await this.users.findByEmailInsensitive(claims.oldEmail);
      if (owner && owner.id !== before.id) throw conflict(USER_EMAIL_TAKEN_MESSAGE);
      const done = await this.uniqueSafe(
        this.users.updateIfState(
          before.id,
          { email: claims.email, previousEmail: claims.oldEmail, emailChangedAt: before.emailChangedAt },
          { email: claims.oldEmail, emailChangedAt: null, previousEmail: null, googleUid: null, ...CLEAR_PENDING },
        ),
      );
      if (done) {
        await this.auth.revokeAllUserSessions(before.id);
        this.audit('EMAIL_CHANGE_REVERT', before.id, before, await this.load(before.id), actor);
        return { success: true, result: 'REVERTED' };
      }
    }

    throw new AppException(
      ERROR_CODES.TOKEN_INVALID,
      'This link can no longer cancel the change. Contact your administrator.',
      401,
    );
  }

  // ------------------------------------------------------------------ helpers

  private async load(id: string): Promise<User> {
    const user = await this.users.findById({ id });
    if (!user) throw AppException.notFound('User not found.');
    return user;
  }

  private async getPending(id: string): Promise<User> {
    const user = await this.load(id);
    if (!user.pendingEmail || !user.pendingEmailRequestedAt) {
      throw new AppException(ERROR_CODES.EMAIL_CHANGE_NOT_PENDING, 'This user has no pending email change.', 404);
    }
    return user;
  }

  private async uniqueSafe(write: Promise<boolean>): Promise<boolean> {
    try {
      return await write;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(USER_EMAIL_TAKEN_MESSAGE);
      throw err;
    }
  }

  private link(path: string, token: string): string {
    const url = new URL(path, this.config.get('WEB_APP_URL'));
    url.searchParams.set('token', token);
    return url.toString();
  }

  /** Best effort: the request is stored either way, so a mail failure is reported
   * (`emailDelivered: false`), not thrown. The token never reaches a log line. */
  private async sendConfirmLink(user: User, to: string, token: string): Promise<boolean> {
    const hours = Math.round(this.confirmTtlMs / 3_600_000);
    const result = await this.mail.send({
      to,
      subject: 'Confirm your new OneBook ELD email',
      text:
        `Hi ${user.firstName},\n\n` +
        `The email on your OneBook ELD account is being changed to this address (${to}).\n\n` +
        `Confirm it here: ${this.link('/account/email/confirm', token)}\n\n` +
        `The link expires in ${hours} hour${hours === 1 ? '' : 's'} and stops working if a newer change is requested. ` +
        'Until you confirm, your current address stays on the account and keeps working for sign-in. ' +
        'Once you confirm, you are signed out everywhere and sign in with the new address.\n\n' +
        'If you did not expect this, ignore this email.',
    });
    if (!result.delivered) {
      this.logger.warn({ userId: user.id, reason: result.reference }, 'Email-change confirm link was not delivered');
    }
    return result.delivered;
  }

  private async sendOldAddressNotice(user: User, to: string, newEmail: string, cancelToken: string): Promise<void> {
    const result = await this.mail.send({
      to,
      subject: 'Your OneBook ELD email is being changed',
      text:
        `Hi ${user.firstName},\n\n` +
        `A request was made to change the email on your OneBook ELD account to ${maskEmail(newEmail)}.\n\n` +
        `If this wasn't you, or you don't recognise it, cancel the change: ${this.link('/account/email/cancel', cancelToken)}\n\n` +
        `The same link can also undo the change for ${this.holdHours} hours after it is confirmed. ` +
        'During that time no password-reset code is sent to the new address.',
    });
    if (!result.delivered) {
      this.logger.warn({ userId: user.id, reason: result.reference }, 'Email-change notice to the old address was not delivered');
    }
  }

  /** TZ §18 — the same event the `@Audit` interceptor emits, for steps that have no `:id` route
   * (public links) or need their own action name next to the PATCH's `UPDATE`. */
  private audit(action: string, userId: string, before: User, after: User, actor?: ContextUser): void {
    if (!this.events) return;
    const rc = RequestContext.get();
    const who = actor ?? rc?.user;
    const diff = diffSnapshots(before, after);
    const payload: AuditEventPayload = {
      actorId: who?.id,
      actorType: who?.type,
      action,
      objectType: 'User',
      objectId: userId,
      before: diff.before,
      after: diff.after,
      ip: rc?.ip,
      userAgent: rc?.userAgent,
      traceId: rc?.traceId,
    };
    void this.events.publish(AUDIT_EVENT, payload);
  }
}
