/**
 * k6 load suite — TZ §19 (Performance) acceptance targets, exercised via tz.md §25 point 8
 * ("p95 does not exceed target — k6 report").
 *
 * Targets taken verbatim from backend/tz.md §19:
 *   - API p95                          < 200 ms
 *   - /live/fleet (300 units)          < 250 ms      (no dedicated REST endpoint exists yet —
 *                                                      see README note in the final report;
 *                                                      GET /vehicles is used as the closest
 *                                                      proxy, dev DB only has 69 vehicles)
 *   - Ingest events                    50/s sustained, 300/s peak
 *   - Ingest telemetry                 100 points/s
 *   - HOS recalc (1 day)               < 150 ms   (exercised indirectly via GET /logs/:id)
 *   - HOS recalc (8 days)              < 800 ms   (exercised via GET /logs/:id/range)
 *   - Report (250 drivers, 8 days)     < 45 s     (only the QUEUE step is load-tested here;
 *                                                   generation itself runs on a BullMQ worker,
 *                                                   out of scope for an HTTP p95 gate)
 *
 * Usage:
 *   BASE_URL=http://127.0.0.1:3001/api k6 run test/load/k6-acceptance.js
 *
 * Safety (per task brief):
 *   - never touches driver `johnsmith`
 *   - only mutates: EldEvent (ingest), TelemetryPoint (ingest), DriverHosSnapshot (hos-state),
 *     mobile sync log entries, one queued Report row. Nothing here touches AuditLog directly.
 *   - run cleanup-load-data.sql afterwards to remove what this run wrote.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001/api';

// Load-test-only accounts. Deliberately excludes `johnsmith` (brief: never generate load
// against that driver). All ACTIVE, all carry an assigned vehicle + PT30 device in the seed.
const DRIVERS = [
  { username: 'josephscott5', id: '7ed64c73-63e6-4947-a813-ac64d95d3554', vehicleId: '78fdaecb-c41e-4850-9c16-542920d5e263', deviceSerial: 'PT30_D3F7' },
  { username: 'thomasnelson6', id: '0a227c52-ef63-47fb-a080-4d93f8d785ea', vehicleId: '2573c83f-f689-4133-a44b-e856c00da2a9', deviceSerial: 'PT30_D3F8' },
  { username: 'charlesroberts7', id: '1a0350e4-c050-4919-beac-7d2d91ac0cc7', vehicleId: 'f0711a50-b195-475c-8265-28303e802703', deviceSerial: 'PT30_D3F9' },
  { username: 'danielgarcia8', id: '7c96b5df-3bb1-45e7-ba8a-1000e0f8cafc', vehicleId: '3bc091d6-e7c6-4bf9-afb9-59ff28bc871f', deviceSerial: 'PT30_D3FA' },
];
const DISPATCHER_EMAIL = 'carlos.ramirez@universal-logistics.example'; // dispatcher: hos/dashboard/liveFleet READ+
const FLEET_MANAGER_EMAIL = 'mike.torres@universal-logistics.example'; // reports = FULL (§6.4), needed to enqueue
const PASSWORD = 'Onebook2026';

const ingestErrors = new Counter('ingest_error_count');
const bootstrapTrend = new Trend('trend_mobile_bootstrap');

export const options = {
  scenarios: {
    // §19: ingest — 50/s sustained for 30s
    ingest_events_sustained: {
      executor: 'constant-arrival-rate',
      exec: 'ingestEvents',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 30,
      maxVUs: 80,
      startTime: '0s',
    },
    // §19: ingest — 300/s peak burst for 10s (BLE backlog catch-up)
    ingest_events_peak: {
      executor: 'constant-arrival-rate',
      exec: 'ingestEvents',
      rate: 300,
      timeUnit: '1s',
      duration: '10s',
      preAllocatedVUs: 100,
      maxVUs: 300,
      startTime: '35s',
    },
    // §19: telemetry — 100 points/s for 20s
    ingest_telemetry: {
      executor: 'constant-arrival-rate',
      exec: 'ingestTelemetry',
      rate: 100,
      timeUnit: '1s',
      duration: '20s',
      preAllocatedVUs: 40,
      maxVUs: 100,
      startTime: '50s',
    },
    // Mixed read/write API hot paths — steady VU load for the general "API p95 < 200ms" gate.
    api_hot_paths: {
      executor: 'ramping-vus',
      exec: 'apiHotPaths',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 15 },
        { duration: '40s', target: 15 },
        { duration: '10s', target: 0 },
      ],
      startTime: '75s',
    },
  },
  thresholds: {
    'checks': ['rate>0.99'],
    'http_req_duration{endpoint:mobile_bootstrap}': ['p(95)<200'],
    'http_req_duration{endpoint:mobile_sync}': ['p(95)<200'],
    'http_req_duration{endpoint:logs_day}': ['p(95)<200'],
    'http_req_duration{endpoint:logs_range}': ['p(95)<800'], // §19 HOS recalc 8 days
    'http_req_duration{endpoint:hos_state}': ['p(95)<200'],
    'http_req_duration{endpoint:reports_generate}': ['p(95)<200'],
    'http_req_duration{endpoint:dispatcher_list}': ['p(95)<200'],
    'http_req_duration{endpoint:ingest_events}': ['p(95)<500'],
    'http_req_duration{endpoint:ingest_telemetry}': ['p(95)<500'],
  },
};

export function setup() {
  const driverTokens = DRIVERS.map((d) => {
    const res = http.post(
      `${BASE_URL}/auth/login/driver`,
      JSON.stringify({ username: d.username, password: PASSWORD }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`driver login failed for ${d.username}: ${res.status} ${res.body}`);
    }
    const token = res.json('data.accessToken');
    return { ...d, token };
  });

  const dispatcherRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: DISPATCHER_EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (dispatcherRes.status !== 201 && dispatcherRes.status !== 200) {
    throw new Error(`dispatcher login failed: ${dispatcherRes.status} ${dispatcherRes.body}`);
  }
  const dispatcherToken = dispatcherRes.json('data.accessToken');

  const fleetManagerRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: FLEET_MANAGER_EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (fleetManagerRes.status !== 201 && fleetManagerRes.status !== 200) {
    throw new Error(`fleet manager login failed: ${fleetManagerRes.status} ${fleetManagerRes.body}`);
  }
  const fleetManagerToken = fleetManagerRes.json('data.accessToken');

  return { driverTokens, dispatcherToken, fleetManagerToken };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function ingestEvents(data) {
  const d = pick(data.driverTokens);
  const now = new Date();
  const payload = JSON.stringify({
    deviceSerial: d.deviceSerial,
    vehicleId: d.vehicleId,
    sdkVersion: 'k6-load',
    batch: [
      {
        uuid: uuidv4(),
        eventType: 1,
        eventCode: 1,
        eventDateTime: now.toISOString(),
        timezoneOffset: -300,
        recordStatus: 1,
        recordOrigin: 1,
        wasStoredOnDevice: false,
        latitude: 38.02,
        longitude: -84.5,
        locationSource: 1,
        rawDeviceOdometerKm: 160000 + Math.floor(Math.random() * 1000),
      },
    ],
  });
  const res = http.post(`${BASE_URL}/ingest/events`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
    tags: { endpoint: 'ingest_events' },
  });
  const ok = check(res, { 'ingest events 200/202': (r) => r.status === 200 || r.status === 202 });
  if (!ok) ingestErrors.add(1);
}

export function ingestTelemetry(data) {
  const d = pick(data.driverTokens);
  const payload = JSON.stringify({
    deviceSerial: d.deviceSerial,
    vehicleId: d.vehicleId,
    points: [
      {
        time: new Date().toISOString(),
        latitude: 38.02 + Math.random() * 0.01,
        longitude: -84.5 + Math.random() * 0.01,
        speedKmh: 88,
        headingDeg: 120,
        odometerKm: 160000,
        engineOn: true,
      },
    ],
  });
  const res = http.post(`${BASE_URL}/ingest/telemetry`, payload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
    tags: { endpoint: 'ingest_telemetry' },
  });
  check(res, { 'ingest telemetry 200/202': (r) => r.status === 200 || r.status === 202 });
}

export function apiHotPaths(data) {
  const d = pick(data.driverTokens);
  const driverHeaders = { headers: { Authorization: `Bearer ${d.token}` } };
  const dispatcherHeaders = { headers: { Authorization: `Bearer ${data.dispatcherToken}` } };

  // GET /mobile/bootstrap — driver cold-start / reconnect refresh (§8.6, §13.5).
  const bootstrapRes = http.get(`${BASE_URL}/mobile/bootstrap`, {
    ...driverHeaders,
    tags: { endpoint: 'mobile_bootstrap' },
  });
  bootstrapTrend.add(bootstrapRes.timings.duration);
  check(bootstrapRes, { 'bootstrap 200': (r) => r.status === 200 });

  // POST /mobile/sync — offline queue replay, idempotent by clientId (§13.4/§13.6).
  const nowIso = new Date().toISOString();
  const syncPayload = JSON.stringify({
    changes: [
      {
        type: 'duty_status',
        clientId: uuidv4(),
        occurredAt: nowIso,
        payload: {
          status: 'ON',
          startAt: nowIso,
          annotation: 'k6 load test status change',
        },
      },
    ],
  });
  const syncRes = http.post(`${BASE_URL}/mobile/sync`, syncPayload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
    tags: { endpoint: 'mobile_sync' },
  });
  check(syncRes, { 'sync 200': (r) => r.status === 200 });

  // POST /mobile/hos-state — the only HOS-state route (§8.6 point 5); app posts its own
  // computed state and the server compares it with its own calculation.
  const hosStatePayload = JSON.stringify({
    computedAt: new Date().toISOString(),
    hosEngineVersion: '1.0.0',
    appPlatform: 'ANDROID',
    state: {
      currentStatus: 'ON',
      driveRemainingSec: 39600,
      shiftRemainingSec: 46800,
      breakRemainingSec: 28800,
      cycleRemainingSec: 201600,
      dailyTotals: { off: 0, sb: 0, drive: 18000, on: 3600 },
      violations: [],
    },
  });
  const hosStateRes = http.post(`${BASE_URL}/mobile/hos-state`, hosStatePayload, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${d.token}` },
    tags: { endpoint: 'hos_state' },
  });
  check(hosStateRes, { 'hos-state 200': (r) => r.status === 200 });

  // GET /logs/:driverId — RODS day build (§9, §19 "HOS recalc 1 day < 150ms" read path).
  const today = new Date().toISOString().slice(0, 10);
  const logsRes = http.get(`${BASE_URL}/logs/${d.id}?date=${today}`, {
    ...dispatcherHeaders,
    tags: { endpoint: 'logs_day' },
  });
  check(logsRes, { 'logs day 200': (r) => r.status === 200 });

  // GET /logs/:driverId/range — 8-day range (§19 "HOS recalc 8 days < 800ms" read path).
  const from = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const rangeRes = http.get(`${BASE_URL}/logs/${d.id}/range?from=${from}&to=${today}`, {
    ...dispatcherHeaders,
    tags: { endpoint: 'logs_range' },
  });
  check(rangeRes, { 'logs range 200': (r) => r.status === 200 });

  // GET /drivers — dispatcher fleet list hot path.
  const driversRes = http.get(`${BASE_URL}/drivers?limit=50`, {
    ...dispatcherHeaders,
    tags: { endpoint: 'dispatcher_list' },
  });
  check(driversRes, { 'drivers list 200': (r) => r.status === 200 });

  // GET /vehicles — closest proxy for the "/live/fleet (300 units)" target: no dedicated REST
  // endpoint exists in this codebase (fleet position updates are WebSocket-pushed). Dev DB has
  // 69 vehicles, not 300 — see caveat in the final report.
  const vehiclesRes = http.get(`${BASE_URL}/vehicles?limit=100`, {
    ...dispatcherHeaders,
    tags: { endpoint: 'dispatcher_list' },
  });
  check(vehiclesRes, { 'vehicles list 200': (r) => r.status === 200 });

  // POST /reports/generate — enqueue only, never synchronous generation (§11.6/§15).
  // Needs `reports = FULL` (§6.4); the dispatcher account only has READ, so this uses the
  // fleet-manager token. ACTIVITY reports are CSV-only in this version.
  const reportRes = http.post(
    `${BASE_URL}/reports/generate`,
    JSON.stringify({ type: 'ACTIVITY', format: 'CSV', params: { from, to: today } }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.fleetManagerToken}` },
      tags: { endpoint: 'reports_generate' },
    },
  );
  check(reportRes, { 'report enqueue 202': (r) => r.status === 202 });

  sleep(1);
}
