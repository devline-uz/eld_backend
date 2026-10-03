import { Injectable, Logger } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AppConfigService } from '../config/config.service';
import { TransactionalMail, TransactionalMailPort, TransactionalMailResult } from './mail.port';

/**
 * SMTP-backed `TransactionalMailPort`. With `SMTP_HOST` unset (local dev, CI) it logs the
 * attempt and reports `NO_MAIL_TRANSPORT` instead of opening a socket. A send failure is
 * returned, never thrown: callers decide whether an undelivered email fails their request.
 */
@Injectable()
export class SmtpMailTransport implements TransactionalMailPort {
  private readonly logger = new Logger(SmtpMailTransport.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: AppConfigService) {
    const host = config.get('SMTP_HOST');
    const user = config.get('SMTP_USER');
    this.from = config.get('MAIL_FROM');
    this.transporter = host
      ? createTransport({
          host,
          port: config.get('SMTP_PORT'),
          secure: config.get('SMTP_SECURE'),
          auth: user ? { user, pass: config.get('SMTP_PASS') } : undefined,
          // Message bodies are built from our own templates; never let one pull a file or URL.
          disableFileAccess: true,
          disableUrlAccess: true,
        })
      : null;
  }

  get configured(): boolean {
    return this.transporter !== null;
  }

  async send(message: TransactionalMail): Promise<TransactionalMailResult> {
    if (!this.transporter) {
      this.logger.warn({ to: message.to, subject: message.subject }, 'SMTP_HOST is not set — email was NOT sent.');
      return { delivered: false, reference: 'NO_MAIL_TRANSPORT' };
    }
    try {
      const info = await this.transporter.sendMail({ from: this.from, ...message });
      return { delivered: true, reference: info.messageId };
    } catch (error) {
      this.logger.error({ to: message.to, subject: message.subject, err: error }, 'SMTP send failed');
      return { delivered: false, reference: 'SMTP_SEND_FAILED' };
    }
  }
}
