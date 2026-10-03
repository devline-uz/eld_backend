import { createTransport } from 'nodemailer';
import type { AppConfigService } from '../config/config.service';
import { SmtpMailTransport } from './smtp-mail.transport';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

function configWith(values: Record<string, unknown>): AppConfigService {
  return { get: (key: string) => values[key] } as unknown as AppConfigService;
}

const MESSAGE = { to: 'anna@example.com', subject: 'Hi', text: 'Hello' };

describe('SmtpMailTransport', () => {
  const sendMail = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  it('without SMTP_HOST reports NO_MAIL_TRANSPORT and never opens a transport', async () => {
    const transport = new SmtpMailTransport(configWith({ MAIL_FROM: 'OneBook <no-reply@x.com>' }));
    expect(transport.configured).toBe(false);
    await expect(transport.send(MESSAGE)).resolves.toEqual({ delivered: false, reference: 'NO_MAIL_TRANSPORT' });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends from MAIL_FROM and returns the message id', async () => {
    sendMail.mockResolvedValue({ messageId: '<id@x>' });
    const transport = new SmtpMailTransport(
      configWith({ SMTP_HOST: 'smtp.x.com', SMTP_PORT: 587, SMTP_SECURE: false, SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'OneBook <no-reply@x.com>' }),
    );
    await expect(transport.send(MESSAGE)).resolves.toEqual({ delivered: true, reference: '<id@x>' });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.x.com', port: 587, auth: { user: 'u', pass: 'p' }, disableFileAccess: true, disableUrlAccess: true }),
    );
    expect(sendMail).toHaveBeenCalledWith({ from: 'OneBook <no-reply@x.com>', ...MESSAGE });
  });

  it('reports SMTP_SEND_FAILED instead of throwing when the server rejects', async () => {
    sendMail.mockRejectedValue(new Error('535 auth failed'));
    const transport = new SmtpMailTransport(configWith({ SMTP_HOST: 'smtp.x.com', SMTP_PORT: 587, MAIL_FROM: 'a@x.com' }));
    await expect(transport.send(MESSAGE)).resolves.toEqual({ delivered: false, reference: 'SMTP_SEND_FAILED' });
  });
});
