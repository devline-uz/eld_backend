"""Generates docs/mobile_api.md and docs/web_api.md from docs/openapi.json + descriptions.uz.tsv.
Usage (from backend/): python3 -I scripts/api-docs/gen_api_docs.py docs/openapi.json scripts/api-docs/descriptions.uz.tsv docs
A new endpoint needs one line `operationId<TAB>uzbek description` in descriptions.uz.tsv."""
import json
import sys
from collections import OrderedDict

spec_path, uz_path, out_dir = sys.argv[1:4]
spec = json.load(open(spec_path))
schemas = spec.get('components', {}).get('schemas', {})
uz = {}
for line in open(uz_path, encoding='utf-8'):
    line = line.rstrip('\n')
    if '\t' in line:
        k, v = line.split('\t', 1)
        uz[k] = v

NO = "yo'q"
MOBILE_EXTRA = {
    'HealthController_live', 'AuthController_loginDriver', 'AuthController_refresh', 'AuthController_logout',
    'AuthController_me', 'AuthController_forgotPassword', 'AuthController_forgotDriverPassword',
    'AuthController_resetDriverPassword', 'LogsController_accept', 'LogsController_reject',
    'UnidentifiedController_confirm', 'UnidentifiedController_listConfirmationRequests',
    'NotificationsController_list', 'NotificationsController_readAll', 'NotificationsController_markRead',
    'AttachmentsController_presign',
}
DRIVER_ONLY = {
    'AuthController_loginDriver', 'AuthController_forgotDriverPassword', 'AuthController_resetDriverPassword',
    'LogsController_accept', 'LogsController_reject', 'UnidentifiedController_confirm',
    'UnidentifiedController_listConfirmationRequests',
}
NEW_OPS = {'IngestController_deviceEventsUpload', 'MobileDeviceConfigController_config'}
CHANGED_OPS = {
    'IngestController_telemetry', 'IngestController_bleState', 'IngestController_deviceStatus',
    'DevicesController_list', 'DevicesController_get', 'DevicesController_create', 'DevicesController_update',
    'DevicesController_import', 'DtcController_list', 'VehiclesController_histories',
    'VehiclesController_telemetry', 'LiveFleetController_fleet', 'SafetyController_listEvents',
    'NotificationsController_list',
}
TAG_UZ = {
    'health': "Health (tizim holati)", 'auth': "Autentifikatsiya", 'me': "Mening profilim (/me)",
    'carrier': "Kompaniya (carrier)", 'attachments': "Biriktirmalar", 'roles': "Rollar",
    'users': "Foydalanuvchilar", 'audit-log': "Audit log", 'api-keys': "API kalitlari",
    'drivers': "Haydovchilar", 'transfers': "eRODS transferlar", 'vehicles': "Unitlar (vehicles)",
    'trailers': "Treylerlar", 'vehicle-groups': "Unit guruhlari", 'alert-rules': "Alert qoidalari",
    'notifications': "Bildirishnomalar", 'notification-channels': "Bildirishnoma kanallari",
    'integrations': "Integratsiyalar", 'mobile': "Mobil ilova (/mobile)", 'ingest': "Ingest (ELD → server)",
    'logs': "RODS loglar", 'dtc': "DTC (nosozlik kodlari)", 'messaging': "Xabarlar",
    'devices': "ELD qurilmalar", 'co-driver-pairings': "Co-driver juftliklari",
    'unidentified': "Unidentified driving", 'violations': "HOS violation'lar", 'dvir': "DVIR",
    'defects': "Defektlar", 'work-orders': "Work order'lar", 'maintenance': "Texnik xizmat",
    'support': "Support", 'trips': "Trip / dispatch", 'safety': "Safety", 'geofences': "Geofence'lar",
    'search': "Qidiruv", 'live': "Live fleet", 'dashboard': "Dashboard", 'reports': "Hisobotlar",
}


def resolve(s, depth=0):
    while isinstance(s, dict) and '$ref' in s:
        s = schemas.get(s['$ref'].split('/')[-1], {})
    if isinstance(s, dict) and 'allOf' in s and len(s['allOf']) == 1:
        merged = dict(resolve(s['allOf'][0]))
        merged.update({k: v for k, v in s.items() if k != 'allOf'})
        return merged
    return s or {}


def type_label(s):
    s = resolve(s)
    if 'enum' in s:
        return ' \\| '.join(f'`{e}`' for e in s['enum'] if e is not None)
    for key in ('anyOf', 'oneOf'):
        if key in s:
            parts = [type_label(x) for x in s[key] if resolve(x).get('type') != 'null']
            return ' yoki '.join(dict.fromkeys(parts)) or 'any'
    t = s.get('type')
    if isinstance(t, list):
        t = '/'.join(x for x in t if x != 'null')
    if t == 'array':
        return f"{type_label(s.get('items', {}))}[]"
    if t == 'string' and s.get('format') in ('uuid', 'date-time', 'date', 'email', 'uri'):
        return f"string ({s['format']})"
    return t or ('object' if 'properties' in s else 'any')


def constraints(s):
    s = resolve(s)
    out = []
    for a, b, unit in (('minimum', 'maximum', ''), ('minLength', 'maxLength', ' belgi'), ('minItems', 'maxItems', ' ta')):
        lo, hi = s.get(a), s.get(b)
        if s.get('exclusiveMinimum') is not None and a == 'minimum':
            lo = f">{s['exclusiveMinimum']}"
        if hi == 2147483647:
            hi = None
        if lo is not None and hi is not None:
            out.append(f'{lo}–{hi}{unit}')
        elif lo is not None:
            out.append(f'≥ {lo}{unit}')
        elif hi is not None:
            out.append(f'≤ {hi}{unit}')
    if 'default' in s:
        out.append(f"default `{json.dumps(s['default'], ensure_ascii=False)}`")
    if s.get('pattern'):
        out.append(f"pattern `{s['pattern']}`")
    return ', '.join(out)


def is_nullable(s):
    s = resolve(s)
    if s.get('nullable'):
        return True
    t = s.get('type')
    if isinstance(t, list) and 'null' in t:
        return True
    for key in ('anyOf', 'oneOf'):
        if any(resolve(x).get('type') == 'null' for x in s.get(key, [])):
            return True
    return False


def flatten(s, prefix='', depth=0, rows=None):
    rows = [] if rows is None else rows
    s = resolve(s)
    props = s.get('properties')
    if not props:
        return rows
    req = set(s.get('required', []))
    for name, sub in props.items():
        rs = resolve(sub)
        full = f'{prefix}{name}'
        desc = (sub.get('description') or rs.get('description') or '').replace('\n', ' ').replace('|', '\\|')
        if len(desc) > 220:
            desc = desc[:217] + '…'
        rows.append((full, type_label(sub), name in req, is_nullable(sub), constraints(sub), desc))
        if depth < 3:
            if rs.get('type') == 'array' or 'items' in rs:
                flatten(rs.get('items', {}), f'{full}[].', depth + 1, rows)
            elif rs.get('properties'):
                flatten(rs, f'{full}.', depth + 1, rows)
    return rows


def example_of(content):
    if not content:
        return None
    media = content.get('application/json') or next(iter(content.values()), {})
    if 'examples' in media:
        first = next(iter(media['examples'].values()), {})
        if 'value' in first:
            return first['value']
    if 'example' in media:
        return media['example']
    sch = media.get('schema', {})
    if 'example' in sch:
        return sch['example']
    rs = resolve(sch)
    return rs.get('example')


def dump(value, limit=45):
    text = json.dumps(value, indent=2, ensure_ascii=False)
    lines = text.split('\n')
    if len(lines) > limit:
        lines = lines[:limit] + ['  …']
    return '\n'.join(lines)


def render_op(method, path, op, audience):
    oid = op['operationId']
    badge = ' 🆕 YANGI' if oid in NEW_OPS else (' ♻️ O\'ZGARGAN' if oid in CHANGED_OPS else '')
    out = [f"### `{method.upper()} {path}`{badge}", '']
    out.append(f"**Nima qiladi:** {uz.get(oid, op.get('summary', ''))}")
    out.append('')
    if not op.get('security'):
        auth = 'Ochiq (token kerak emas)'
    elif path.startswith('/api/ingest') or path.startswith('/api/mobile') or oid in DRIVER_ONLY:
        auth = '`Authorization: Bearer <driver access token>`'
    else:
        auth = '`Authorization: Bearer <access token>`'
    out.append(f'- **Auth:** {auth}')
    screens = op.get('x-figma-screens')
    if screens:
        out.append(f"- **Ekran:** {', '.join(f'`{x}`' for x in screens)}")
    out.append(f"- **operationId:** `{oid}` · original: _{op.get('summary', '')}_")
    if op.get('description'):
        out.append(f"- **Izoh (backend):** {op['description'].strip()}")
    out.append('')
    params = [p for p in op.get('parameters', []) if p.get('in') in ('path', 'query')]
    if params:
        out += ['**Parametrlar:**', '', '| Nomi | Joyi | Turi | Majburiy | Cheklov | Izoh |', '|---|---|---|---|---|---|']
        for p in params:
            sch = p.get('schema', {})
            desc = (p.get('description') or '').replace('\n', ' ').replace('|', '\\|')
            out.append(f"| `{p['name']}` | {p['in']} | {type_label(sch)} | {'ha' if p.get('required') else NO} | {constraints(sch)} | {desc} |")
        out.append('')
    body = op.get('requestBody')
    if body:
        content = body.get('content', {})
        media_type = next(iter(content), 'application/json')
        media = content.get(media_type, {})
        rows = flatten(media.get('schema', {}))
        out.append(f"**Body** (`{media_type}`):")
        out.append('')
        if rows:
            out += ['| Maydon | Turi | Majburiy | Cheklov | Izoh |', '|---|---|---|---|---|']
            for name, t, req, nul, cons, desc in rows:
                flag = 'ha' if req else "yo'q"
                if nul:
                    flag += ', null mumkin'
                out.append(f'| `{name}` | {t} | {flag} | {cons} | {desc} |')
            out.append('')
        ex = example_of(content)
        if ex is not None:
            out += ['So\'rov misoli:', '', '```json', dump(ex), '```', '']
    responses = op.get('responses', {})
    ok = [c for c in responses if c.startswith('2')]
    for code in ok:
        r = responses[code]
        desc = (r.get('description') or '').replace('\n', ' ')
        out.append(f"**Javob `{code}`:** {desc}")
        ex = example_of(r.get('content'))
        if ex is not None:
            out += ['', '```json', dump(ex), '```']
        out.append('')
    errs = [c for c in responses if not c.startswith('2')]
    if errs:
        items = []
        for c in errs:
            d = (responses[c].get('description') or '').replace('\n', ' ')
            if len(d) > 140:
                d = d[:137] + '…'
            items.append(f'`{c}` {d}'.strip())
        out.append('**Xatolar:** ' + ' · '.join(items))
        out.append('')
    out.append('---')
    out.append('')
    return '\n'.join(out)


def collect(audience):
    groups = OrderedDict()
    for path, ops in spec['paths'].items():
        for method, op in ops.items():
            oid = op['operationId']
            mobile = path.startswith('/api/mobile') or path.startswith('/api/ingest') or oid in MOBILE_EXTRA
            web = not (path.startswith('/api/mobile') or path.startswith('/api/ingest') or oid in DRIVER_ONLY)
            if (audience == 'mobile' and mobile) or (audience == 'web' and web):
                tag = (op.get('tags') or ['other'])[0]
                groups.setdefault(tag, []).append((method, path, op))
    return groups


HEADER = {
    'mobile': """# OneBook ELD — Mobil ilova (driver app) API qo'llanmasi

Manba: `backend/docs/openapi.json` (generatsiya: 2026-10-10, backend `main`). Hujjat avtomatik yig'ilgan:
har bir endpoint uchun **nima qiladi**, auth, parametrlar, body maydonlari, javob misoli va xatolar.
Faqat haydovchi ilovasi chaqiradigan endpointlar (`/api/mobile/*`, `/api/ingest/*`, haydovchi auth,
§395.30 tahrir javobi, unidentified tasdig'i, bildirishnomalar, biriktirma URL).

PT SDK 6.11.1 bo'yicha batafsil integratsiya yo'riqnomasi: `backend/docs/pt-sdk-6.11-mobile.md`.
""",
    'web': """# OneBook ELD — Web panel (back-office) API qo'llanmasi

Manba: `backend/docs/openapi.json` (generatsiya: 2026-10-10, backend `main`). Hujjat avtomatik yig'ilgan:
har bir endpoint uchun **nima qiladi**, auth, parametrlar, body maydonlari, javob misoli va xatolar.
Web panel chaqiradigan barcha endpointlar (haydovchi ilovasiga xos `/api/mobile/*`, `/api/ingest/*` va
haydovchi-only route'lar bundan tashqari).

PT SDK 6.11.1 bo'yicha web o'zgarishlari tafsiloti: `backend/docs/pt-sdk-6.11-web.md`.
""",
}

COMMON = """
## Umumiy qoidalar

- **Base URL:** dev `http://<host>:3002/api` (prefiks `/api`); `/health/*` prefikssiz.
- **Konvert:** muvaffaqiyatli javob `{ "data": ..., "traceId": "...", "timestamp": "..." }` ko'rinishida keladi (quyidagi misollarda `data` ichidagi qism ko'rsatilgan). `GET /mobile/ping` va fayl yuklash endpointlari konvertsiz.
- **Xato formati:** `{ "statusCode": 422, "code": "VALIDATION_FAILED", "message": "...", "details": { ... }, "traceId": "...", "timestamp": "..." }` (support'ga murojaatda `traceId` ni yuboring). Asosiy kodlar: `400/422 VALIDATION_FAILED`, `401 UNAUTHORIZED`, `403 FORBIDDEN` / `DRIVER_CONTEXT_REQUIRED`, `404 NOT_FOUND`, `409 CONFLICT`, `413 PAYLOAD_TOO_LARGE`, `429` (throttle).
- **Pagination:** ro'yxatlar odatda `?page=&limit=` → `{ items, page, limit, total, totalPages }`; ba'zilari cursor (`?cursor=`) — har endpointda ko'rsatilgan.
- **Token:** access token `Authorization: Bearer ...`; muddati tugasa `POST /auth/refresh` (har safar yangi refresh token, eskisi bekor).
- **Belgilar:** 🆕 YANGI — 2026-10-10 (PT SDK 6.11.1) qo'shilgan; ♻️ O'ZGARGAN — shu sanada maydonlari kengaygan.
"""

NEW_SUMMARY = {
    'mobile': """
## 2026-10-10 dagi yangiliklar (PT SDK 6.11.1)

| Endpoint | Holat | Qisqacha |
|---|---|---|
| `POST /api/ingest/device-events` | 🆕 | SDK xom hodisalari (EV_*), (seq, sana) bo'yicha idempotent; EV_MEMS_* → Safety |
| `GET /api/mobile/device-config` | 🆕 | Qurilmaga yoziladigan `systemVars` + `configVersion` |
| `POST /api/ingest/telemetry` | ♻️ | lat/lon ixtiyoriy, yangi VDB maydonlari, DTC shina formatlari, `milOn`, `vin` |
| `POST /api/ingest/device-status` | ♻️ | TrackerInfo maydonlari; javobda `model`, `vinMismatch`, `systemVars`, `configVersion` |
| `POST /api/ingest/ble-state` | ♻️ | `connectionType` BLE \\| USB |
""",
    'web': """
## 2026-10-10 dagi yangiliklar (PT SDK 6.11.1)

| Endpoint | Holat | Qisqacha |
|---|---|---|
| `GET /api/devices`, `GET /api/devices/{id}` | ♻️ | TrackerInfo maydonlari (productName, bleFirmware, imei, reportedVin, sdkVersion, appPlatform, connectionType, busType, lastInfoAt), harsh/NOBLE sozlamalari, `systemVars` |
| `POST /api/devices`, `PATCH /api/devices/{id}`, `POST /api/devices/import` | ♻️ | `periodicNoBleSec` 10–480 s, `harshAccelMg`/`harshBrakeMg`/`harshCornerMg` 0–8192 mG |
| `GET /api/vehicles/{id}/dtc` | ♻️ | `code`, `bus`, `milOn`, `conversionMethod`, `active` — OBD-II/J1708 da `spn` null |
| `GET /api/vehicles/{id}/histories`, `GET /api/vehicles/{id}/telemetry` | ♻️ | lat/lon `null` bo'lishi mumkin; yangi VDB ustunlari |
| `GET /api/live/fleet` | ♻️ | Shakl o'zgarmagan; pin oxirgi GPS fix'li nuqtadan |
| `GET /api/safety/events` | ♻️ | Qurilma akselerometri harsh hodisalari ham keladi |
| `GET /api/notifications` | ♻️ | Yangi tur `alert.device_vin_mismatch` |
""",
}


def build(audience):
    groups = collect(audience)
    total = sum(len(v) for v in groups.values())
    parts = [HEADER[audience], f'Jami: **{total} ta endpoint**, {len(groups)} bo\'lim.\n', COMMON, NEW_SUMMARY[audience]]
    parts.append('\n## Mundarija\n')
    for tag, ops in groups.items():
        title = TAG_UZ.get(tag, tag)
        anchor = f'bolim-{tag}'
        parts.append(f'- [{title}](#{anchor}) — {len(ops)} ta')
        for method, path, op in ops:
            mark = ' 🆕' if op['operationId'] in NEW_OPS else (' ♻️' if op['operationId'] in CHANGED_OPS else '')
            parts.append(f'  - `{method.upper()} {path}`{mark} — {uz.get(op["operationId"], op["summary"])[:110]}')
    parts.append('')
    for tag, ops in groups.items():
        parts.append(f'<a id="bolim-{tag}"></a>\n\n## {TAG_UZ.get(tag, tag)}\n')
        for method, path, op in ops:
            parts.append(render_op(method, path, op, audience))
    return '\n'.join(parts), total


missing = [op['operationId'] for ops in spec['paths'].values() for op in ops.values() if op['operationId'] not in uz]
if missing:
    print('missing uz:', missing, file=sys.stderr)
for audience, fname in (('mobile', 'mobile_api.md'), ('web', 'web_api.md')):
    text, total = build(audience)
    with open(f'{out_dir}/{fname}', 'w', encoding='utf-8') as fh:
        fh.write(text)
    print(fname, total, len(text.splitlines()), 'lines')
