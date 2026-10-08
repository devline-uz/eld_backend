# Mobile HOS conformance scenarios (MR-33)

Runner: `src/modules/hos/mobile-scenarios.conformance.spec.ts` (unit project).
Run: `npx jest --selectProjects unit --maxWorkers=2 src/modules/hos/mobile-scenarios`.

The 74 files are copied **unchanged** from the mobile repo (`eld_mobile` main,
`test/conformance/scenarios/*.json`). The Dart engine runs the same files with
`test/conformance/conformance_test.dart`; this runner mirrors it. The suite requires exactly 74
files, unique `id`s equal to the file names, and every scenario passing against the TS engine.
Never edit a scenario here to make it pass — disagreements go back to the mobile team.

Exception, engine 1.0.3 (requested by the mobile team, D-126): `R04-cycle70-over` and
`R04-cycle60-over` now **drive** past the cycle (their second event is `D`, was `ON`; expectations
unchanged) because §395.3(b) makes only driving past 60/70 h a violation. Copy both files back to
`eld_mobile/test/conformance/scenarios/`. Details: `backend/docs/hos-engine-1.0.3-changes.md`.

## File format (one scenario per file)

```json
{
  "id": "R01-drive11-exact",                     // == file name without .json, unique
  "rule": "DRIVING_11",                          // grouping tag (SPLIT_SLEEPER, RECAP, ...)
  "title": "Exactly 11:00 driving — at the limit, still legal",
  "input": {                                     // == TS HosInput (hos.types.ts), instants as ISO-8601 UTC
    "events": [
      { "at": "2026-01-15T01:00:00.000Z", "status": "OFF" },
      { "at": "2026-01-15T11:00:00.000Z", "status": "D", "special": "PC", "locationPrecisionMi": 10,
        "recordStatus": 1 }                      // special/recordStatus/locationPrecisionMi optional
    ],
    "driver": { "driverId": "drv-conformance", "allowPersonalConveyance": true },
    "ruleset": "US_70_8_PROPERTY",               // HosRuleset
    "now": "2026-01-15T22:30:00.000Z",
    "timezone": "America/New_York",              // driver.homeTerminalTimezone (IANA)
    "previousDays": [{ "date": "2026-01-08", "onDutySec": 28800 }],   // may be []
    "lastRestartEndedAt": null
  },
  "expect": {                                    // partial HosState: only the keys present are checked
    "driveUsedSec": 39600,
    "cycleRecapAt": "2026-01-16T05:00:00.000Z",  // instants compare by value (any offset)
    "dailyTotals": { "off": 0, "sb": 0, "drive": 0, "on": 0 },   // compared as a whole object
    "violations": [                              // if present: complete ordered list; [] = none
      { "type": "DRIVING_11", "logDate": "2026-01-15", "exceededBySec": 60 }
    ]
  }
}
```

Mapping to the TS engine: `input` is passed through `fixtureToInput` (`test/helpers/hos.ts`) as is;
`expect` keys are `HosState` field names; `violations` are compared on `type`, `logDate`,
`exceededBySec` only. Driver flags absent ⇒ `false` (in particular `allowPersonalConveyance` /
`allowYardMove`: an unauthorised PC/YM tag leaves the recorded status in force — B-131).
Comments above are for the reader only — real files are plain JSON.
