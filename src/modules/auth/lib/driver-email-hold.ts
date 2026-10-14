/**
 * Driver email change — the post-change hold. For `DRIVER_EMAIL_CHANGE_HOLD_HOURS` after a
 * confirmed change the new address is not trusted for account recovery: no password-reset code is
 * mailed to it (self-service forgot → admin in-app notice; carrier reset → code to the
 * dispatcher), and the old address's "this wasn't me" link can still revert the change.
 */
export function emailChangeHoldUntil(emailChangedAt: Date | null | undefined, holdHours: number): Date | null {
  if (!emailChangedAt || holdHours <= 0) return null;
  return new Date(emailChangedAt.getTime() + holdHours * 3_600_000);
}

export function isInEmailChangeHold(
  emailChangedAt: Date | null | undefined,
  holdHours: number,
  now: Date = new Date(),
): boolean {
  const until = emailChangeHoldUntil(emailChangedAt, holdHours);
  return until !== null && now.getTime() < until.getTime();
}

/** `john.smith@gmail.com` → `j***@g***.com` — enough for the owner to recognise, not to harvest. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}***@${host[0] ?? ''}***${tld}`;
}
