import { Injectable, Logger } from '@nestjs/common';
import { MailMessage, MailPort, MailSendResult } from './mail.port';

/**
 * Default `MailPort`: records the attempt and reports `delivered = false` with the reason
 * `NO_MAIL_TRANSPORT`. It never opens a socket.
 *
 * Why not a real SMTP client: FMCSA's mailbox, mandated subject-line format and public key
 * are all still open (tasks.md open question #3). Shipping a transport that "works" against
 * an unverified envelope would send a non-conformant, possibly unencrypted RODS file to a
 * federal mailbox. The transfer processor treats `delivered = false` as a FAILED transfer in
 * PRODUCTION and as `TEST_ONLY` in TEST mode, so the compliance state stays honest.
 */
@Injectable()
export class LoggingMailTransport implements MailPort {
  private readonly logger = new Logger(LoggingMailTransport.name);

  async send(message: MailMessage): Promise<MailSendResult> {
    this.logger.warn(
      {
        to: message.to,
        subject: message.subject,
        attachments: message.attachments.map((a) => ({ filename: a.filename, bytes: a.content.length })),
      },
      'No mail transport is configured — eRODS email transfer was NOT dispatched.',
    );
    return { delivered: false, reference: 'NO_MAIL_TRANSPORT' };
  }
}
