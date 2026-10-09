# eRODS output file — format changes of 2026-10-08 (port to `output_file_generator.dart`)

Source: official 49 CFR 395 Subpart B Appendix A (eCFR 2026-10-06), `backend/docs/fmcsa/49cfr395-subpartB-appendixA.txt`.
Backend: `src/modules/transfers/{segments,output-file,check-value,filename,validator,snapshot}.ts`.
Bugs B-134 … B-138, decisions D-024 (closed), D-116 (verified), D-120 (choices), D-121 (6-char ELD Identifier data path).
Reference bytes: `backend/test/conformance/erods/*.expected.{csv,json}` (regenerated). The Dart port must match them byte for byte.

## Whole file

| What | Before | After | § |
|---|---|---|---|
| Segment order | Header, Users, CMVs, **Malfunctions**, Events, Annotations, Certifications, Unidentified, EOF | Header, Users, CMVs, Events, Annotations, Certifications, **Malfunctions**, **Login/Logout**, **Engine Power**, Unidentified, EOF | 4.8.2.1.1–.11 |
| Row order in every event-type segment (events, annotations, certifications, malfunctions, login, power, unidentified) | input order (oldest first) | **most recent first**: sort by UTC instant desc, tie → higher sequence id first | 4.8.2.1.4–.10 |
| `,` / CR / LF / CRLF inside a value | replaced by a space | replaced by `;` (CRLF = one `;`); other non-printables dropped, space runs collapsed, trimmed | 4.8.2.1(b)(3) |
| Event Sequence ID | `((n-1) mod 65535)+1`, `0000` invalid | `n mod 65536`, 4 hex uppercase; `0000` valid (65536 → `0000`) | 7.24 |
| Latitude / longitude rounding to zero | `-0.00` | `0.00` (no sign) | 7.31 / 7.33 |
| Distance Since Last Valid Coordinates | raw integer, blank if unknown | integer clamped to 0..6, unknown → `0` | 7.9 |

## Check values (4.4.5) — all three changed

| Value | Before | After |
|---|---|---|
| Character value | raw UTF-8 byte | Table 3: `1`-`9`→1-9, `A`-`Z`→17-42, `a`-`z`→49-74, everything else (incl. `0`, `,`, `.`, `-`, space) → 0 |
| Line Data Check Value (4.4.5.2) | sum of bytes mod 256, 2 hex | `cs = sum & 0xFF; v = rotl8(cs, 3) ^ 0x96`, 2 hex uppercase |
| Event Data Check Value (4.4.5.1) — NEW column | — | over the concatenation of Event Type, Event Code, Event Date, Event Time, Vehicle Miles, Engine Hours, Latitude, Longitude (all **as written in that row**), CMV Power Unit Number (from CMV list by order number), ELD username (inspected driver for the event list, `unidentified` for the unidentified list): `rotl8(sum & 0xFF, 3) ^ 0xC3`, 2 hex. A stored 2-hex value (`eventDataCheckValue`) is used verbatim. |
| File Data Check Value (4.4.5.3) | sum of line values mod 256, **2 hex** | `cs = sum(line values) & 0xFFFF`; rotl3 on **each byte separately**; `^ 0x969C`; **4 hex** uppercase (7.27) |

`rotl8(x,3) = ((x << 3) | (x >> 5)) & 0xFF`. Vectors (see `check-value.spec.ts`): line `''`→`96`, `'A'`→`1E`, `'SMITH,JOHN'`→`B6`; event `[]`→`C3`, `[1,1,090426,060000,45,1.5,41.32,-72.93,101,jsmith]`→`26`; file `[]`→`969C`, `[01]`→`9694`, `[FF,FF]`→`9E6B`.

## Header segment (4.8.2.1.1) — 9 lines → 7 lines

| Line | Before | After |
|---|---|---|
| 1 | Last, First, Username, Lic State, Lic Number | unchanged |
| 2 | Co-driver Last, First, Username | unchanged |
| 3 | Power Unit, VIN, Trailers | unchanged |
| 4 | USDOT, Carrier Name, Multiday Basis | USDOT, Carrier Name, Multiday Basis, **24-Hour Period Starting Time** (`000000`, 7.1), **Time Zone Offset** (2 digits `04`, 7.41) |
| 5 | Shipping Doc | Shipping Doc, **Exempt** (`E` or **`0`**, was `N` — 7.26) |
| 6 | Exempt (`N`/`E`) | **Current Date, Current Time, Current Latitude, Current Longitude, Current Total Vehicle Miles, Current Total Engine Hours** (unknown position → `X`,`X`; E/M/X rules as for events) |
| 7 | TZ offset (`4`), Current Date, Current Time | Registration ID (4 chars, 7.17), ELD Identifier (**6 chars**, 7.15 — was 4), Authentication Value, **Output File Comment** (≤60) |
| 8 | Registration ID, ELD Identifier, Authentication Value | — (moved to line 7) |
| 9 | Output File Comment | — (moved to line 7) |

## List segments

| Segment | Column | Before | After | § |
|---|---|---|---|---|
| User List | all | Order, **Username**, Last, First, **Type** | Order, **Type**, Last, First (no username) | 4.8.2.1.2 |
| User List | rows | driver + editors | + co-driver (type D) and **always** the unidentified profile `Unidentified`,`Driver`, type `D`; driver first, then by latest activity | 4.8.2.1.2, 7.13 |
| CMV List | order | first seen | most recently operated first | 4.8.2.1.3 |
| ELD Event List | content | event types 1,2,3,**5,6** | types **1,2,3 only** (5 → Login/Logout, 6 → Engine Power) | 4.8.2.1.4 |
| ELD Event List | col 8, 9 | Total Vehicle Miles, Total Engine Hours (odometer) | **Accumulated** Vehicle Miles, **Elapsed** Engine Hours since the last power-up of that CMV (blank if unknown) | 4.8.2.1.4, 7.43, 7.19 |
| ELD Event List | col 17 (new, before line check) | — | **Event Data Check Value** | 4.8.2.1.4, 7.21 |
| ELD Event List | col 15/16 meaning | "this record has a code" | **at least one** malfunction / diagnostic active at the record time | 7.35, 7.7 |
| Annotations | col 2 | User **Order Number** | ELD **Username** of the record originator | 4.8.2.1.5 |
| Annotations | rows | any record with text (incl. certifications, malfunctions) | only Event-List records (types 1-3) with annotation / comment / manual location | 4.8.2.1.5 |
| Certification | col 6 (new) | — | Corresponding **CMV Order Number** | 4.8.2.1.6 |
| Certification | col 5 | event's own date | the certified day (`comment` `certifiedDate=YYYY-MM-DD`) | 4.5.1.4(b)(5) |
| Malfunctions | title | `ELD Malfunction and Data Diagnostic Event Records:` | `Malfunctions and Data Diagnostic Events:` | 4.8.2.1.7 |
| Login/Logout (NEW) | title + cols | — | `ELD Login/Logout Report:` · Seq, Code, ELD Username, Date, Time, Total Miles, Total Hours | 4.8.2.1.8 |
| Engine Power (NEW) | title + cols | — | `CMV Engine Power-Up and Shut Down Activity:` · Seq, Code, Date, Time, Total Miles, Total Hours, Lat, Lon (E/M/X rules), Power Unit, VIN (from CMV list), Trailers, Shipping Doc | 4.8.2.1.9 |
| Unidentified | title | `Unidentified Vehicle Profile Records:` | `Unidentified Driver Profile Records:` (`src/modules/transfers/segments.ts:31`, `SEGMENT_TITLES.unidentified`) | 4.8.2.1.10 |
| Unidentified | col 8, 9 | Total miles / hours | Accumulated / Elapsed | 4.8.2.1.10 |
| Unidentified | col 14, 15 (new) | — | **Malfunction Indicator Status**, **Event Data Check Value** (username `unidentified`) | 4.8.2.1.10 |
| End of File | value | 2 hex | 4 hex | 4.8.2.1.11, 7.27 |

### Header lines 3 / 4 and engine power rows — trailers and shipping documents (D-129, mobile wave 4)

| Field | Before | After | § |
|---|---|---|---|
| Header line 3, `Trailer Number(s)` | always blank | trailers of the RODS day in force at generation (trips overlapping the day ∪ the driver's no-trip day details), joined by ONE space, whole numbers only, max 32 chars | 7.42 |
| Header line 4, `Shipping Document Number` | blank unless passed explicitly | same source, documents joined by one space, whole documents only, max 40 chars (a lone longer one is cut to 40) | 7.39 |
| Engine Power rows, `Trailer Number(s)` / `Shipping Document Number` | blank | the same lists for the record's home-terminal RODS day | 4.8.2.1.9 |

"The day in force" = the generation day, or the range's last day when the range ends before today. Each
trailer number is 1-10 chars `[A-Z0-9-]` (no inner space — space is the 7.42 separator), validated at input.

### Login/Logout Report — rows now exist (D-130, mobile wave 4)

The server writes the eventType 5 records itself (code 1 login on `/auth/login/driver` with an assigned unit,
`select-vehicle`, `co-driver/switch`; code 2 on `/auth/logout`, `release-vehicle`, `co-driver/leave`):
`recordOrigin=1`, `recordStatus=1`, the per-driver sequence id, the unit's last odometer / engine hours. The
app never creates them; a phone-built file takes them from the synced records like any other event.

## File name (4.8.2.2) — completely new shape

Before: `[last5][cdl last 2 chars][seq 2][days 1].csv` → `SMITH38018.csv`.
After (25 chars + `.csv`): `SMITH` + `38` + `41` + `091126` + `-` + `000000000` → `SMITH3841091126-000000000.csv`

1. first 5 **letters** of the last name, uppercased, padded with `_` (`Ng` → `NG___`, `O'Brien` → `OBRIE`);
2. last 2 **digits** of the licence number (`0`-padded: `7` → `07`);
3. sum of all licence digits, last 2 digits, `0`-padded (`W8569238` → 41);
4. file creation date `MMDDYY`, home-terminal time;
5. `-`;
6. 9 chars: today's per-driver file sequence − 1, 9 digits (1st file `000000000`, 2nd `000000001`).

The range day count is no longer part of the name.

## Unchanged

Position markers E > fix > M > X (4.6.1.4(d)/(e), 4.3.2.7(c)); 0.01° / 0.1° (PC) resolution; MMDDYY / HHMMSS in home-terminal time per event offset; CRLF line ends; annotation and location description capped at 60; Registration ID 4 chars (7.17).

## ELD Identifier — 4 → 6 characters (B-138, follow-up of 2026-10-08)

| What | Before | After | § |
|---|---|---|---|
| ELD Identifier (header line 7, field 2) | exactly 4 `[A-Z0-9]` (`OBK1`) | exactly **6** `[A-Z0-9]` (TEST placeholder **`OBK001`**; real value = the provider-assigned identifier of the certified model/version) | 7.15 |
| ELD Registration ID (header line 7, field 1) | 4 `[A-Z0-9]` | unchanged — 4 `[A-Z0-9]`, empty tolerated in TEST | 7.17 |
| `Carrier.eldIdentifier` (DB, `GET /mobile/bootstrap` `carrier.eldIdentifier`) | `VarChar(4)`, CHECK `^[A-Z0-9]{4}$`, default `OBK1` | `VarChar(6)`, CHECK `^[A-Z0-9]{6}$`, default `OBK001`; existing `OBK1` migrated to `OBK001`, other 4-char values right-padded `00` (D-121) | 7.15 |
| Generator / validator | refused anything but 4 chars | refuse anything but 6 chars (`ELD_IDENTIFIER_LENGTH = 6`) | 7.15 |

Dart port: take `carrier.eldIdentifier` from bootstrap as-is, validate `^[A-Z0-9]{6}$` (not 4), and keep
`^[A-Z0-9]{4}$` for the registration id. A cached 4-char value from an older bootstrap must be
refreshed, never padded on the device. Reference bytes in `backend/test/conformance/erods/` now carry `OBK001`.
