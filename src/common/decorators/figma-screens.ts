/**
 * Figma screen registry — tasks.md Global gate "Every new endpoint links to at least one
 * Figma screen".
 *
 * SOURCE OF TRUTH. The Figma file itself (`ELD Software new`, 247 screens per tz.md §1)
 * is not in this repo. What *is* available is the exported role guides in
 * `eld.docs/web/` — one page per screen, each page captioned with the screen's Figma
 * name ("Sign in", "Fleet Dashboard", "Add vehicle", "Settings · Users", ...) plus the
 * sidebar/sub-nav labels visible in those screenshots. Every id below is transcribed
 * from those exports, with the file and page it came from, so a reviewer can open the
 * page and see the screen an endpoint claims to serve.
 *
 * ⚠️ TABLET AND MOBILE SCREENS ARE NOT AVAILABLE. `eld.docs/planshet/` (44 screens) and
 * `eld.docs/mobile/` (92 screens) are empty directories in this checkout, so no id can be
 * transcribed for the driver-app-only endpoints (ingest, mobile RODS, BLE pairing,
 * driver HOS state). Those routes are listed in `FIGMA_UNMAPPED_ROUTES` instead of being
 * given an invented link — inventing one would make the gate lie. Add the ids and delete
 * the entries once the tablet/mobile exports land.
 *
 * Ids are machine-checked: `@FigmaScreen()` only accepts a key of this object, and
 * `test/e2e/openapi-contract.e2e-spec.ts` asserts every documented operation carries one.
 */
export const FIGMA_SCREENS = {
  // --- web back office: OneBook-ELD-admin.pdf (role guide, 1 page per screen) ---------
  'web/sign-in': { title: 'Sign in', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.3' },
  'web/my-profile': { title: 'My profile · Active sessions', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.4' },
  'web/fleet-dashboard': { title: 'Fleet Dashboard', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.5' },
  'web/live-fleet': { title: 'Live Fleet', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.7' },
  'web/vehicles': { title: 'Vehicles', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.8' },
  'web/vehicle-add': { title: 'Add vehicle', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.9' },
  'web/drivers': { title: 'Drivers', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.11' },
  'web/driver-add': { title: 'Add driver', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.12' },
  'web/hos-logs': { title: 'Hours of Service · Driver log', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.13' },
  'web/log-edit-request': { title: 'Request a log edit', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.14' },
  'web/certify-logs': { title: 'Certify logs', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.15' },
  'web/send-logs-to-safety-official': {
    title: 'Send logs to a safety official',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.16',
  },
  'web/dvir-maintenance': { title: 'DVIR & Maintenance', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.17' },
  'web/create-work-order': { title: 'Create work order', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.18' },
  'web/safety': { title: 'Safety', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.19' },
  'web/reports-ifta': { title: 'Reports · IFTA', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.20' },
  'web/reports-fmcsa-audit-pack': {
    title: 'Reports · FMCSA / DOT audit pack',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.21',
  },
  'web/settings-users': { title: 'Settings · Users', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22' },
  'web/settings-roles-permissions': {
    title: 'Settings · Roles & permissions',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.23',
  },
  'web/settings-billing': { title: 'Settings · Billing & subscription', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.24' },
  'web/settings-audit-log': { title: 'Settings · Audit log', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.25' },

  // --- Settings sub-navigation (labels visible in the Settings screenshots, p.22-25) --
  'web/settings-company-profile': {
    title: 'Settings · Company profile',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)',
  },
  'web/settings-eld-devices': {
    title: 'Settings · ELD devices',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28',
  },
  'web/settings-alert-rules': {
    title: 'Settings · Alert rules',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)',
  },
  'web/settings-integrations': {
    title: 'Settings · Integrations',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav); referenced again on p.28',
  },
  'web/settings-support': {
    title: 'Settings · Support',
    source: 'eld.docs/web/OneBook-ELD-admin.pdf p.22 (Settings sub-nav)',
  },

  // --- main sidebar entries (visible on every web screenshot, p.5 onwards) ------------
  'web/dispatch-trips': { title: 'Dispatch & Trips', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)' },
  'web/messages': { title: 'Messages', source: 'eld.docs/web/OneBook-ELD-admin.pdf p.5 (sidebar)' },
} as const;

export type FigmaScreenId = keyof typeof FIGMA_SCREENS;

/**
 * Routes that legitimately have no Figma screen to link to yet, with the reason.
 * Keys are `METHOD /api-path` exactly as they appear in the generated OpenAPI document.
 * This list is the gate's escape hatch and must stay short and justified — it is the
 * reason the "every new endpoint links to a Figma screen" gate is still unchecked.
 */
export const FIGMA_UNMAPPED_ROUTES: Record<string, string> = {
  // Infrastructure, not a product screen.
  'GET /health/live': 'Liveness probe — infrastructure endpoint, no UI.',
  'GET /health/ready': 'Readiness probe — infrastructure endpoint, no UI.',
  'GET /health/deep': 'Deep dependency probe — infrastructure endpoint, no UI.',
  'GET /metrics': 'Prometheus scrape endpoint — infrastructure, no UI.',
  // App→server sync, no designed screen (the mobile/tablet Figma exports are missing).
  'POST /api/ingest/events': 'Driver app → server §395 event upload (TZ §7.1). Background sync, no screen of its own.',
  'POST /api/ingest/telemetry': 'Driver app → server Virtual Dashboard points (TZ §7.5). Background sync, no screen.',
  // Driver-app screens live in eld.docs/planshet + eld.docs/mobile, which are empty here.
  'POST /api/mobile/log-entries': 'Driver app "Logs → Add entry" — tablet/mobile Figma export missing from eld.docs.',
  'POST /api/mobile/certify': 'Driver app "Logs → Certify" — tablet/mobile Figma export missing from eld.docs.',
  'GET /api/mobile/log-edit-requests': 'Driver app "Logs → Carrier edit requests" — tablet/mobile Figma export missing.',
  'GET /api/mobile/logs': 'Driver app "Logs → Day view" — tablet/mobile Figma export missing from eld.docs.',
  'POST /api/mobile/hos-state': 'Driver app HOS engine sync (TZ §8.6) — tablet/mobile Figma export missing.',
  'GET /api/mobile/bootstrap': 'Driver app cold-start context (TZ §11.8/§13.2) — tablet/mobile Figma export missing.',
  'POST /api/mobile/sync': 'Driver app offline sync queue (TZ §13.4) — tablet/mobile Figma export missing.',
  'POST /api/mobile/duty-status': 'Driver app duty-status button (TZ §9.3/§13.2) — tablet/mobile Figma export missing.',
  'POST /api/mobile/signature': 'Driver app signature capture (TZ §6/§13.2) — tablet/mobile Figma export missing.',
  'POST /api/mobile/dvir': 'Driver app DVIR submission (TZ §5.10/§13.2) — tablet/mobile Figma export missing.',
  'POST /api/mobile/transfers': 'Driver app M-28 "Send logs (eRODS)" (mobile/tz.md MB-4) — tablet/mobile Figma export missing.',
  'GET /api/mobile/transfers': 'Driver app S-10 eRODS receipt / M-27 "Last transfer" (mobile/tz.md MB-4) — tablet/mobile Figma export missing.',
  'GET /api/mobile/logs/{date}/export': 'Driver app P-05 "Download" one RODS day (mobile/tz.md MB-18) — tablet/mobile Figma export missing.',
  'POST /api/mobile/feedback': 'Driver app M-22 "Feedback" (mobile/tz.md MB-16) — screens live in mobile/mobile app/, not eld.docs.',
  'POST /api/mobile/support/tickets': 'Driver app M-30 "Customer support" / M-20 "Send diagnostics" (mobile/tz.md MB-16).',
  'GET /api/mobile/support/tickets': 'Driver app M-30 "My tickets" (mobile/tz.md MB-16).',
  'GET /api/mobile/available-vehicles': 'Driver app M-03 "Select your unit" (mobile/tz.md MB-2).',
  'POST /api/mobile/select-vehicle': 'Driver app M-03 unit row tap (mobile/tz.md MB-2).',
  'POST /api/mobile/co-driver/switch': 'Driver app S-11/S-18 "Switch to co-driver" (mobile/tz.md MB-3).',
  'POST /api/mobile/co-driver/leave': 'Driver app S-19 "Leave the truck" (mobile/tz.md MB-3).',
  'GET /api/mobile/trip': 'Driver app M-05/P-03 "Trip details" + Home trip card (mobile/tz.md MB-5).',
  'PATCH /api/mobile/trip': 'Driver app M-05 "Save trip details" / S-05 (mobile/tz.md MB-5).',
  'GET /api/mobile/dvirs': 'Driver app M-10/P-07 DVIR history (mobile/tz.md MB-10).',
  'GET /api/mobile/dvirs/{id}': 'Driver app M-11 DVIR detail (mobile/tz.md MB-10).',
  'GET /api/mobile/dvirs/{id}/pdf': 'Driver app M-11 "Download" (mobile/tz.md MB-10) — 501 until a per-DVIR template exists.',
  'GET /api/mobile/contacts': 'Driver app M-15 "+" new conversation / M-16 call button (mobile/tz.md MB-14).',
  'POST /api/mobile/push-tokens': 'Driver app FCM registration on login (mobile/tz.md MB-1, §10.2).',
  'DELETE /api/mobile/push-tokens/{token}': 'Driver app FCM token removal on logout (mobile/tz.md MB-1, S-12).',
  'GET /api/mobile/device-health': 'Driver app M-20/P-12 "Diagnosis of device" (mobile/tz.md MB-7).',
  'GET /api/mobile/conversations': 'Driver app M-15/P-09 Messages list (mobile/tz.md MB-15).',
  'GET /api/mobile/conversations/{id}/messages': 'Driver app M-16 conversation thread (mobile/tz.md MB-15).',
  'POST /api/mobile/conversations/{id}/messages': 'Driver app M-16 composer / quick replies (mobile/tz.md MB-15).',
  'POST /api/mobile/conversations/{id}/read': 'Driver app M-16 open-thread read receipt (mobile/tz.md MB-15).',
  // Mobile requests 2026-10-08 (docs/mobile-requests-2026-10-08.md) — mobile Figma export still missing from eld.docs.
  'GET /api/mobile/app-config': 'Driver app pre-login update gate / About (MR-7) — public; mobile Figma export missing.',
  'GET /api/mobile/legal/{kind}': 'Driver app Privacy policy / Terms links (MR-30) — public; mobile Figma export missing.',
  'GET /api/mobile/ping': 'Driver app M-20 network speed test (MR-29) — mobile Figma export missing.',
  'POST /api/mobile/release-vehicle': 'Driver app "Release unit" (MR-2) — mobile Figma export missing.',
  'GET /api/mobile/co-driver': 'Driver app co-driver card (MR-15) — mobile Figma export missing.',
  'GET /api/mobile/trailers': 'Driver app M-05 trailer picker (MR-8) — mobile Figma export missing.',
  'GET /api/mobile/defect-catalog': 'Driver app DVIR defect picker (MR-9) — mobile Figma export missing.',
  'GET /api/mobile/saved-signature': 'Driver app saved DVIR signature (MR-27) — mobile Figma export missing.',
  'PUT /api/mobile/saved-signature': 'Driver app save DVIR signature (MR-27) — mobile Figma export missing.',
  'DELETE /api/mobile/saved-signature': 'Driver app delete saved DVIR signature (MR-27) — mobile Figma export missing.',
  'POST /api/mobile/conversations': 'Driver app M-15 "+" start a conversation (MR-3) — mobile Figma export missing.',
  'GET /api/mobile/certification-status': 'Driver app Logs certification banner (MR-26) — mobile Figma export missing.',
  'GET /api/mobile/support/tickets/{id}': 'Driver app M-30 ticket detail (MR-20) — mobile Figma export missing.',
  // In-app notification inbox — a bell icon shown on every screen, not a screen of its own;
  // the role-guide exports do not capture it separately from the pages it overlays.
  'GET /api/notifications': 'In-app notification bell (TZ §14) — not a distinct screen in the role-guide export.',
  'POST /api/notifications/read-all': 'In-app notification bell "mark all read" (TZ §14) — same as above.',
  'POST /api/notifications/{id}/read': 'In-app notification bell — marking one item read (TZ §14) — same as above.',
  // B-41 presigned download helper — reused by whichever screen renders the attachment
  // (DVIR photo, defect photo, support-ticket file); not a screen of its own.
  'GET /api/attachments/{id}/presign': 'Short-lived presigned GET for a stored attachment (TZ §20 B-41) — reused across DVIR/defect/support screens, not a screen of its own.',
  // Reports (TZ §11.6/§15). Only the IFTA and FMCSA-pack tabs of the Reports screen were
  // exported (p.20/p.21) — the generic generate/list/status/download/schedule flow and the
  // Activity/DVIR report tabs are not captured as separate role-guide pages.
  'POST /api/reports/generate': 'Reports — generic "Generate report" action, no separate role-guide page beyond the IFTA/FMCSA tabs (p.20/p.21).',
  'GET /api/reports': 'Reports — job list/history, not a distinct role-guide page.',
  'GET /api/reports/schedules': 'Reports — schedule list, not a distinct role-guide page.',
  'POST /api/reports/schedules': 'Reports — "New schedule" action, not a distinct role-guide page.',
  'PATCH /api/reports/schedules/{id}': 'Reports — edit schedule, not a distinct role-guide page.',
  'GET /api/reports/activity': 'Reports — Activity tab; role-guide export only captured the IFTA/FMCSA tabs (p.20/p.21).',
  'GET /api/reports/activity/summary':
    'Reports — Activity tab JSON aggregate (gap B-46) feeding W-13/W-15/dashboard; same Activity tab as GET /api/reports/activity above, not a distinct role-guide page.',
  'GET /api/reports/dvir': 'Reports — DVIR tab; role-guide export only captured the IFTA/FMCSA tabs (p.20/p.21).',
  'GET /api/reports/{id}': 'Reports — job status polling, not a distinct role-guide page.',
  'GET /api/reports/{id}/download': 'Reports — download action shared by every report tab, not a distinct role-guide page.',
};
