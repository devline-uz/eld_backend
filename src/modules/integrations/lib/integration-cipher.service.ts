import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../core/config/config.service';
import { decryptValue, encryptValue } from './secret-cipher';

/**
 * TZ §16 — the only place `INTEGRATION_ENCRYPTION_KEY` is read. Every other file that needs to
 * encrypt/decrypt an `Integration.config` secret goes through this service rather than touching
 * `node:crypto` directly, so the key source stays in exactly one place.
 */
@Injectable()
export class IntegrationCipherService {
  private readonly key: Buffer;

  constructor(config: AppConfigService) {
    const key = Buffer.from(config.get('INTEGRATION_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) {
      throw new Error(
        'INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256). ' +
          'Set it in the server secrets folder, never in a committed file.',
      );
    }
    this.key = key;
  }

  encrypt(plaintext: string): string {
    return encryptValue(plaintext, this.key);
  }

  decrypt(payload: string): string {
    return decryptValue(payload, this.key);
  }
}
