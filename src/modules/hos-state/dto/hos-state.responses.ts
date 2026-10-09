import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DutyStatus, ViolationType } from '@prisma/client';

/**
 * Swagger response classes (D-131) for `POST /mobile/hos-state` and `bootstrap.hos.state` —
 * mirror `ServerHosState` / `HosStateSubmitResult` (`hos-drift.ts`, `hos-state.service.ts`).
 */
const DT = { type: String, format: 'date-time' } as const;
const INT = { type: 'integer' } as const;

export class HosDailyTotalsView {
  @ApiProperty(INT) off!: number;
  @ApiProperty(INT) sb!: number;
  @ApiProperty(INT) drive!: number;
  @ApiProperty(INT) on!: number;
}

export class HosViolationEntryView {
  @ApiProperty({ enum: ViolationType, enumName: 'ViolationType' }) type!: ViolationType;
  @ApiProperty(INT) exceededBySec!: number;
}

/** The server's HOS state in the app's shape (+ MR-24 timestamps). */
export class ServerHosStateView {
  @ApiProperty({ enum: DutyStatus, enumName: 'DutyStatus' }) currentStatus!: DutyStatus;
  @ApiProperty(INT) driveRemainingSec!: number;
  @ApiProperty(INT) shiftRemainingSec!: number;
  @ApiProperty(INT) breakRemainingSec!: number;
  @ApiProperty(INT) cycleRemainingSec!: number;
  @ApiProperty({ type: () => HosDailyTotalsView }) dailyTotals!: HosDailyTotalsView;
  @ApiProperty({ type: () => HosViolationEntryView, isArray: true, description: 'Worst `exceededBySec` per type.' }) violations!: HosViolationEntryView[];
  @ApiProperty({ ...DT, description: 'MR-24 — when the current duty status started.' }) statusSince!: string;
  @ApiProperty({ ...DT, nullable: true, description: 'MR-24 — when the 30-minute break is due (while driving or overdue), else null.' }) nextBreakDueAt!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'MR-24 — when the 14-hour window ends (passenger: now + remaining on-duty time); null with no open shift.' }) shiftEndsAt!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'MR-24 — next home-terminal midnight at which recap hours come back; null when the cycle window is empty.' }) cycleRecapAt!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'MR-24 — while OFF/SB: when the rest reaches 34 h; else null. Always null on passenger rulesets.' }) restartAvailableAt!: string | null;
}

export class HosDriftFieldView {
  @ApiProperty({ type: String, example: 'driveRemainingSec' }) field!: string;
  @ApiProperty(INT) serverSec!: number;
  @ApiProperty(INT) appSec!: number;
  @ApiProperty(INT) diffSec!: number;
}

export class HosStateSubmitResponse {
  @ApiProperty({ type: String, example: '1.0.3', description: 'The SERVER engine version.' }) hosEngineVersion!: string;
  @ApiProperty({ type: Boolean, enum: [true] }) accepted!: true;
  @ApiProperty({ type: Boolean }) versionMismatch!: boolean;
  @ApiProperty({ type: Boolean, description: 'True only with `reason: "VERSION_MISMATCH"` when the app engine is OLDER than `hosEngineVersion`.' }) updateRequired!: boolean;
  @ApiProperty({ type: Boolean }) compared!: boolean;
  @ApiPropertyOptional({ enum: ['STALE', 'VERSION_MISMATCH'], enumName: 'HosCompareSkipReason', description: 'MR-1 — present only when `compared` is false.' }) reason?: 'STALE' | 'VERSION_MISMATCH';
  @ApiPropertyOptional({ ...INT, description: 'MR-1 — with `reason: "STALE"`: age of `computedAt` in seconds.' }) staleSec?: number;
  @ApiProperty({ type: Boolean, description: 'The server raised `alert.hos_engine_drift`.' }) drift!: boolean;
  @ApiProperty({ ...INT, nullable: true }) maxDriftSec!: number | null;
  @ApiProperty({ type: () => HosDriftFieldView, isArray: true }) fields!: HosDriftFieldView[];
  @ApiProperty({ type: Boolean }) statusMismatch!: boolean;
  @ApiProperty({ type: () => ServerHosStateView, nullable: true, description: 'Null when not compared.' }) serverState!: ServerHosStateView | null;
  @ApiProperty({ ...INT, example: 60 }) driftThresholdSec!: number;
  @ApiPropertyOptional({ type: String, description: 'Human-readable note, present when not compared.' }) message?: string;
}
