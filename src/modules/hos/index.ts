/** TZ §8 — `hos/` is pure functions only: no DB access, no Nest DI, no module class. */
export * from './hos.types';
export * from './hos.constants';
export { computeHos } from './engine/compute-hos';
export { reconcileViolations, type ViolationAction, type ExistingViolation } from './hos-violation-plan';
export { mapEldEventsToNormalized, type EldEventRow } from './hos-event-mapper';
