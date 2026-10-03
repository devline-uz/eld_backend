/**
 * Transactional email (invites, account notices) — separate from the eRODS `MAIL_PORT` in
 * `modules/transfers`, which stays on `LoggingMailTransport` until FMCSA's envelope is
 * confirmed (decisions.md D-026). Configuring SMTP for invites must never start emailing
 * RODS files to a federal mailbox as a side effect.
 */
export interface TransactionalMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface TransactionalMailResult {
  delivered: boolean;
  /** Transport message id when delivered, or a reason code when not. */
  reference: string;
}

export interface TransactionalMailPort {
  send(message: TransactionalMail): Promise<TransactionalMailResult>;
}

export const TRANSACTIONAL_MAIL = Symbol('TRANSACTIONAL_MAIL');
