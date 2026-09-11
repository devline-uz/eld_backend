/**
 * Outbound-mail port for eRODS email transfer (tz.md §10.4).
 *
 * The project has no SMTP integration yet (see `auth.service.ts` — Phase 1 deliberately has
 * no outbound email). This port is the seam: `LoggingMailTransport` is the default provider
 * and does NOT dispatch anything, so nothing can silently leak a RODS file to a mailbox
 * before a real transport is configured and reviewed. Wiring a real transport is a provider
 * swap in `transfers.module.ts` — no caller changes.
 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  attachments: MailAttachment[];
}

export interface MailSendResult {
  delivered: boolean;
  /** Transport message id when delivered, or a reason code when not. */
  reference: string;
}

export interface MailPort {
  send(message: MailMessage): Promise<MailSendResult>;
}

export const MAIL_PORT = Symbol('MAIL_PORT');
