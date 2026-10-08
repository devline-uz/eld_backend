# HOS conformance fixtures (TZ §8.6)

Language-neutral golden cases for the Hours-of-Service engine. **Both** implementations read
these exact files and both must pass 100 %:

| Implementation | Language | Test entry point |
|---|---|---|
| `backend/src/modules/hos/engine/` | TypeScript | `backend/src/modules/hos/conformance.spec.ts` |
| `lib/hos/engine/` | Dart | Phase 4b mobile test suite |

A single failing fixture blocks the build in both repositories.

## File format

```jsonc
{
  "name": "drive-11h-exceeded-26min",        // unique, also the test name
  "spec": "§8.2 rule 1 — 11 h exceeded by 26 minutes",
  "input": {
    "timezone": "America/New_York",          // driver.homeTerminalTimezone — NOT Carrier.timezone
    "now": "2025-01-14T21:30:00Z",           // ISO-8601, always UTC (`Z`)
    "ruleset": "US_70_8_PROPERTY",
    "driver": { "driverId": "driver-1", "splitSleeperEnabled": true },
    "previousDays": [ { "date": "2025-01-13", "onDutySec": 39600 } ],
    "lastRestartEndedAt": null,
    "events": [
      { "at": "2025-01-14T05:00:00Z", "status": "OFF" },
      { "at": "2025-01-14T15:00:00Z", "status": "D", "special": "PC" }
    ]
  },
  "expected": { "driveRemainingSec": 0, "violations": [ { "type": "DRIVING_11", "exceededBySec": 1560 } ] }
}
```

* `status` — `OFF` | `SB` | `D` | `ON`; `special` — `NONE` | `PC` | `YM` (absent means `NONE`).
* `recordStatus` defaults to `1`; anything else must be ignored by the engine.
* Every timestamp is UTC. Day keys (`previousDays[].date`, `violations[].logDate`) are
  `YYYY-MM-DD` **in `input.timezone`**.

## Matching rules

* **Partial**: only the keys present in `expected` are asserted — a fixture about the break
  clock says nothing about the cycle.
* **`violations` is asserted in full**: same length, same order (by `occurredAt`, then by type
  name), and every named field must match exactly. `"violations": []` means *no* violations.
* Durations are integer **seconds**; `exceededBySec` is the overrun at the end of the
  offending period.

## Adding a fixture

Number it (`NNN-name.json`), write the expected values **by hand from 49 CFR §395**, never
by pasting engine output, and keep it deterministic: no `now()`, no locale, no randomness.

## Split sleeper: the fixtures follow §395.1(g)(1), not `tz.md` §8.2.1

`tz.md` §8.2.1 says the 11 h and 14 h counters **reset** at the end of the second qualifying
part. They do not. 49 CFR §395.1(g)(1) requires a **look-back**: when the second qualifying
period ends, both clocks are recomputed from the end of the **first** qualifying period, with
the second qualifying period excluded from the 14-hour window. Driving done *between* the two
halves therefore stays on the 11 h clock.

In §8.2.1's own worked example — 8 h SB → 4 h D → 2 h SB — the driver has **7 h of driving
left and a window ending 16 h after the first part**, not 11 h and a fresh 14 h window. The
reset wording is more permissive than the CFR and under-reports `DRIVING_11` and `SHIFT_14`;
§395 outranks `tz.md` (see `backend/decisions.md` D-012), so §8.2.1 is marked superseded.

The `split-*` fixtures encode the look-back. `052` and `053` exist specifically to fail if the
reset reading ever returns.
