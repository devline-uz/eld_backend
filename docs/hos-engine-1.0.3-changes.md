# HOS engine 1.0.3 — changes for the Dart port (2026-10-08)

`HOS_ENGINE_VERSION` = **`1.0.3`** (`src/modules/hos/hos.constants.ts`). Bump the Dart constant in
the same release. Decision: `decisions.md` D-126; bugs B-142, B-143. Fixtures:
`test/conformance/golden/` and `test/conformance/scenarios/` in this repo.

## 1. Server behaviour for an outdated app

`POST /v1/mobile/hos-state` with an app `hosEngineVersion` that is not the server's:

* the snapshot is stored; there is **no comparison, no `alert.hos_engine_drift` and no Sentry event**;
* response: `compared: false`, `reason: "VERSION_MISMATCH"` (same reason string as before; it is
  not renamed, so shipped builds keep working), `versionMismatch: true`, **new `updateRequired`**;
* `updateRequired: true` only when the app engine is OLDER than the server's (numeric semver,
  `1.0.2` < `1.0.3` < `1.0.10`). An app NEWER than the server gets `updateRequired: false`.
  `updateRequired` is always present (`false` on a match and on `STALE`).
* The nightly drift sweep skips a different version as before. Bootstrap (`hosEngineVersion`),
  sync and `hos-recalc` all read the same constant, so they report `1.0.3` now.

## 2. Behaviour changes in `computeHos`

### 2.1 Cycle — violated by DRIVING only (§395.3(b), §395.5(b)) — all rulesets

1.0.2 raised `CYCLE_70` / `CYCLE_60` for any on-duty time past the limit. 1.0.3, per RODS day `key`
(home-terminal timezone) whose sliding-window total exceeds the limit:

1. `running` = window total of the days BEFORE `key` + `excess`, where `excess` =
   max(0, merged total of `key` − segment-derived total of `key`) — on-duty hours that only
   `previousDays` knows about count at the START of the day.
2. Walk the ON and D segment slices inside `[max(dayStart(key), restartEnd), dayEnd(key))`
   chronologically. For a **D** slice with `running + slice > limit`:
   `occurredAt = sliceStart + max(0, limit − running)`, `exceededBySec = running + slice − limit`.
   Then `running += slice` for ON and D alike.
3. One violation per (day, type): earliest `occurredAt`, largest `exceededBySec` (unchanged collector).

Consequences: ON-not-driving past 70 h → no violation (`cycleRemainingSec` and `driveRemainingSec`
still 0). A day with no driving segments never gets a cycle violation, so the B-054 "stamp at
min(day end, now)" fallback is gone. Driving across local midnight can produce one violation on
each day. YM (authorised) is ON, not D → no violation.

### 2.2 Passenger rulesets (`US_70_8_PASSENGER`, `US_60_7_PASSENGER`)

| Rule | 1.0.2 | 1.0.3 |
|---|---|---|
| Driving | 10 h | 10 h (§395.5(a)(1)) — unchanged |
| Reset (drive + shift counters to zero) | 10 h OFF/SB | **8 consecutive h** OFF/SB, consecutive OFF+SB combine (§395.5(a)) |
| 15 h | elapsed window from first ON/D | **ON + D seconds since the last reset** (§395.5(a)(2)); OFF/SB never count |
| 15 h violation | any driving after window end | `SHIFT_14`, only for **driving** after 15 h on duty: `occurredAt` = instant in the D segment where on-duty reaches 15 h (or its start), `exceededBySec` = on-duty total at the end of that D segment − 15 h; ON past 15 h alone is legal |
| `shiftRemainingSec` | window end − now | max(0, 15 h − on-duty used); 15 h before the first ON/D |
| `shiftEndsAt` | window end | `now + shiftRemainingSec` (projection, also while resting); null before the first ON/D |
| `driveRemainingSec` | min(drive, shift, cycle) | same formula with the new shift remaining |
| 34 h restart | applied | **none** (§395.3(c) is property-only): segment rests never restart, `lastRestartEndedAt` is ignored, `restartAvailableAt` always null |
| Cycle | 60/7, 70/8 | unchanged windows; violation per 2.1 |
| Split sleeper | 7 h SB + 2 h SB/OFF, ≥ 10 h | **§395.1(g)(3): two SB periods, each ≥ 2 h (continuous SB inside the rest run), ≥ 8 h together; OFF never qualifies** |
| Split look-back | — | same as property: at the close of the second period both counters = time between the END of the first period and the end of the second (driving → `driveUsedSec`, ON + D → on-duty counter); `shiftStartedAt` = end of the first period |
| 30-min break | not required | not required — unchanged |
| Adverse | +2 h drive, +2 h shift | **unchanged** (12 h / 17 h) — open question, see D-126 |

Part classification for passenger: a rest run (maximal OFF/SB run) shorter than 8 h whose longest
continuous SB stretch is ≥ 2 h is a part (kind `LONG`, `partSec` = that stretch, start/end = that
stretch). Pairing is the existing greedy nearest pair: pending + new part pair when the sum ≥ 8 h;
otherwise the new part becomes pending; a full reset clears pending; each part is in one pair.

### 2.3 Property rulesets

No change except 2.1. All property golden / scenario expectations other than the cycle files are
untouched.

## 3. Fixtures

### Golden (`test/conformance/golden/`)

| File | Change |
|---|---|
| `011-shift-14h-exact.json` | `driveUsedSec` `34200.0` → `34200` (integer); no behaviour change |
| `023-cycle-70-exceeded.json` | 2nd event `ON` → `D` (spec text extended); expectation unchanged |
| `024-cycle-60-7-exceeded.json` | 2nd event `ON` → `D` (spec text extended); expectation unchanged |
| `056-cycle-violation-never-stamped-after-now.json` | rewritten: now `2025-01-14T16:00:00Z`, events OFF 05:00Z / D 15:00Z; previousDays 01-14 = 5 h (4 h excess at day start) → `CYCLE_70`, `occurredAt 15:00Z`, 3600 s |
| `054-cycle-on-duty-past-limit-is-legal.json` | NEW (fills the old 054 gap) — 71 h on duty, no driving: `[]` |
| `057-cycle-60-on-duty-past-limit-is-legal.json` | NEW — 60/7, 61 h on duty, no driving: `[]` |
| `058-cycle-on-duty-past-limit-then-driving.json` | NEW — limit reached on duty, then D: stamped at D start, 3600 s |
| `059-passenger-15h-on-duty-off-duty-does-not-count.json` | NEW — 18 h elapsed, 14 h on duty: legal, 1 h left, `shiftEndsAt` projection |
| `060-passenger-15h-on-duty-exceeded.json` | NEW — `SHIFT_14` 1800 s at the 15th on-duty hour |
| `061-passenger-on-duty-past-15h-without-driving-is-legal.json` | NEW — 16 h ON: `[]` |
| `062-passenger-8h-off-resets.json` | NEW — 8 h OFF resets both counters |
| `063-passenger-7h59m-off-does-not-reset.json` | NEW — 7:59 OFF: `DRIVING_11` 7260 s |
| `064-passenger-no-34h-restart.json` | NEW — 36 h OFF + `lastRestartEndedAt` ignored: `cycleRemainingSec` 32400 |
| `065-passenger-no-restart-forecast-while-resting.json` | NEW — `restartAvailableAt` null |
| `066-passenger-split-5h-3h-sleeper-pair.json` | NEW — §395.1(g)(3) pair + look-back: 9 h driving, legal |
| `067-passenger-split-off-duty-part-does-not-qualify.json` | NEW — OFF second period: `DRIVING_11` 18000 s |
| `068-passenger-split-part-under-2h-does-not-qualify.json` | NEW — 6:01 + 1:59 SB: `DRIVING_11` 3600 s |
| `069-passenger-60-7-cycle-driving-past-limit.json` | NEW — `CYCLE_60` 3600 s on `US_60_7_PASSENGER` |
| `README.md` | Dart path `lib/core/hos/engine/`, numbering note (054), 1.0.3 summary |

Golden 050/051 (passenger 10 h) are unchanged and still pass.

### Mobile scenarios (`test/conformance/scenarios/`, copy back to `eld_mobile`)

| File | Change |
|---|---|
| `R04-cycle70-over.json` | 2nd event `ON` → `D`, title updated; expectation unchanged (`CYCLE_70` 60 s) |
| `R04-cycle60-over.json` | 2nd event `ON` → `D`, title updated; expectation unchanged (`CYCLE_60` 1800 s) |

The count stays 74. Suggested Dart-side additions mirroring golden 054/057/059–069 are optional:
the golden files are shared and already cover them.

## 4. TS surface (for reference, not to copy)

`RuleLimits` gained `shiftMode` (`WINDOW` | `ON_DUTY`), `resetRestSec`, `restartAllowed`, `split`
(`PROPERTY_SPLIT` / `PASSENGER_SPLIT`: `longMinSec`, `shortMinSec`, `shortMayBeOffDuty`,
`pairMinSec`). `findRestRuns(segments, resetSec)`, `classifyPart/partsPair/analyzeSplits(..., rule)`
take the rule; defaults keep the property behaviour.
