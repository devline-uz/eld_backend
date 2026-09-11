/**
 * Jest setup for the `e2e` project. Reuses the dev-DB guard from the `integration` setup
 * (these specs boot the real Nest app against `onebook_eld_dev`), but forces
 * `LOG_PRETTY=false`: pino-pretty spawns a worker-thread transport by resolving a module
 * path that does not exist under ts-jest's CommonJS output, which hangs/crashes
 * `Test.createTestingModule` before a single request is made. Plain JSON logs are fine
 * for a test run — nothing here asserts on log formatting.
 */
import './integration.setup';

process.env.LOG_PRETTY = 'false';
// Lets AppModule's ThrottlerGuard skip rate-limiting (TZ §6.5 — login 5/min/IP) so a suite
// that legitimately calls /auth/login dozens of times doesn't trip its own 429s; the guard
// itself is covered by a dedicated unit test instead.
process.env.NODE_ENV = 'test';
