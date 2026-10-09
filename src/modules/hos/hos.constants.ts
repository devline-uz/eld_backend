/**
 * TZ §8 / §8.6 — the HOS engine is pure functions: no DB, no Nest DI, no imports from
 * core/. It is the one exception to the controller→service→repository rule (TZ §3.5).
 * The rules themselves are Phase 4 (owner: eld-hos-engine).
 *
 * This version string must stay byte-identical to the Dart port's HOS_ENGINE_VERSION
 * (`mobile/lib/hos/hos_constants.dart`); `mobile/test/hos_engine_version_test.dart` reads this
 * very file and fails if they drift.
 *
 * History (bump whenever a computed `HosState` can change for any input):
 *   1.0.0 — first release.
 *   1.0.1 — B-041: `zonedToUtc()` now resolves a local time inside the DST gap FORWARD, which
 *           moves RODS day boundaries in midnight-transition zones. Supersedes D-048: an app
 *           build carrying the old engine still reports 1.0.0, so keeping the server at 1.0.0
 *           would have made a real engine disagreement look like unexplained drift instead of
 *           HOS_ENGINE_VERSION_MISMATCH.
 *   1.0.2 — B-054: no cycle violation on a RODS day with zero on-duty time, and a cycle violation
 *           with no crossing instant is stamped at min(day end, now) — never in the future.
 *   1.0.3 — D-126 (B-142, B-143): CYCLE_70/60 only for DRIVING past the cycle (§395.3(b)/§395.5(b)); passenger
 *           rulesets follow §395.5 (10 h driving / 15 h ON DUTY after 8 h off, no 34 h restart,
 *           §395.1(g)(3) sleeper pairs ≥ 2 h + ≥ 2 h SB totalling ≥ 8 h). Change list for the Dart
 *           port: `docs/hos-engine-1.0.3-changes.md`.
 */
export const HOS_ENGINE_VERSION = '1.0.3';

export function hosEngineVersion(): string {
  return HOS_ENGINE_VERSION;
}
