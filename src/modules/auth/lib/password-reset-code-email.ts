import type { TransactionalMail } from '../../../core/mail/mail.port';

export interface PasswordResetCodeEmailInput {
  to: string;
  firstName: string;
  /** Exactly six digits. */
  code: string;
  ttlMinutes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same inline-style, nested-table approach as `modules/users/lib/invite-email.ts` (Gmail strips
// <style> blocks); colours follow web/src/shared/ui/tokens.css.
const C = {
  page: '#f1f4f9',
  brand: '#0b1f44',
  primary: '#2563eb',
  primarySoft: '#eff4ff',
  text: '#111827',
  muted: '#4b5563',
  subtle: '#6b7280',
  card: '#ffffff',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Web "Forgot password?" — the one-time code that proves the requester owns the address. */
export function buildPasswordResetCodeEmail(input: PasswordResetCodeEmailInput): TransactionalMail {
  const subject = `${input.code} is your OneBook ELD password reset code`;
  const text = [
    `Hi ${input.firstName},`,
    '',
    'Someone (hopefully you) asked to reset the password of your OneBook ELD web panel account.',
    '',
    `Your verification code: ${input.code}`,
    '',
    `Enter it on the "Reset password" screen. The code expires in ${input.ttlMinutes} minutes and can be used once.`,
    '',
    "If you didn't ask for this, ignore this email — your password stays the same.",
    '',
    '— OneBook ELD',
  ].join('\n');

  const e = { firstName: escapeHtml(input.firstName), code: escapeHtml(input.code) };
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Your OneBook ELD password reset code</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your password reset code is ${e.code}. It expires in ${input.ttlMinutes} minutes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="background:${C.brand};border-radius:12px 12px 0 0;padding:24px 40px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="width:36px;height:36px;background:${C.primary};border-radius:8px;text-align:center;vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:800;color:#ffffff;">OB</td>
<td style="padding-left:12px;font-family:${FONT};font-size:18px;font-weight:700;color:#ffffff;">OneBook <span style="color:#93b4ff;">ELD</span></td>
</tr></table>
</td></tr>
<tr><td style="background:${C.card};padding:40px 40px 8px;">
<p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${C.primary};">Password reset</p>
<h1 style="margin:0 0 16px;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${C.text};">Your verification code</h1>
<p style="margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.muted};">Hi ${e.firstName},</p>
<p style="margin:0 0 24px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.muted};">Someone (hopefully you) asked to reset the password of your OneBook ELD web panel account. Enter this code on the <strong style="color:${C.text};">Reset password</strong> screen:</p>
</td></tr>
<tr><td align="center" style="background:${C.card};padding:0 40px 24px;">
<div style="display:inline-block;padding:16px 28px;background:${C.primarySoft};border-radius:8px;font-family:${FONT};font-size:32px;font-weight:800;letter-spacing:.3em;color:${C.text};">${e.code}</div>
</td></tr>
<tr><td style="background:${C.card};border-radius:0 0 12px 12px;padding:0 40px 40px;">
<p style="margin:0 0 12px;font-family:${FONT};font-size:14px;line-height:21px;color:${C.muted};">The code expires in ${input.ttlMinutes} minutes and can be used once.</p>
<p style="margin:0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.subtle};">If you didn't ask for this, ignore this email — your password stays the same.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { to: input.to, subject, text, html };
}
