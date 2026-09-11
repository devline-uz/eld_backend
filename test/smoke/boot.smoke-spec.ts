/**
 * Boot smoke test (tasks.md Global gates / roadmap Gap 1).
 *
 * A live bug slipped through every other suite: `LOG_PRETTY=true` (the real
 * `.env.development` value) made `nestjs-pino` require the `pino-pretty` transport, which
 * was not an installed dependency, so `node dist/main.js` crashed on startup while
 * `test:unit` / `test:integration` / `test:e2e` all stayed green — none of them boot the
 * *compiled* entrypoint, they only build an in-process Nest testing module.
 *
 * This spec closes that hole by actually spawning `dist/main.js` (API) and `dist/worker.js`
 * (worker) as real child processes, with the real `.env.development` file loaded
 * (`LOG_PRETTY=true` included, unmodified) so a missing transport — or any other
 * boot-time failure only reachable via `NestFactory.create`/`.listen()` — fails this test
 * instead of a production deploy. `PORT` is overridden to a high, configurable port
 * (`SMOKE_API_PORT`, default 18173) that collides with neither the unrelated project on
 * this box (3000/3001) nor the ELD docker-compose stack (13000/13001).
 */
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

const ROOT = resolve(__dirname, '../..');
const MAIN_ENTRY = resolve(ROOT, 'dist/main.js');
const WORKER_ENTRY = resolve(ROOT, 'dist/worker.js');
const API_PORT = Number(process.env.SMOKE_API_PORT ?? 18173);
// Worker's own health/metrics listener (src/worker.ts, added Phase 12 alongside
// WorkerHeartbeatService — see B-024/D-045) binds a real host port too, unlike the old
// process-presence-only healthcheck. Configurable the same way as SMOKE_API_PORT so two
// concurrent `npm run test:smoke`/`test:cov` runs on this shared box don't collide on 3002.
const WORKER_HEALTH_PORT = Number(process.env.SMOKE_WORKER_HEALTH_PORT ?? 18174);
const READY_TIMEOUT_MS = 20_000;

/** Parses `.env.development` in-memory only — never logged, never written elsewhere. */
function devEnv(): NodeJS.ProcessEnv {
  const parsed = loadDotenv({ path: resolve(ROOT, '.env.development') }).parsed ?? {};
  return {
    ...process.env,
    ...parsed,
    // Deliberately NOT overridden: LOG_PRETTY stays whatever .env.development says (true),
    // so a missing pino-pretty (or any other transport) makes bootstrap fail for real.
    PORT: String(API_PORT),
    WORKER_HEALTH_PORT: String(WORKER_HEALTH_PORT),
    NODE_ENV: 'development',
    SWAGGER_ENABLED: 'true',
  };
}

function collectOutput(child: ChildProcessWithoutNullStreams): { text(): string } {
  let buf = '';
  const append = (d: Buffer | string) => (buf += d.toString());
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  return { text: () => buf };
}

/** Waits until `predicate(output)` is true, or the child exits, or the timeout elapses. */
function waitFor(
  child: ChildProcessWithoutNullStreams,
  output: { text(): string },
  predicate: (text: string) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate(output.text())) {
        clearInterval(timer);
        res();
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(timer);
        rej(
          new Error(
            `${label} exited early (code=${child.exitCode}, signal=${child.signalCode}) before becoming ready.\n--- output ---\n${output.text()}`,
          ),
        );
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        rej(new Error(`${label} did not become ready within ${timeoutMs}ms.\n--- output ---\n${output.text()}`));
      }
    }, 150);
  });
}

async function killAndWait(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((res) => {
    child.once('exit', () => res());
    child.kill('SIGTERM');
    // Belt-and-braces: force-kill if SIGTERM is ignored (should not happen for these
    // entrypoints, but a hung child process here must never wedge the CI runner).
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5_000).unref();
  });
}

describe('Boot smoke test — dist/main.js and dist/worker.js (real .env.development)', () => {
  let api: ChildProcessWithoutNullStreams | undefined;
  let worker: ChildProcessWithoutNullStreams | undefined;

  beforeAll(() => {
    if (!existsSync(MAIN_ENTRY) || !existsSync(WORKER_ENTRY)) {
      throw new Error(
        `Missing compiled entrypoint(s) — run "npm run build" before "npm run test:smoke" ` +
          `(expected ${MAIN_ENTRY} and ${WORKER_ENTRY}).`,
      );
    }
  });

  afterEach(async () => {
    // Cleanup runs even when an assertion above throws — afterEach always fires.
    await Promise.all([killAndWait(api), killAndWait(worker)]);
    api = undefined;
    worker = undefined;
  });

  it(
    'API: boots dist/main.js with LOG_PRETTY=true and answers every health/metrics/docs route',
    async () => {
      api = spawn('node', [MAIN_ENTRY], { cwd: ROOT, env: devEnv() });
      const out = collectOutput(api);

      await waitFor(api, out, (t) => /listening on/i.test(t), READY_TIMEOUT_MS, 'API (dist/main.js)');

      const base = `http://127.0.0.1:${API_PORT}`;
      // /health/* routes are excluded from setGlobalPrefix (src/main.ts) but still pass
      // through the global TransformInterceptor envelope (`{ data, traceId, timestamp }`).
      const live = await fetch(`${base}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ data: { status: 'ok' } });

      const ready = await fetch(`${base}/health/ready`);
      expect(ready.status).toBe(200);

      const deep = await fetch(`${base}/health/deep`);
      expect(deep.status).toBe(200);

      const metrics = await fetch(`${base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toEqual(expect.stringContaining('# HELP'));

      const swaggerJson = await fetch(`${base}/docs-json`);
      expect(swaggerJson.status).toBe(200);
      const doc = (await swaggerJson.json()) as { info?: { title?: string } };
      expect(doc.info?.title).toBe('OneBook ELD API');
    },
    READY_TIMEOUT_MS + 10_000,
  );

  it(
    'Worker: boots dist/worker.js with LOG_PRETTY=true, registers processors, and stays up',
    async () => {
      worker = spawn('node', [WORKER_ENTRY], { cwd: ROOT, env: devEnv() });
      const out = collectOutput(worker);

      await waitFor(
        worker,
        out,
        (t) => /processors registered/i.test(t),
        READY_TIMEOUT_MS,
        'Worker (dist/worker.js)',
      );

      // Give it a beat past the readiness line — a worker that logs readiness and then
      // immediately crashes (e.g. an unhandled rejection in a queue handler) must still
      // fail this test, not just the log-line check above.
      await new Promise((r) => setTimeout(r, 1_500));
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBeNull();

      // B-024 regression guard: the worker's own /health/live must answer — this is exactly
      // the signal that did not exist when a DI wiring bug once crashed WorkerAppModule at
      // boot while the old process-presence-only healthcheck stayed green.
      const live = await fetch(`http://127.0.0.1:${WORKER_HEALTH_PORT}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toMatchObject({ status: 'ok' });

      const metrics = await fetch(`http://127.0.0.1:${WORKER_HEALTH_PORT}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toEqual(expect.stringContaining('onebook_worker_heartbeat_timestamp_seconds'));
    },
    READY_TIMEOUT_MS + 10_000,
  );
});
