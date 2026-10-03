import type { TransactionalMail } from '../../../core/mail/mail.port';

export interface InviteEmailInput {
  to: string;
  firstName: string;
  roleName: string;
  inviterName?: string;
  /** Optional note from the inviter (`POST /users` `message`, B-85). */
  message?: string;
  signInUrl: string;
  expiresAt: Date;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The back-office invite: there is no password — the user signs in with Google using the
 * invited address, and that first sign-in activates the account (`AuthService.loginGoogle`). */
export function buildInviteEmail(input: InviteEmailInput): TransactionalMail {
  const who = input.inviterName ? `${input.inviterName} has invited you` : 'You have been invited';
  const expires = input.expiresAt.toUTCString();
  const text = [
    `Hi ${input.firstName},`,
    '',
    `${who} to the OneBook ELD web panel as ${input.roleName}.`,
    ...(input.message ? ['', input.message] : []),
    '',
    `To accept, open ${input.signInUrl} and choose "Continue with Google" with the Google account for ${input.to}.`,
    `This invitation expires on ${expires}.`,
  ].join('\n');

  const html = `<p>Hi ${escapeHtml(input.firstName)},</p>
<p>${escapeHtml(who)} to the OneBook ELD web panel as <strong>${escapeHtml(input.roleName)}</strong>.</p>
${input.message ? `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc;white-space:pre-line">${escapeHtml(input.message)}</blockquote>` : ''}
<p><a href="${escapeHtml(input.signInUrl)}" style="display:inline-block;padding:10px 18px;background:#1a56db;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p>Choose <strong>Continue with Google</strong> and sign in with the Google account for <strong>${escapeHtml(input.to)}</strong>.</p>
<p style="color:#666;font-size:12px">This invitation expires on ${escapeHtml(expires)}.</p>`;

  return { to: input.to, subject: "You're invited to OneBook ELD", text, html };
}
