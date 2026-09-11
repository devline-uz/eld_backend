/**
 * Encryption of the eRODS output file for EMAIL transfer — tz.md §10.4.
 *
 * §395 / Appendix A 4.9.1: a file transferred by email must be ENCRYPTED with FMCSA's public
 * key. `DataTransfer.encrypted` must therefore be `true` for every email transfer; a `false`
 * value fails the job (enforced in `transfer.processor.ts`). Web-services transfer needs no
 * payload encryption beyond TLS.
 *
 * OPEN QUESTION #3 (tasks.md, tz.md §10.4) — UNRESOLVED, and deliberately not invented here:
 *   - FMCSA's actual public key is not published to us. `FMCSA_PUBLIC_KEY` is a config seam:
 *     a PEM SPKI/PKCS#1 RSA public key (or its base64), read from the secrets folder. With no
 *     key configured this service reports `configured = false` and refuses to encrypt.
 *   - FMCSA's expected envelope (PGP? S/MIME? this hybrid RSA-OAEP + AES-256-GCM one?) and
 *     the mandated SUBJECT LINE format are also unknown. `ENVELOPE_FORMAT` below names the
 *     format we emit so a future switch is a config/strategy change, not a rewrite.
 *
 * Nothing above blocks TEST mode: in TEST mode the file is generated, validated, stored and
 * downloadable, and an email transfer is only attempted when a key IS configured.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  constants,
  createCipheriv,
  createHash,
  createPublicKey,
  KeyObject,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { AppConfigService } from '../../core/config/config.service';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';

/** Self-describing envelope name, written into the encrypted payload's first line. */
export const ENVELOPE_FORMAT = 'OBK-ERODS-RSA-OAEP-SHA256+AES-256-GCM/1';

export interface EncryptedPayload {
  /** Bytes to attach to the email. */
  body: Buffer;
  /** Envelope format identifier, mirrored into `DataTransfer.responseBody` for traceability. */
  format: string;
  /** SHA-256 (first 16 hex chars) of the public key used — proves WHICH key encrypted it. */
  keyFingerprint: string;
}

@Injectable()
export class FmcsaEncryptionService {
  private readonly logger = new Logger(FmcsaEncryptionService.name);

  constructor(private readonly config: AppConfigService) {}

  /** True when `FMCSA_PUBLIC_KEY` holds a usable public key. */
  get configured(): boolean {
    return this.loadKey() !== null;
  }

  private loadKey(): KeyObject | null {
    const raw = this.config.get('FMCSA_PUBLIC_KEY');
    if (!raw) return null;
    const pem = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
    try {
      return createPublicKey(pem);
    } catch (err) {
      this.logger.error({ err }, 'FMCSA_PUBLIC_KEY is set but is not a parsable public key.');
      return null;
    }
  }

  /**
   * Hybrid encryption: a fresh AES-256-GCM content key per file, wrapped with FMCSA's RSA
   * public key (OAEP/SHA-256). The output is ASCII-armoured so it survives any mail gateway:
   *
   *   OBK-ERODS-RSA-OAEP-SHA256+AES-256-GCM/1
   *   <base64 wrapped content key>
   *   <base64 iv>
   *   <base64 auth tag>
   *   <base64 ciphertext>
   */
  encrypt(plaintext: Buffer): EncryptedPayload {
    const key = this.loadKey();
    if (!key) {
      throw AppException.unprocessable(
        ERROR_CODES.TRANSFER_ENCRYPTION_UNAVAILABLE,
        'FMCSA_PUBLIC_KEY is not configured — an email transfer cannot be encrypted, and an unencrypted eRODS file must never be emailed (§395, tz.md §10.4).',
      );
    }
    const contentKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const wrappedKey = publicEncrypt(
      { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      contentKey,
    );
    const body = Buffer.from(
      [
        ENVELOPE_FORMAT,
        wrappedKey.toString('base64'),
        iv.toString('base64'),
        authTag.toString('base64'),
        ciphertext.toString('base64'),
      ].join('\n') + '\n',
      'utf8',
    );
    return { body, format: ENVELOPE_FORMAT, keyFingerprint: this.fingerprint(key) };
  }

  private fingerprint(key: KeyObject): string {
    const der = key.export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex').slice(0, 16);
  }
}
