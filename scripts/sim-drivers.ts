/**
 * OneBook ELD — live driver simulator (docs/driver-simulator.md, decisions.md D-148).
 *
 *   npm run sim:drivers -- --drivers 30            # run until Ctrl-C (drivers go OFF on exit)
 *   npm run sim:drivers -- --drivers 3 --once      # set up + one tick, then exit
 *   npm run sim:drivers -- --stop                  # put every sim driver OFF DUTY and exit
 *   npm run sim:drivers -- --cleanup               # OFF + unpair virtual devices + release units
 *
 * Everything goes through the REAL HTTP API exactly like the driver app: driver login, unit
 * selection, Virtual ELD pairing (`POST /mobile/virtual-devices`), BLE state, device status,
 * `POST /mobile/duty-status` for the driver's taps and `POST /ingest/*` for the PT30 + app
 * generated records / telemetry. No Prisma writes. State (tokens, device ids, odometer, route
 * position, unsent outbox) lives in scripts/sim/.state/ so a restart continues seamlessly.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SimApi, type ApiResult, type Session } from './sim/api';
import {
  goOffDuty,
  initDriver,
  resumeAfterGap,
  step,
  type DriverSim,
  type EngineOptions,
  type SimAction,
} from './sim/engine';
import { ROUTES, routeLengthMi } from './sim/routes';

// ============================================================================ CLI

interface Args {
  drivers: number;
  intervalSec: number;
  pointEverySec: number;
  once: boolean;
  stop: boolean;
  cleanup: boolean;
  dryRun: boolean;
  violationDrivers: number;
  backfillHours: number;
  quickStart: boolean;
  durationSec: number;
  api: string;
  stateFile: string;
  loginGapSec: number;
  exclude: string[];
  adminEmail: string;
  password: string;
}

const ALWAYS_EXCLUDED = ['johnsmith', 'devline.qa01'];

function parseArgs(argv: string[]): Args {
  const a: Args = {
    drivers: 30,
    intervalSec: 10,
    pointEverySec: 60,
    once: false,
    stop: false,
    cleanup: false,
    dryRun: false,
    violationDrivers: 0,
    backfillHours: 0,
    quickStart: false,
    durationSec: 0,
    api: process.env.SIM_API_URL ?? 'http://127.0.0.1:3002/api',
    stateFile: process.env.SIM_STATE_FILE ?? join(__dirname, 'sim', '.state', 'sim-state.json'),
    loginGapSec: 15,
    exclude: [],
    adminEmail: process.env.SIM_ADMIN_EMAIL ?? 'sarah.chen@universal-logistics.example',
    password: process.env.SIM_PASSWORD ?? 'Onebook2026',
  };
  const num = (v: string | undefined, flag: string): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${flag} needs a non-negative number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const val = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case '--drivers': a.drivers = Math.floor(num(val(), flag)); break;
      case '--interval': a.intervalSec = Math.max(1, num(val(), flag)); break;
      case '--point-every': a.pointEverySec = Math.max(1, num(val(), flag)); break;
      case '--once': a.once = true; break;
      case '--stop': a.stop = true; break;
      case '--cleanup': a.cleanup = true; break;
      case '--dry-run': a.dryRun = true; break;
      case '--violation-drivers': a.violationDrivers = Math.floor(num(val(), flag)); break;
      case '--backfill-hours': a.backfillHours = Math.min(14, num(val(), flag)); break;
      case '--quick-start': a.quickStart = true; break;
      case '--duration': a.durationSec = num(val(), flag); break;
      case '--api': a.api = String(val()).replace(/\/$/, ''); break;
      case '--state': a.stateFile = resolve(String(val())); break;
      case '--login-gap': a.loginGapSec = Math.max(12, num(val(), flag)); break;
      case '--exclude': a.exclude = String(val()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--admin-email': a.adminEmail = String(val()); break;
      case '-h':
      case '--help':
        console.log(readFileSync(__filename, 'utf8').split('\n').slice(1, 8).join('\n'));
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown flag ${argv[i]} (see docs/driver-simulator.md)`);
    }
  }
  if (a.drivers > 99) throw new Error('--drivers max 99 (serials VPT30_SIM01..99)');
  return a;
}

// ============================================================================ state

interface SimDriverState {
  slot: number;
  username: string;
  driverId: string;
  vehicleId: string;
  unitNumber: string;
  deviceId: string;
  deviceSerial: string;
  /** True when the sim selected the unit (released again on cleanup). */
  selectedBySim: boolean;
  session: Session;
  sim: DriverSim;
  outbox: SimAction[];
  lastHeartbeatAt: number;
  stoppedManually: boolean;
  disabled?: string;
}

interface StateFile {
  version: 1;
  api: string;
  createdAt: string;
  admin: Session;
  drivers: SimDriverState[];
}

function loadState(file: string, args: Args): StateFile {
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, 'utf8')) as StateFile;
    if (s.api !== args.api) throw new Error(`State file ${file} belongs to ${s.api}, not ${args.api} (use --state)`);
    return s;
  }
  return {
    version: 1,
    api: args.api,
    createdAt: new Date().toISOString(),
    admin: { kind: 'user', login: args.adminEmail, accessToken: null, refreshToken: null },
    drivers: [],
  };
}

function saveState(file: string, s: StateFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// ============================================================================ helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`[sim ${ts()}] ${line}`);
const serialOf = (slot: number) => `VPT30_SIM${String(slot).padStart(2, '0')}`;
const isSimSerial = (s: string | null | undefined) => !!s && /^VPT30_SIM\d{2}$/.test(s);

interface FleetItem {
  vehicleId: string;
  unitNumber: string;
  driverId: string | null;
  odometerMi: number | null;
  eldSerial: string | null;
  dutyStatus: string;
  speedMph: number | null;
  lat: number | null;
  lon: number | null;
  lastSeenAt: string | null;
  driveRemainingSec: number | null;
}

interface DriverRow {
  id: string;
  username: string;
  status: string;
  homeTerminalTimezone: string;
  assignedVehicleId: string | null;
  eldExempt: boolean;
}

function must<T>(r: ApiResult<T>, what: string): T {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${r.code ?? ''} ${r.message ?? ''}`.trim());
  return r.data;
}

// ============================================================================ simulator

class DriverSimulator {
  readonly api: SimApi;
  readonly state: StateFile;
  private stopping = false;
  private readonly engineOpts: EngineOptions;
  private tick = 0;

  constructor(private readonly args: Args) {
    this.state = loadState(args.stateFile, args);
    this.api = new SimApi(args.api, args.password, args.loginGapSec * 1000, log, () => this.save());
    this.engineOpts = {
      pointEverySec: args.pointEverySec,
      // < the 300 s gap tolerance of the server E/L window checks, so a parked truck is not "silent".
      idlePointEverySec: Math.max(240, args.pointEverySec),
      quickStart: args.quickStart,
    };
  }

  save(): void {
    if (!this.args.dryRun) saveState(this.args.stateFile, this.state);
  }

  requestStop(): void {
    this.stopping = true;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  // ---------------------------------------------------------------- admin / preflight

  private async admin<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    return this.api.call<T>(this.state.admin, method, path, body);
  }

  /** Carrier must be eRODS TEST with the Virtual ELD switch on (enabled here, never mode-flipped). */
  async preflight(): Promise<void> {
    const carrier = must(
      await this.admin<{ erodsMode: string; virtualEldEnabled: boolean; virtualEldAvailable: boolean }>('GET', '/carrier'),
      'GET /carrier',
    );
    if (carrier.erodsMode !== 'TEST') {
      throw new Error(`Carrier erodsMode=${carrier.erodsMode}: the simulator only runs in TEST (not flipping it). Aborting.`);
    }
    if (!carrier.virtualEldAvailable) throw new Error('Virtual ELD not allowed by env (VIRTUAL_ELD_ALLOWED). Aborting.');
    if (!carrier.virtualEldEnabled) {
      if (this.args.dryRun) {
        log('dry-run: carrier.virtualEldEnabled=false — a real run would PATCH /carrier { virtualEldEnabled: true }');
      } else {
        must(await this.admin('PATCH', '/carrier', { virtualEldEnabled: true }), 'PATCH /carrier');
        log('carrier: virtualEldEnabled -> true (eRODS TEST)');
      }
    }
  }

  // ---------------------------------------------------------------- selection

  private async fleet(): Promise<FleetItem[]> {
    return must(await this.admin<{ items: FleetItem[] }>('GET', '/live/fleet'), 'GET /live/fleet').items;
  }

  /** Picks `want` new (driver, unit) pairs without touching excluded drivers or real-ELD units. */
  async plan(want: number): Promise<Array<{ driver: DriverRow; vehicle: FleetItem; select: boolean }>> {
    const drivers = must(
      await this.admin<{ items: DriverRow[] }>('GET', '/drivers?status=ACTIVE&limit=200'),
      'GET /drivers',
    ).items;
    const fleet = await this.fleet();
    const byVehicle = new Map(fleet.map((f) => [f.vehicleId, f]));
    const excluded = new Set([...ALWAYS_EXCLUDED, ...this.args.exclude]);
    const taken = new Set(this.state.drivers.map((d) => d.username));
    const takenUnits = new Set(this.state.drivers.map((d) => d.vehicleId));
    const usable = (f: FleetItem | undefined) => !!f && (f.eldSerial === null || isSimSerial(f.eldSerial));
    const pool = drivers
      .filter((d) => d.status === 'ACTIVE' && !d.eldExempt && !excluded.has(d.username) && !taken.has(d.username))
      .sort((x, y) => x.username.localeCompare(y.username));

    const out: Array<{ driver: DriverRow; vehicle: FleetItem; select: boolean }> = [];
    // 1) drivers who already hold a unit with no real PT30/PT40 on it — their own truck.
    for (const d of pool) {
      if (out.length >= want) break;
      const v = d.assignedVehicleId ? byVehicle.get(d.assignedVehicleId) : undefined;
      if (v && usable(v) && !takenUnits.has(v.vehicleId)) {
        out.push({ driver: d, vehicle: v, select: false });
        takenUnits.add(v.vehicleId);
      }
    }
    // 2) drivers without a unit + units nobody holds (never one of an excluded driver).
    const free = fleet
      .filter((f) => f.driverId === null && usable(f) && !takenUnits.has(f.vehicleId))
      .sort((x, y) => x.unitNumber.localeCompare(y.unitNumber, undefined, { numeric: true }));
    for (const d of pool) {
      if (out.length >= want || !free.length) break;
      if (d.assignedVehicleId) continue;
      const v = free.shift()!;
      out.push({ driver: d, vehicle: v, select: true });
      takenUnits.add(v.vehicleId);
    }
    return out;
  }

  // ---------------------------------------------------------------- setup

  private nextSlot(): number {
    const used = new Set(this.state.drivers.map((d) => d.slot));
    for (let s = 1; s <= 99; s++) if (!used.has(s)) return s;
    throw new Error('no free sim slot');
  }

  async setupOne(p: { driver: DriverRow; vehicle: FleetItem; select: boolean }): Promise<SimDriverState | null> {
    const slot = this.nextSlot();
    const session: Session = { kind: 'driver', login: p.driver.username, accessToken: null, refreshToken: null };
    const { driverId } = await this.api.login(session);
    if (driverId && driverId !== p.driver.id) throw new Error(`driverId mismatch for ${p.driver.username}`);

    if (p.select) {
      const r = await this.api.call(session, 'POST', '/mobile/select-vehicle', { vehicleId: p.vehicle.vehicleId });
      if (!r.ok) {
        log(`setup ${p.driver.username}: select-vehicle ${p.vehicle.unitNumber} -> ${r.status} ${r.code ?? ''}; skipped`);
        return null;
      }
    }
    const serial = serialOf(slot);
    const dev = await this.api.call<{ id: string; serial: string; vehicleId: string }>(session, 'POST', '/mobile/virtual-devices', {
      serial,
      model: 'PT30',
      firmware: 'V1.0.0',
    });
    if (!dev.ok) {
      log(`setup ${p.driver.username}: virtual-devices -> ${dev.status} ${dev.code ?? ''}; skipped`);
      if (p.select) await this.api.call(session, 'POST', '/mobile/release-vehicle', { reason: 'driver-sim setup aborted' });
      return null;
    }

    const now = Date.now();
    const route = ROUTES[slot % ROUTES.length];
    const len = routeLengthMi(route);
    const startDist = ((slot * 137.31) % (len * 0.9)) + len * 0.05;
    const backfillMs = this.args.backfillHours * 3600_000;
    const simAt = now - backfillMs;
    const sim = initDriver({
      slot,
      routeId: route.id,
      startDistMi: startDist,
      dir: slot % 2 === 0 ? 1 : -1,
      odometerKm: (p.vehicle.odometerMi ?? 100_000 + slot * 1_000) * 1.609344,
      tz: p.driver.homeTerminalTimezone || 'America/New_York',
      violation: slot <= this.args.violationDrivers,
      simAt,
      shiftStartAt: simAt + ((slot - 1) % 12) * 10_000,
      seed: slot * 2654435761,
    });
    const d: SimDriverState = {
      slot,
      username: p.driver.username,
      driverId: p.driver.id,
      vehicleId: p.vehicle.vehicleId,
      unitNumber: p.vehicle.unitNumber,
      deviceId: dev.data.id,
      deviceSerial: serial,
      selectedBySim: p.select,
      session,
      sim,
      outbox: [],
      lastHeartbeatAt: 0,
      stoppedManually: false,
    };
    await this.connect(d);
    if (backfillMs > 0) {
      d.outbox.push(...step(sim, now, this.engineOpts));
      log(`setup ${d.username}: backfill ${this.args.backfillHours}h -> ${d.outbox.length} actions queued`);
    }
    this.state.drivers.push(d);
    this.save();
    log(`setup #${slot} ${d.username} unit ${d.unitNumber} ${serial} route ${route.id}${p.select ? ' (selected)' : ''}${sim.violation ? ' [violation]' : ''}`);
    return d;
  }

  /** App connects to the PT30 over BLE: CONNECTED + a device-status heartbeat. */
  private async connect(d: SimDriverState): Promise<void> {
    await this.api.call(d.session, 'POST', '/ingest/ble-state', {
      deviceSerial: d.deviceSerial,
      state: 'CONNECTED',
      at: new Date().toISOString(),
      connectionType: 'BLE',
    });
    await this.heartbeat(d);
  }

  private async heartbeat(d: SimDriverState): Promise<void> {
    const r = await this.api.call(d.session, 'POST', '/ingest/device-status', {
      deviceSerial: d.deviceSerial,
      storedEventsCount: 0,
      mainFirmware: 'V1.0.0',
      sdkVersion: '6.11.1',
      productName: 'PT30',
      connectionType: 'BLE',
      busType: 'J1939',
      appPlatform: 'ANDROID',
    });
    if (r.ok) d.lastHeartbeatAt = Date.now();
    this.checkDisabled(d, r);
  }

  private checkDisabled(d: SimDriverState, r: ApiResult): void {
    if (r.status === 403) {
      d.disabled = `${r.code ?? 'FORBIDDEN'} ${r.message ?? ''}`.trim();
      log(`driver ${d.username}: disabled — ${d.disabled}`);
    }
  }

  async setupMissing(): Promise<void> {
    const want = this.args.drivers - this.state.drivers.length;
    if (want <= 0) return;
    const plan = await this.plan(want);
    if (plan.length < want) log(`only ${plan.length} eligible driver/unit pairs for ${want} requested`);
    for (const p of plan) {
      if (this.stopping) return;
      try {
        await this.setupOne(p);
      } catch (err) {
        log(`setup ${p.driver.username}: ${(err as Error).message}`);
      }
    }
  }

  // ---------------------------------------------------------------- flushing

  /** Sends the outbox in app order: telemetry, raw device events, then RODS records + taps. */
  private async flush(d: SimDriverState, counters: Record<string, number>): Promise<void> {
    if (d.disabled || !d.outbox.length) return;
    const points = d.outbox.filter((a) => a.kind === 'point');
    const devEvents = d.outbox.filter((a) => a.kind === 'deviceEvent');
    const rods = d.outbox.filter((a) => a.kind === 'event' || a.kind === 'duty');
    const keep: SimAction[] = [];

    if (points.length) {
      const batch = points.slice(0, 500);
      const r = await this.api.call(d.session, 'POST', '/ingest/telemetry', {
        deviceSerial: d.deviceSerial,
        vehicleId: d.vehicleId,
        points: batch.map((a) => (a as Extract<SimAction, { kind: 'point' }>).point),
      });
      this.checkDisabled(d, r);
      if (this.retryable(r)) keep.push(...points);
      else {
        if (!r.ok) log(`${d.username} telemetry ${r.status} ${r.code ?? ''} ${r.message ?? ''} (dropped)`);
        else counters.pts += batch.length;
        keep.push(...points.slice(500));
      }
    }
    if (devEvents.length && !d.disabled) {
      const batch = devEvents.slice(0, 500);
      const r = await this.api.call(d.session, 'POST', '/ingest/device-events', {
        deviceSerial: d.deviceSerial,
        vehicleId: d.vehicleId,
        events: batch.map((a) => (a as Extract<SimAction, { kind: 'deviceEvent' }>).event),
      });
      this.checkDisabled(d, r);
      if (this.retryable(r)) keep.push(...devEvents);
      else {
        if (!r.ok) log(`${d.username} device-events ${r.status} ${r.code ?? ''} (dropped)`);
        else counters.dev += batch.length;
        keep.push(...devEvents.slice(500));
      }
    }
    let i = 0;
    while (i < rods.length && !d.disabled) {
      const a = rods[i];
      if (a.kind === 'duty') {
        const r = await this.api.call(d.session, 'POST', '/mobile/duty-status', {
          status: a.status,
          startAt: a.at,
          location: { lat: a.lat, lon: a.lon },
        });
        if (this.retryable(r)) break;
        if (!r.ok) log(`${d.username} duty-status ${a.status} ${r.status} ${r.code ?? ''} ${r.message ?? ''} (dropped)`);
        else counters.duty++;
        i++;
        continue;
      }
      let j = i;
      while (j < rods.length && rods[j].kind === 'event' && j - i < 500) j++;
      const batch = rods.slice(i, j).map((x) => (x as Extract<SimAction, { kind: 'event' }>).event);
      const r = await this.api.call<{ warnings?: Array<{ code: string }> }>(d.session, 'POST', '/ingest/events', {
        deviceSerial: d.deviceSerial,
        vehicleId: d.vehicleId,
        sdkVersion: '6.11.1',
        batch,
      });
      this.checkDisabled(d, r);
      if (this.retryable(r)) break;
      if (!r.ok) log(`${d.username} events ${r.status} ${r.code ?? ''} ${r.message ?? ''} (dropped ${batch.length})`);
      else {
        counters.ev += batch.length;
        if (r.status === 202) counters.warn += r.data?.warnings?.length ?? 0;
      }
      i = j;
    }
    keep.push(...rods.slice(i));
    // Keep chronological-ish order for the next attempt (points/device events are order-free).
    d.outbox = keep;
  }

  /** 429 / network / 5xx -> keep for the next tick. Any other 4xx is permanent. */
  private retryable(r: ApiResult): boolean {
    return r.status === 429 || r.status === 0 || r.status >= 500 || r.status === 401;
  }

  // ---------------------------------------------------------------- run modes

  private readyDrivers(): SimDriverState[] {
    return this.state.drivers.filter((d) => !d.disabled);
  }

  /** Called once per run: reconnect BLE and restart drivers that were stopped by --stop/SIGINT. */
  async resumeExisting(): Promise<void> {
    const now = Date.now();
    // A 403 (switch off, unit reassigned) is re-checked on every start: connect() re-disables.
    for (const d of this.state.drivers) d.disabled = undefined;
    for (const d of this.readyDrivers()) {
      if (d.sim.violation !== d.slot <= this.args.violationDrivers && this.args.violationDrivers > 0) {
        d.sim.violation = d.slot <= this.args.violationDrivers;
      }
      if (now - d.sim.simAt > 10 * 60_000) resumeAfterGap(d.sim, now);
      if (d.stoppedManually && d.sim.phase === 'REST') {
        d.sim.phaseUntil = now + ((d.slot - 1) % 12) * 10_000;
        d.stoppedManually = false;
      }
      await this.connect(d);
    }
    this.save();
  }

  async runTick(): Promise<void> {
    const started = Date.now();
    this.tick++;
    this.api.resetStats();
    const counters: Record<string, number> = { pts: 0, ev: 0, duty: 0, dev: 0, warn: 0 };
    const drivers = this.readyDrivers();
    const slotMs = drivers.length ? (this.args.intervalSec * 1000 * 0.8) / drivers.length : 0;
    for (let k = 0; k < drivers.length; k++) {
      if (this.stopping) break;
      const d = drivers[k];
      const due = started + k * slotMs;
      if (!this.args.once && due > Date.now()) await sleep(due - Date.now());
      const now = Date.now();
      if (now - d.sim.simAt > 10 * 60_000) resumeAfterGap(d.sim, now);
      d.outbox.push(...step(d.sim, now, this.engineOpts));
      await this.flush(d, counters);
      if (now - d.lastHeartbeatAt >= 5 * 60_000) await this.heartbeat(d);
    }
    this.save();
    const by: Record<string, number> = { OFF: 0, SB: 0, ON: 0, D: 0 };
    let moving = 0;
    for (const d of drivers) {
      by[d.sim.duty]++;
      if (d.sim.speedMph > 5) moving++;
    }
    const s = this.api.stats;
    const pending = drivers.reduce((n, d) => n + d.outbox.length, 0);
    log(
      `tick ${this.tick} drivers ${drivers.length}/${this.args.drivers} | OFF ${by.OFF} ON ${by.ON} D ${by.D} SB ${by.SB} moving ${moving}` +
        ` | sent pts ${counters.pts} ev ${counters.ev} duty ${counters.duty} dev ${counters.dev}${counters.warn ? ` warn ${counters.warn}` : ''}` +
        ` | http ok ${s.ok} 429 ${s.throttled} err ${s.errors}${pending ? ` pending ${pending}` : ''} | ${Date.now() - started}ms`,
    );
  }

  /** Every driver pulls over and goes OFF DUTY now; BLE link dropped (app closed). */
  async stopAll(): Promise<void> {
    const counters: Record<string, number> = { pts: 0, ev: 0, duty: 0, dev: 0, warn: 0 };
    const now = Date.now();
    for (const d of this.readyDrivers()) {
      if (now - d.sim.simAt > 10 * 60_000) resumeAfterGap(d.sim, now);
      else d.outbox.push(...step(d.sim, now, this.engineOpts));
      d.outbox.push(...goOffDuty(d.sim, now));
      await this.flush(d, counters);
      await this.api.call(d.session, 'POST', '/ingest/ble-state', {
        deviceSerial: d.deviceSerial,
        state: 'DISCONNECTED',
        at: new Date().toISOString(),
        connectionType: 'BLE',
      });
      d.stoppedManually = true;
    }
    this.save();
    log(`stopped: ${this.readyDrivers().length} drivers OFF DUTY (duty ${counters.duty}, ev ${counters.ev}, pts ${counters.pts})`);
  }

  async cleanup(): Promise<void> {
    await this.stopAll();
    for (const d of this.state.drivers) {
      const r = await this.admin('POST', `/devices/${d.deviceId}/unpair`);
      log(`cleanup ${d.username}: unpair ${d.deviceSerial} -> ${r.status}`);
      if (d.selectedBySim) {
        const rr = await this.api.call(d.session, 'POST', '/mobile/release-vehicle', { reason: 'driver-sim cleanup' });
        log(`cleanup ${d.username}: release unit ${d.unitNumber} -> ${rr.status} ${rr.code ?? ''}`);
      }
    }
    const archived = this.args.stateFile.replace(/\.json$/, `.cleaned-${Date.now()}.json`);
    saveState(this.args.stateFile, this.state);
    renameSync(this.args.stateFile, archived);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    log(`cleanup done; state archived to ${archived}`);
    log(`virtual telemetry / raw events (RODS are never deleted): npm run virtual-eld:purge -- --before=${tomorrow} --dry-run`);
  }

  async dryRun(): Promise<void> {
    await this.preflight();
    const want = Math.max(0, this.args.drivers - this.state.drivers.length);
    const plan = await this.plan(want);
    log(`dry-run: ${this.state.drivers.length} drivers in state, ${plan.length} new pairs would be set up:`);
    plan.forEach((p, i) =>
      log(`  ${String(i + 1).padStart(2)} ${p.driver.username.padEnd(20)} unit ${p.vehicle.unitNumber.padEnd(5)} ${p.select ? 'select-vehicle' : 'own unit'} route ${ROUTES[(i + 1) % ROUTES.length].id}`),
    );
    const now = Date.now();
    const demo = initDriver({
      slot: 1,
      routeId: ROUTES[1].id,
      startDistMi: 100,
      dir: 1,
      odometerKm: 160_000,
      tz: 'America/Chicago',
      violation: false,
      simAt: now - 30 * 60_000,
      shiftStartAt: now - 30 * 60_000,
      seed: 42,
    });
    const actions = step(demo, now, this.engineOpts);
    const kinds = actions.reduce<Record<string, number>>((m, a) => ((m[a.kind] = (m[a.kind] ?? 0) + 1), m), {});
    log(`dry-run: a driver 30 min into a shift would have sent ${JSON.stringify(kinds)}; nothing was written.`);
  }
}

// ============================================================================ main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sim = new DriverSimulator(args);
  log(`api ${args.api} · state ${args.stateFile} · drivers ${args.drivers} · interval ${args.intervalSec}s · point every ${args.pointEverySec}s`);

  if (args.dryRun) return sim.dryRun();
  if (args.stop) return sim.stopAll();
  if (args.cleanup) return sim.cleanup();

  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      log(`${sig} again — exiting without OFF DUTY`);
      process.exit(130);
    }
    log(`${sig} — finishing the current step, then every driver goes OFF DUTY`);
    sim.requestStop();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  await sim.preflight();
  await sim.resumeExisting();

  if (args.once) {
    await sim.setupMissing();
    await sim.runTick();
    return;
  }

  // Logins are paced (5/min/IP); drivers start ticking as soon as each one is set up.
  const setup = sim.setupMissing().catch((err: Error) => log(`setup: ${err.message}`));
  const endAt = args.durationSec > 0 ? Date.now() + args.durationSec * 1000 : Infinity;
  while (!sim.isStopping && Date.now() < endAt) {
    const t0 = Date.now();
    await sim.runTick();
    const wait = t0 + args.intervalSec * 1000 - Date.now();
    for (let w = 0; w < wait && !sim.isStopping; w += 250) await sleep(Math.min(250, wait - w));
  }
  sim.requestStop();
  await setup;
  await sim.stopAll();
}

main().then(
  () => process.exit(0),
  (err: Error) => {
    console.error(`[sim] fatal: ${err.message}`);
    process.exit(1);
  },
);
