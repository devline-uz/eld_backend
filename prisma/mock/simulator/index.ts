/**
 * OneBook ELD — dev-only LIVE telemetry simulator (see prisma/mock/README.md, "Live simulator").
 *
 * Keeps the mock fleet moving so the Live Fleet map, HOS clocks and realtime feed look alive
 * during manual testing. It plays the MOBILE APP for every eligible mock driver: driver JWT +
 * the real HTTP ingest endpoints (`/ingest/telemetry`, `/ingest/events`, `/ingest/device-status`),
 * so validation, sequence-id allocation, malfunction detection, `hos.recalc` and the Socket.IO
 * push are all exercised exactly as in production. Nothing is written to a table directly.
 *
 * Usage:
 *   npm run db:mock:live                      run until Ctrl-C (SIGINT/SIGTERM stop cleanly)
 *   npm run db:mock:live -- --once            one tick, then exit
 *   npm run db:mock:live -- --minutes=3       run for 3 minutes, then exit
 *   options: --interval=60 (seconds between ticks)  --max-drivers=60 (0 = every eligible driver)
 *            --api=http://127.0.0.1:3002/api         --seed=N
 *            --tempo=N (demo mode: every planned status duration is divided by N, so duty
 *                       changes happen N times more often; the motion itself stays real-time)
 *
 * Guards: refuses unless DATABASE_URL's database is exactly `onebook_eld_dev`; only `mock_*`
 * drivers on `M1…` units paired with `MOCKPT30-*` devices are ever touched; timestamps are
 * `Date.now()` at send time (never in the future); requests are paced so the whole fleet stays
 * at roughly <= 1 request/second.
 */
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env.development') });

import { PrismaClient } from '@prisma/client';
import { IngestApiClient } from './api-client';
import { loadFleet, setTempo, step, summarize, type SimDriver, type TickJob } from './fleet';

const DEV_DB_NAME = 'onebook_eld_dev';

interface Options {
  once: boolean;
  minutes: number;
  intervalSec: number;
  maxDrivers: number;
  api: string;
  seed: number;
  tempo: number;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    once: false,
    minutes: 0,
    intervalSec: 60,
    maxDrivers: 60,
    api: process.env.LIVE_SIM_API ?? 'http://127.0.0.1:3002/api',
    seed: 20260915,
    tempo: 1,
  };
  for (const arg of argv) {
    const [key, raw] = arg.split('=');
    const num = raw === undefined ? NaN : Number(raw);
    switch (key) {
      case '--once':
        opts.once = true;
        break;
      case '--minutes':
        opts.minutes = num;
        break;
      case '--interval':
        opts.intervalSec = num;
        break;
      case '--max-drivers':
        opts.maxDrivers = num;
        break;
      case '--api':
        opts.api = raw ?? opts.api;
        break;
      case '--seed':
        opts.seed = num;
        break;
      case '--tempo':
        opts.tempo = num;
        break;
      default:
        throw new Error(`db:mock:live: unknown argument "${arg}"`);
    }
  }
  if (!(opts.intervalSec >= 5)) throw new Error('db:mock:live: --interval must be >= 5 seconds');
  if (!(opts.minutes >= 0)) throw new Error('db:mock:live: --minutes must be a number >= 0');
  if (!(opts.tempo >= 1 && opts.tempo <= 600)) throw new Error('db:mock:live: --tempo must be between 1 and 600');
  if (!(opts.maxDrivers >= 0)) throw new Error('db:mock:live: --max-drivers must be a number >= 0');
  return opts;
}

/** Same hard guard as `prisma/mock/index.ts`; additionally pins the pool to 2 connections. */
function devDatabaseUrl(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new Error('db:mock:live: DATABASE_URL is not set (expected it from .env.development).');
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (dbName !== DEV_DB_NAME) {
    throw new Error(`db:mock:live: refusing to run — DATABASE_URL points at "${dbName}", expected exactly "${DEV_DB_NAME}".`);
  }
  url.searchParams.set('connection_limit', '2');
  return url.toString();
}

const log = (msg: string): void => console.log(`[${new Date().toISOString()}] ${msg}`);

// ---- cooperative stop --------------------------------------------------------------------------
let running = true;
let wake: (() => void) | null = null;
function requestStop(signal: string): void {
  if (!running) return;
  running = false;
  log(`${signal} received — finishing the in-flight request, then exiting.`);
  wake?.();
}
process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

function sleep(ms: number): Promise<void> {
  if (ms <= 0 || !running) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
}

// ---- one driver's uploads for a tick ---------------------------------------------------------------
interface Counters {
  ble: number;
  telemetry: number;
  events: number;
  heartbeats: number;
  errors: number;
  warnings: number;
}

async function upload(client: IngestApiClient, job: TickJob, counters: Counters): Promise<void> {
  const { driver } = job;
  const tag = `${driver.username} (${driver.unitNumber})`;
  for (const t of job.transitions) log(`${tag}: ${t}`);

  if (job.announceBle) {
    // The app pairs with the PT30 over BLE before anything else can flow (§3.1 / §7.6).
    const res = await client.post('/ingest/ble-state', driver.driverId, {
      deviceSerial: driver.deviceSerial,
      state: 'CONNECTED',
    });
    if (res.status === 200) counters.ble += 1;
    else {
      counters.errors += 1;
      log(`${tag}: /ingest/ble-state -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  if (job.events.length) {
    const res = await client.post('/ingest/events', driver.driverId, {
      deviceSerial: driver.deviceSerial,
      vehicleId: driver.vehicleId,
      sdkVersion: 'sim-1.0',
      batch: job.events,
    });
    if (res.status === 200 || res.status === 202) {
      counters.events += job.events.length;
      const body = res.body as { warnings?: unknown[]; malfunctions?: string[]; diagnostics?: string[] };
      if (res.status === 202) {
        counters.warnings += body.warnings?.length ?? 0;
        log(`${tag}: events accepted with warnings — malfunctions=[${body.malfunctions?.join(',') ?? ''}] diagnostics=[${body.diagnostics?.join(',') ?? ''}]`);
      }
    } else {
      counters.errors += 1;
      log(`${tag}: /ingest/events -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  if (job.telemetry) {
    const res = await client.post('/ingest/telemetry', driver.driverId, {
      deviceSerial: driver.deviceSerial,
      vehicleId: driver.vehicleId,
      points: [job.telemetry],
    });
    if (res.status === 200) counters.telemetry += 1;
    else {
      counters.errors += 1;
      log(`${tag}: /ingest/telemetry -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }

  if (job.heartbeat) {
    const res = await client.post('/ingest/device-status', driver.driverId, {
      deviceSerial: driver.deviceSerial,
      storedEventsCount: 0,
      sdkVersion: 'sim-1.0',
    });
    if (res.status === 200) counters.heartbeats += 1;
    else {
      counters.errors += 1;
      log(`${tag}: /ingest/device-status -> ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
  }
}

async function tick(client: IngestApiClient, fleet: SimDriver[], opts: Options, deadline: number, n: number): Promise<void> {
  const startedAt = Date.now();
  const counters: Counters = { ble: 0, telemetry: 0, events: 0, heartbeats: 0, errors: 0, warnings: 0 };

  // Each driver is advanced to `Date.now()` right before its upload, so a point's timestamp is
  // the moment it is sent (never in the future). Uploads are paced evenly across the interval:
  // <= fleet/interval requests per second, i.e. about one per second for the default 60 drivers
  // at 60 s. `--once` uses a fixed 1 s gap between drivers that actually upload something.
  const gapMs = opts.once ? 1000 : Math.floor((opts.intervalSec * 1000) / Math.max(fleet.length, 1));
  for (const driver of fleet) {
    if (!running || Date.now() >= deadline) break;
    const job = step(driver, Date.now());
    const hasWork = Boolean(job.telemetry || job.events.length || job.heartbeat || job.announceBle);
    if (hasWork) {
      try {
        await upload(client, job, counters);
      } catch (err) {
        counters.errors += 1;
        log(`${driver.username}: request failed — ${(err as Error).message}`);
      }
    }
    if (hasWork || !opts.once) await sleep(gapMs);
  }

  const s = summarize(fleet);
  log(
    `tick #${n}: fleet D=${s.D} ON=${s.ON} SB=${s.SB} OFF=${s.OFF} | uploaded telemetry=${counters.telemetry} ` +
      `events=${counters.events} heartbeats=${counters.heartbeats} ble=${counters.ble} | warnings=${counters.warnings} errors=${counters.errors} | ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = devDatabaseUrl(process.env.DATABASE_URL);
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('db:mock:live: JWT_SECRET is not set (expected it from .env.development).');

  setTempo(opts.tempo);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let fleet: SimDriver[];
  try {
    fleet = await loadFleet(prisma, opts.seed, opts.maxDrivers);
  } finally {
    // The DB is only read once, at startup — every write goes through the API from here on.
    await prisma.$disconnect();
  }
  if (!fleet.length) {
    throw new Error('db:mock:live: no eligible mock drivers (ACTIVE mock_* driver with an ACTIVE M1… unit paired to a MOCKPT30-* device) — run `npm run db:mock -- core hos` first.');
  }
  const s = summarize(fleet);
  log(`db:mock:live: ${fleet.length} drivers loaded (D=${s.D} ON=${s.ON} SB=${s.SB} OFF=${s.OFF}); api=${opts.api} interval=${opts.intervalSec}s ${opts.once ? 'once' : opts.minutes ? `for ${opts.minutes} min` : 'until Ctrl-C'}`);

  const client = new IngestApiClient({ baseUrl: opts.api.replace(/\/$/, ''), jwtSecret });
  const deadline = opts.minutes > 0 ? Date.now() + opts.minutes * 60_000 : Number.POSITIVE_INFINITY;

  let n = 0;
  while (running && Date.now() < deadline) {
    const tickStart = Date.now();
    n += 1;
    await tick(client, fleet, opts, deadline, n);
    if (opts.once) break;
    const remaining = opts.intervalSec * 1000 - (Date.now() - tickStart);
    await sleep(Math.min(remaining, Math.max(deadline - Date.now(), 0)));
  }
  log(`db:mock:live: stopped after ${n} tick(s).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
