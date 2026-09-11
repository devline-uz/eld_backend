import { Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import { readFileSync } from 'node:fs';
import { AppConfigService } from '../config/config.service';

/**
 * Firebase Admin provider — Google Sign-In verification (TZ §6.2) and FCM push (TZ §12.7).
 *
 * The service-account file is never committed (TZ §6.5): it is read from
 * FIREBASE_CREDENTIALS_FILE on the server. When it is absent the provider stays
 * uninitialised and callers get a clear error rather than a silent misconfiguration.
 */
@Injectable()
export class FirebaseService {
  private readonly logger = new Logger(FirebaseService.name);
  private readonly app: App | null;

  constructor(config: AppConfigService) {
    const credentialsFile = config.get('FIREBASE_CREDENTIALS_FILE');
    const projectId = config.get('FIREBASE_PROJECT_ID');
    if (!credentialsFile) {
      this.app = null;
      this.logger.warn('FIREBASE_CREDENTIALS_FILE not set — Google Sign-In and FCM are disabled');
      return;
    }
    const existing = getApps();
    this.app =
      existing.length > 0
        ? existing[0]
        : initializeApp({
            credential: cert(
              JSON.parse(readFileSync(credentialsFile, 'utf8')) as Record<string, string>,
            ),
            projectId,
          });
  }

  get enabled(): boolean {
    return this.app !== null;
  }

  private requireApp(): App {
    if (!this.app) throw new Error('Firebase Admin is not configured (FIREBASE_CREDENTIALS_FILE)');
    return this.app;
  }

  /** Verifies a Google Sign-In ID token. Business rules live in modules/auth. */
  verifyIdToken(idToken: string): Promise<DecodedIdToken> {
    return getAuth(this.requireApp()).verifyIdToken(idToken, true);
  }

  /** Sends an FCM data/notification message to a device token. */
  async sendToToken(
    token: string,
    notification: { title: string; body: string },
    data?: Record<string, string>,
  ): Promise<string> {
    return getMessaging(this.requireApp()).send({ token, notification, data });
  }
}
