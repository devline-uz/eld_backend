# Automatic location description (geo-location) — algorithm

Language-independent specification of what the backend computes, so the mobile app can produce
the same text offline. Server implementation: `src/common/geo-location/location-description.ts`
(`describeLocation`, `resolveLocationText`, `locationTextOf`). Decision record: D-127.

Authority: 49 CFR 395 Subpart B Appendix A (`docs/fmcsa/49cfr395-subpartB-appendixA.txt`)
§3.1.4, §4.4.2, §4.7.3, §7.29. Where the mobile request's example (`3.40 mi W of Columbus, OH`)
differs from §7.29, §7.29 wins.

## 1. Output format (§7.29)

```
<distance>mi <direction> <ST> <Place>
```

- `distance` — whole miles, 1 or 2 digits (`<C>` / `<CC>`), no leading zeros, no decimals.
- `direction` — one of the 16 compass points of Table 10, the direction of the position as
  seen FROM the place: `N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW`.
- `ST` — the Table 5 two-letter State/Province abbreviation of the place.
- `Place` — the place name (ASCII).
- Single spaces between parts, no comma, no "of". Whole text at most 60 characters: when longer,
  the place name is cut so the total is 60, then trailing spaces are trimmed.
- When the distance rounds to 0, distance and direction are left blank (§7.29 allows `<{blank}>`)
  and the `mi ` literal is dropped: `<ST> <Place>`.

Examples (§7.29): `2mi ESE IL Darien`, `1mi SE TX Dallas`, `11mi NNW IN West Lafayette`.

## 2. Place database

- File: `src/common/geo-location/data/places-na.tsv` (UTF-8, `\n` line ends). Lines starting with
  `#` are comments. Data rows: `name<TAB>ST<TAB>lat<TAB>lon`, lat/lon decimal degrees (3 decimals).
- Source: GeoNames `cities1000` (https://www.geonames.org/, **CC BY 4.0 — attribution required**
  in any UI/about screen that ships it). US, CA, MX populated places (feature class `P`, minus
  `PPLX` sections and `PPLH/PPLQ/PPLW/PPLCH` historical/abandoned), name = GeoNames `asciiname`.
  ~27,000 rows — a superset of the §4.4.2(b) minimum (all places with population >= 5,000).
- admin1 -> abbreviation: US = the GeoNames code; Canada and Mexico via the tables in
  `scripts/build-geo-places.mjs` (e.g. CA.08 -> ON, MX.09 -> DF, MX.19 -> NL).
- Rebuild: see the header of `scripts/build-geo-places.mjs` (deterministic, sorted output).
  The app should ship the same file (or a binary derived from it) and record its build date.

## 3. Algorithm

Input: a position `(lat, lon)` and a flag `reduced` (personal conveyance).

1. **Use the coarsened position.** The server describes the position it STORES, which is already
   coarsened (TZ §23 / §7.3 rule 9):
   - step = 1 mile (on-duty, OFF, SB, D, YM) or 10 miles (active PC);
   - `latStep = step / 69.0`, `lonStep = latStep / max(|cos(lat)|, 1e-6)` (lat in radians for cos);
   - `lat' = round(lat / latStep) * latStep`, `lon' = round(lon / lonStep) * lonStep` (round half
     away from zero is NOT used — it is JavaScript `Math.round`, i.e. half towards +infinity).
   To match the server exactly the app must coarsen first, then describe.
2. Reject: missing coordinate, non-finite, `|lat| > 90` or `|lon| > 180` -> no description.
3. **Nearest place** by great-circle distance (haversine, Earth radius 6371.0088 km, km -> mi
   factor 0.621371, NOT rounded). Ties (equal distance) -> the name that sorts first, then the
   state. Only places within the limit count: 99.5 mi normally, 95 mi when `reduced`.
   Nothing within the limit -> no description (§7.29 cannot express 3-digit distances).
   No wrap-around at the ±180° meridian.
4. **Bearing** from the place `(φ1, λ1)` to the position `(φ2, λ2)`:
   `θ = atan2(sin Δλ · cos φ2, cos φ1 · sin φ2 − sin φ1 · cos φ2 · cos Δλ)`, converted to
   degrees and normalised to [0, 360).
5. **Direction** = `COMPASS[round(θ / 22.5) mod 16]` with `COMPASS` as listed in §1 starting at N
   (each sector is 22.5° wide and centred on its point: N covers [348.75°, 11.25°)).
6. **Distance**: `step = reduced ? 10 : 1`; `miles = round(distance / step) * step`.
   `miles > 99` -> no description. `miles == 0` -> `"<ST> <Place>"`, else
   `"<miles>mi <direction> <ST> <Place>"`; then apply the 60-character cap of §1.

Grid index (performance, not semantics): 0.5° × 0.5° cells; search the cells of the bounding
box of radius r = 15, 40, then 99.5 mi (box half-height `r / 68.7`°, half-width
`r / (68.7 · cos(min(89.9°, |lat| + half-height)))`), stop at the first radius whose best hit is
within r. Any equivalent exact nearest-neighbour search gives the same answer.

## 4. Which text a record carries

- A non-blank location text supplied by the app/driver (`locationName`, `location.name`) ALWAYS
  wins and is stored exactly as sent (mobile DTOs validate 5-60 chars, §7.12).
- Otherwise, when the record has a position, the computed text is stored in `locationName`
  at write time: ingest events, `POST /mobile/duty-status`, `/mobile/sync` `duty_status` /
  `log_entry`, `POST /mobile/log-entries`, carrier edit proposals, DVIR (`location.name`).
- Read time (`GET /mobile/logs` graph/events `locationDescription`, DVIR detail `location.name`):
  stored text, else computed from the stored position (rows written before this existed);
  a stored `locationPrecisionMi >= 10` means `reduced`.
- A computed text next to a position is a geo-location label, NOT a manual location: the eRODS
  file still exports the coordinates and no `M` marker / annotation row for it (D-116).

## 5. Test vectors (real data file, built 2026-10-08)

| raw input (lat, lon, PC) | stored (coarsened) position | text |
|---|---|---|
| 39.961, -83.063, no | 39.956522, -83.063508 | `2mi SW OH Grandview Heights` |
| 41.73, -87.94, no | 41.724638, -87.932585 | `2mi SSW IL Burr Ridge` |
| 40.5, -86.95, no | 40.507246, -86.948216 | `6mi W IN Battle Ground` |
| 39.962, -82.999, no | 39.956522, -83.007997 | `1mi WSW OH Columbus` |
| 43.706, -79.399, no | 43.710145, -79.390950 | `ON Toronto` |
| 19.43, -99.13, no | 19.434783, -99.123481 | `1mi NNE DF Mexico City` |
| 39.9612, -83.2, PC | 40.000000, -83.196108 | `OH Hilliard` |
| 25.0, -80.0, no | 25.000000, -80.002895 | `27mi SE FL North Key Largo` |
| 10.0, 10.0, no | — | no description |
