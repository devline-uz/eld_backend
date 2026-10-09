import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../core/config/config.service';

export interface MobileAppConfig {
  minSupportedVersion: string | null;
  latestVersion: string | null;
  storeUrl: string | null;
  userManualUrl: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  minPt30Firmware: string | null;
  recommendedPt30Firmware: string | null;
  /** Only computed when the caller sent `appVersion` and a minimum is configured. */
  updateRequired: boolean | null;
  updateAvailable: boolean | null;
}

/** Compares dotted numeric versions ("1.0.3", "1.2", "2.0.0+14"); non-numeric parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[+-]/)[0].split('.').map((p) => parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** MR-7 / MR-30 — values come only from env (`MOBILE_*`); unset = null, never a made-up default. */
@Injectable()
export class MobileAppConfigService {
  constructor(private readonly config: AppConfigService) {}

  private str(key: Parameters<AppConfigService['get']>[0]): string | null {
    const v = this.config.get(key) as string | undefined;
    return v && v.trim() ? v.trim() : null;
  }

  getAppConfig(platform: string | undefined, appVersion: string | undefined): MobileAppConfig {
    const min = this.str('MOBILE_MIN_SUPPORTED_VERSION') ?? this.str('MOBILE_APP_MIN_VERSION');
    const latest = this.str('MOBILE_LATEST_VERSION') ?? this.str('MOBILE_APP_LATEST_VERSION');
    const platformUrl =
      platform === 'ios' ? this.str('MOBILE_APP_STORE_URL_IOS') : null;
    return {
      minSupportedVersion: min,
      latestVersion: latest,
      storeUrl: platformUrl ?? this.str('MOBILE_STORE_URL'),
      userManualUrl: this.str('MOBILE_USER_MANUAL_URL'),
      privacyPolicyUrl: this.str('MOBILE_PRIVACY_URL'),
      termsUrl: this.str('MOBILE_TERMS_URL'),
      minPt30Firmware: this.str('MOBILE_MIN_PT30_FIRMWARE'),
      recommendedPt30Firmware: this.str('MOBILE_RECOMMENDED_PT30_FIRMWARE'),
      updateRequired: appVersion && min ? compareVersions(appVersion, min) < 0 : null,
      updateAvailable: appVersion && latest ? compareVersions(appVersion, latest) < 0 : null,
    };
  }

  getLegal(kind: 'privacy' | 'terms'): { version: string | null; url: string | null; html: null } {
    return {
      version: this.str('MOBILE_LEGAL_VERSION'),
      url: this.str(kind === 'privacy' ? 'MOBILE_PRIVACY_URL' : 'MOBILE_TERMS_URL'),
      html: null,
    };
  }
}
