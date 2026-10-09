import { z } from 'zod';

/**
 * TZ §8.6 point 5 — `POST /v1/mobile/hos-state`. The app posts the state ITS engine computed
 * (after every HOS calculation, at most once per 5 minutes; queued while offline). Everything
 * here is an untrusted claim from a mobile client: the server never adopts these numbers, it
 * only compares them with its own.
 */

/** A week of seconds — well past any §395 counter, and a cheap guard against nonsense payloads. */
const SEC_MAX = 7 * 24 * 3600;
const seconds = z.number().int().min(0).max(SEC_MAX);
/** MR-24 — optional engine timestamp the app may echo; stored with the snapshot, never compared. */
const instant = z.string().datetime({ offset: true }).nullable().optional();

export const MobileHosStateDto = z.object({
  currentStatus: z.enum(['OFF', 'SB', 'D', 'ON']),
  driveRemainingSec: seconds,
  shiftRemainingSec: seconds,
  breakRemainingSec: seconds,
  cycleRemainingSec: seconds,
  dailyTotals: z.object({ off: seconds, sb: seconds, drive: seconds, on: seconds }),
  violations: z
    .array(
      z.object({
        type: z.enum(['DRIVING_11', 'SHIFT_14', 'BREAK_30', 'CYCLE_70', 'CYCLE_60', 'FORM_MANNER']),
        exceededBySec: seconds,
      }),
    )
    .max(50)
    .default([]),
  statusSince: instant.describe('MR-24 — ISO-8601: when the current duty status started.'),
  nextBreakDueAt: instant.describe('MR-24 — ISO-8601 or null: when the 30-minute break is due.'),
  shiftEndsAt: instant.describe('MR-24 — ISO-8601 or null: when the 14-hour window ends.'),
  cycleRecapAt: instant.describe('MR-24 — ISO-8601 or null: when recap hours drop off the cycle.'),
  restartAvailableAt: instant.describe('MR-24 — ISO-8601 or null: when the current rest reaches a 34-hour restart.'),
});

export const HosStateDto = z.object({
  computedAt: z
    .string()
    .datetime({ offset: true })
    .transform((value) => new Date(value)),
  /** Must equal the server's `HOS_ENGINE_VERSION`, else the comparison is skipped (§8.6 point 5). */
  hosEngineVersion: z.string().min(1).max(32),
  appPlatform: z.enum(['IOS', 'ANDROID']).optional(),
  state: MobileHosStateDto,
});

export type HosStateDto = z.infer<typeof HosStateDto>;
export type MobileHosStateDto = z.infer<typeof MobileHosStateDto>;
