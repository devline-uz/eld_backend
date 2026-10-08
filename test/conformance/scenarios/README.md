# Mobile HOS conformance scenarios (MR-33)

Runner: `src/modules/hos/mobile-scenarios.conformance.spec.ts` (unit project).
Run: `npx jest --selectProjects unit --maxWorkers=2 src/modules/hos/mobile-scenarios`.

Copy the mobile team's 74 files from `mobile/test/conformance/scenarios/*.json` into this
directory unchanged. Until at least one `*.json` is present the suite reports one `todo`; once
files are present it requires exactly 74 and every one must pass against the TS engine.

## File format (one scenario per file)

Same format as `eld.docs/hos-conformance/*.json` (TZ §8.6):

```json
{
  "name": "drive-11h-exceeded-26min",          // optional; defaults to the file name
  "spec": "§8.2 rule 1 — free text",            // optional, ignored
  "input": {
    "timezone": "America/New_York",              // driver.homeTerminalTimezone (IANA)
    "now": "2025-01-15T02:56:00Z",               // ISO-8601 instant the engine computes at
    "ruleset": "US_70_8_PROPERTY",               // or US_60_7_PROPERTY, ... (HosRuleset)
    "driver": { "driverId": "driver-1", "splitSleeperEnabled": true },
    "previousDays": [{ "date": "2025-01-10", "onDutySec": 36000 }],  // per-day recap; may be []
    "lastRestartEndedAt": null,                  // ISO-8601 or null
    "events": [
      { "at": "2025-01-14T05:00:00Z", "status": "OFF" },
      { "at": "2025-01-14T15:00:00Z", "status": "D", "special": "NONE",
        "recordStatus": 1, "eventSequenceId": 7 }  // special/recordStatus/eventSequenceId optional
    ]
  },
  "expected": {
    "driveUsedSec": 41160,                       // any HosState field; partial match
    "shiftEndsAt": "2025-01-15T05:00:00Z",       // instants compare by value
    "violations": [                              // if present: asserted in full (count + order)
      { "type": "DRIVING_11", "logDate": "2025-01-14", "exceededBySec": 1560 }
    ]
  }
}
```

- `status`: `OFF | SB | D | ON`; `special`: `NONE | PC | YM` (default `NONE`).
- `expected` keys are `HosState` fields (`hos.types.ts`): counters in seconds, instants as ISO-8601.
- Comments above are for the reader only — real files are plain JSON.
