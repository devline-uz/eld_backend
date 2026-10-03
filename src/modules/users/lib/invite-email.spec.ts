import { buildInviteEmail } from './invite-email';

const BASE = {
  to: 'anna@example.com',
  firstName: 'Anna',
  roleName: 'Dispatcher',
  signInUrl: 'https://panel.example.com/sign-in',
  expiresAt: new Date('2026-10-10T12:00:00.000Z'),
};

describe('buildInviteEmail', () => {
  it('tells the invitee to continue with Google on the sign-in page', () => {
    const mail = buildInviteEmail({ ...BASE, inviterName: 'Sarah Chen' });
    expect(mail.to).toBe('anna@example.com');
    expect(mail.text).toContain('Sarah Chen has invited you to the OneBook ELD web panel as Dispatcher.');
    expect(mail.text).toContain('https://panel.example.com/sign-in');
    expect(mail.text).toContain('Continue with Google');
    expect(mail.html).toContain('href="https://panel.example.com/sign-in"');
  });

  it('HTML-escapes user-supplied values', () => {
    const mail = buildInviteEmail({ ...BASE, firstName: '<b>Anna</b>', message: '<script>alert(1)</script> & hi' });
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; hi');
    expect(mail.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  });

  it('omits the note block when there is no message', () => {
    expect(buildInviteEmail(BASE).html).not.toContain('<blockquote');
  });
});
