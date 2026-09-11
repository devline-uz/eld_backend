/** TZ §8 — public surface of the pure HOS engine. Nothing below this barrel touches I/O. */
export { computeHos } from './compute-hos';
export * from './limits';
export * from './normalize';
export * from './split-sleeper';
export * from './cycle';
export * from './timezone';
export { ViolationCollector, formatHours } from './violations';
