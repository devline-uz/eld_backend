/**
 * TZ §8 / §8.6 — the HOS engine is pure functions: no DB, no Nest DI, no imports from
 * core/. It is the one exception to the controller→service→repository rule (TZ §3.5).
 * The rules themselves are Phase 4 (owner: eld-hos-engine).
 *
 * This version string must stay byte-identical to the Dart port's HOS_ENGINE_VERSION.
 */
export const HOS_ENGINE_VERSION = '1.0.0';

export function hosEngineVersion(): string {
  return HOS_ENGINE_VERSION;
}
