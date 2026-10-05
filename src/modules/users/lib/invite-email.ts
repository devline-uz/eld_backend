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

/** "October 12, 2026 at 17:40 UTC" — the invitee's timezone is unknown, so UTC is stated. */
function formatExpiry(date: Date): string {
  const day = date.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} at ${time} UTC`;
}

// Email clients ignore <style> blocks unevenly (Gmail strips most), so every rule is inline
// and the layout is nested tables. Colours follow web/src/shared/ui/tokens.css.
const C = {
  page: '#f1f4f9',
  brand: '#0b1f44',
  primary: '#2563eb',
  primarySoft: '#eff4ff',
  text: '#111827',
  muted: '#4b5563',
  subtle: '#6b7280',
  border: '#e5e7eb',
  card: '#ffffff',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function detailRow(label: string, value: string, last = false): string {
  const border = last ? '' : `border-bottom:1px solid ${C.border};`;
  return `<tr>
<td style="padding:12px 16px;${border}font-family:${FONT};font-size:13px;color:${C.subtle};width:40%;">${label}</td>
<td style="padding:12px 16px;${border}font-family:${FONT};font-size:14px;color:${C.text};font-weight:600;">${value}</td>
</tr>`;
}

function step(n: number, body: string): string {
  return `<tr>
<td valign="top" style="padding:0 12px 12px 0;width:28px;">
<div style="width:24px;height:24px;line-height:24px;border-radius:12px;background:${C.primarySoft};color:${C.primary};font-family:${FONT};font-size:12px;font-weight:700;text-align:center;">${n}</div>
</td>
<td valign="top" style="padding:2px 0 12px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};">${body}</td>
</tr>`;
}

/** The back-office invite: there is no password — the user signs in with Google using the
 * invited address, and that first sign-in activates the account (`AuthService.loginGoogle`). */
export function buildInviteEmail(input: InviteEmailInput): TransactionalMail {
  const who = input.inviterName ? `${input.inviterName} has invited you` : 'You have been invited';
  const expires = formatExpiry(input.expiresAt);

  const text = [
    `Hi ${input.firstName},`,
    '',
    `${who} to the OneBook ELD web panel as ${input.roleName}.`,
    ...(input.message ? ['', `Message from ${input.inviterName ?? 'your administrator'}:`, input.message] : []),
    '',
    'How to accept:',
    `1. Open ${input.signInUrl}`,
    '2. Choose "Continue with Google".',
    `3. Sign in with the Google account for ${input.to}.`,
    '',
    `This invitation expires on ${expires}.`,
    '',
    "If you weren't expecting this invitation, you can safely ignore this email.",
    '',
    '— OneBook ELD',
  ].join('\n');

  const e = {
    to: escapeHtml(input.to),
    firstName: escapeHtml(input.firstName),
    role: escapeHtml(input.roleName),
    who: escapeHtml(who),
    inviter: input.inviterName ? escapeHtml(input.inviterName) : '',
    url: escapeHtml(input.signInUrl),
    expires: escapeHtml(expires),
  };

  const note = input.message
    ? `<tr><td style="background:${C.card};padding:0 40px 24px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.primarySoft};border-left:4px solid ${C.primary};border-radius:6px;">
<tr><td style="padding:16px 20px;">
<p style="margin:0 0 6px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.primary};">Message from ${e.inviter || 'your administrator'}</p>
<p style="margin:0;font-family:${FONT};font-size:14px;line-height:21px;color:${C.text};white-space:pre-line;">${escapeHtml(input.message)}</p>
</td></tr>
</table>
</td></tr>`
    : '';

  const details = [
    detailRow('Role', e.role),
    ...(e.inviter ? [detailRow('Invited by', e.inviter)] : []),
    detailRow('Sign-in account', e.to),
    detailRow('Invitation expires', e.expires, true),
  ].join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>You're invited to OneBook ELD</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${e.who} to the OneBook ELD web panel as ${e.role}. Accept before ${e.expires}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

<tr><td style="background:${C.brand};border-radius:12px 12px 0 0;padding:24px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="width:36px;height:36px;background:${C.primary};border-radius:8px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:800;color:#ffffff;">OB</td>
<td style="padding-left:12px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;letter-spacing:.01em;">OneBook <span style="color:#93b4ff;">ELD</span></td>
</tr></table>
</td></tr>

<tr><td style="background:${C.card};padding:40px 40px 8px;">
<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.primary};">Team invitation</p>
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${C.text};">You're invited to join the OneBook ELD web panel</h1>
<p style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.muted};">Hi ${e.firstName},</p>
<p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.muted};">${e.who} to the OneBook ELD web panel as <strong style="color:${C.text};">${e.role}</strong>. The panel is where your fleet's hours of service, logs, vehicles and drivers are managed.</p>
</td></tr>

${note}

<tr><td style="background:${C.card};padding:0 40px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};border-radius:8px;border-collapse:separate;">
${details}
</table>
</td></tr>

<tr><td align="center" style="background:${C.card};padding:4px 40px 32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td align="center" bgcolor="${C.primary}" style="border-radius:8px;">
<a href="${e.url}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Accept invitation</a>
</td>
</tr></table>
</td></tr>

<tr><td style="background:${C.card};padding:0 40px 8px;">
<p style="margin:0 0 14px;font-family:${FONT};font-size:14px;font-weight:700;color:${C.text};">How to accept</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${step(1, 'Click <strong style="color:' + C.text + ';">Accept invitation</strong> above to open the sign-in page.')}
${step(2, 'Choose <strong style="color:' + C.text + ';">Continue with Google</strong>. No password is needed.')}
${step(3, `Sign in with the Google account for <strong style="color:${C.text};">${e.to}</strong>. Your access is activated on that first sign-in.`)}
</table>
</td></tr>

<tr><td style="background:${C.card};padding:8px 40px 36px;border-radius:0 0 12px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${C.border};padding-top:20px;">
<p style="margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.subtle};">Button not working? Copy this link into your browser:</p>
<p style="margin:0 0 16px;font-family:${FONT};font-size:13px;line-height:20px;word-break:break-all;"><a href="${e.url}" target="_blank" style="color:${C.primary};text-decoration:underline;">${e.url}</a></p>
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.subtle};">If you weren't expecting this invitation, you can safely ignore this email. No account is activated until you sign in.</p>
</td></tr></table>
</td></tr>

<tr><td align="center" style="padding:24px 40px 0;">
<p style="margin:0 0 4px;font-family:${FONT};font-size:12px;line-height:18px;color:${C.subtle};">OneBook ELD · Electronic logging &amp; fleet compliance</p>
<p style="margin:0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.subtle};">This is an automated message sent to ${e.to}. Please do not reply.</p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { to: input.to, subject: `You're invited to OneBook ELD as ${input.roleName}`, text, html };
}
