/**
 * The SEND step of an eRODS transfer — tz.md §10.1 (TEST mode) and §10.4 (email).
 *
 * Everything upstream of this service (generation, Appendix A validation, S3 storage,
 * download) behaves identically in TEST and PRODUCTION. This is the only place where
 * `Carrier.erodsMode` changes behaviour, and it changes it by CONFIGURATION only:
 *
 *   TEST        -> the file is NOT sent to FMCSA; `DataTransfer.status = TEST_ONLY`.
 *   PRODUCTION  -> the file is sent (email or web services) and the status reflects the result.
 *
 * Flipping the toggle needs no code change: Carrier.eldIdentifier + eldRegistrationId +
 * erodsMode + the FMCSA credentials in the secrets folder (tz.md §10.1, 4 steps).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErodsMode, TransferMethod, TransferStatus } from '@prisma/client';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AppConfigService } from '../../core/config/config.service';
import { FmcsaEncryptionService } from './fmcsa-encryption.service';
import { isFmcsaRecipient } from './fmcsa-recipient';
import { MAIL_PORT, MailPort } from './mail.port';

export interface SendTransferInput {
  transferId: string;
  method: TransferMethod;
  erodsMode: ErodsMode;
  fileName: string;
  fileBytes: Buffer;
  outputFileComment: string;
  /** Required for EMAIL. Must be `*.fmcsa.dot.gov`. */
  recipient?: string | null;
}

export interface SendTransferResult {
  status: TransferStatus;
  /** Appendix A 4.9.1 — always true for a dispatched email transfer. */
  encrypted: boolean;
  referenceId: string | null;
  responseCode: string | null;
  responseBody: string | null;
  sentAt: Date | null;
}

@Injectable()
export class FmcsaTransferService {
  private readonly logger = new Logger(FmcsaTransferService.name);

  constructor(
    private readonly config: AppConfigService,
    private readonly encryption: FmcsaEncryptionService,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  /**
   * Validates the recipient the moment a transfer is REQUESTED, so a bad address is a
   * `422` on the API call rather than a dead job discovered hours later.
   */
  assertValidRequest(method: TransferMethod, recipient?: string | null): void {
    if (method !== 'EMAIL') return;
    if (!recipient || !isFmcsaRecipient(recipient)) {
      throw AppException.unprocessable(
        ERROR_CODES.INVALID_TRANSFER_RECIPIENT,
        'An eRODS output file may only be emailed to an fmcsa.dot.gov address (tz.md §10.4, §395.24).',
        { recipient: recipient ?? null },
      );
    }
  }

  async send(input: SendTransferInput): Promise<SendTransferResult> {
    // Re-checked here and not only at request time: the job payload could have been
    // constructed by an offline mobile queue replay (§13.5) that never touched the API DTO.
    this.assertValidRequest(input.method, input.recipient);

    if (input.erodsMode === 'TEST') {
      this.logger.log(
        { transferId: input.transferId, method: input.method },
        'eRODS TEST mode — output file generated and stored, NOT sent to FMCSA.',
      );
      return {
        status: 'TEST_ONLY',
        // An email transfer must be encrypted even in TEST mode; if no key is configured the
        // file is simply not emailed, and the transfer stays TEST_ONLY with the reason logged.
        encrypted: input.method === 'EMAIL' ? this.encryption.configured : false,
        referenceId: null,
        responseCode: 'TEST_ONLY',
        responseBody: 'erodsMode=TEST — file not transmitted to FMCSA (tz.md §10.1).',
        sentAt: null,
      };
    }

    return input.method === 'EMAIL' ? this.sendByEmail(input) : this.sendByWebServices(input);
  }

  /** §10.4 — domain-restricted AND encrypted. Both are hard preconditions. */
  private async sendByEmail(input: SendTransferInput): Promise<SendTransferResult> {
    const encryptedPayload = this.encryption.encrypt(input.fileBytes);
    const result = await this.mail.send({
      to: input.recipient as string,
      subject: this.subjectFor(input.fileName, input.outputFileComment),
      text: [
        'ELD output file per 49 CFR §395 Appendix A.',
        `File: ${input.fileName}`,
        `Comment: ${input.outputFileComment}`,
        `Encryption: ${encryptedPayload.format} (key ${encryptedPayload.keyFingerprint})`,
      ].join('\n'),
      attachments: [
        {
          filename: `${input.fileName}.enc`,
          content: encryptedPayload.body,
          contentType: 'application/octet-stream',
        },
      ],
    });

    return {
      status: result.delivered ? 'SENT' : 'FAILED',
      // The payload WAS encrypted before we ever handed it to the transport.
      encrypted: true,
      referenceId: result.delivered ? result.reference : null,
      responseCode: result.delivered ? 'SENT' : result.reference,
      responseBody: `${encryptedPayload.format} key=${encryptedPayload.keyFingerprint}`,
      sentAt: result.delivered ? new Date() : null,
    };
  }

  /** §10.4 — web services need no payload encryption beyond TLS. */
  private async sendByWebServices(input: SendTransferInput): Promise<SendTransferResult> {
    const endpoint = this.config.get('FMCSA_WEB_SERVICES_URL');
    if (!endpoint) {
      throw AppException.unprocessable(
        ERROR_CODES.INTEGRATION_NOT_CONFIGURED,
        'FMCSA_WEB_SERVICES_URL is not configured — eRODS web-services transfer is unavailable.',
      );
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv', 'X-ELD-Output-File-Name': input.fileName },
      body: new Uint8Array(input.fileBytes),
    });
    const body = (await response.text()).slice(0, 2_000);
    return {
      status: response.ok ? 'SENT' : 'FAILED',
      encrypted: false,
      referenceId: response.headers.get('x-submission-id'),
      responseCode: String(response.status),
      responseBody: body,
      sentAt: response.ok ? new Date() : null,
    };
  }

  /**
   * OPEN QUESTION #3 — FMCSA's mandated subject-line format is unknown. The template is
   * configuration (`FMCSA_EMAIL_SUBJECT_TEMPLATE`, placeholders `{fileName}` and
   * `{comment}`) so the confirmed format is a settings change, not a deploy.
   */
  private subjectFor(fileName: string, comment: string): string {
    const template = this.config.get('FMCSA_EMAIL_SUBJECT_TEMPLATE');
    return template.replace('{fileName}', fileName).replace('{comment}', comment);
  }
}
