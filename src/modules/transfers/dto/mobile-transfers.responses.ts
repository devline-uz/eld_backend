import { ApiProperty } from '@nestjs/swagger';
import { ErodsMode, TransferMethod, TransferStatus } from '@prisma/client';

/** Swagger response classes (D-131) for `/mobile/transfers` — mirror `MobileTransferView` (`mobile-transfers.service.ts`). */
const DT = { type: String, format: 'date-time' } as const;
const INT = { type: 'integer' } as const;

export class MobileTransferView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ enum: TransferMethod, enumName: 'TransferMethod' }) method!: TransferMethod;
  @ApiProperty({ enum: TransferStatus, enumName: 'TransferStatus' }) status!: TransferStatus;
  @ApiProperty({ enum: ErodsMode, enumName: 'ErodsMode' }) erodsMode!: ErodsMode;
  @ApiProperty({ type: String, nullable: true }) referenceId!: string | null;
  @ApiProperty({ ...DT, nullable: true }) sentAt!: string | null;
  @ApiProperty(DT) createdAt!: string;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: String }) outputFileComment!: string;
  @ApiProperty({ ...DT, description: 'First RODS day (home-terminal timezone day key) rendered at T00:00:00.000Z — a `@db.Date` column, not an instant (B-172).' }) rangeStart!: string;
  @ApiProperty({ ...DT, description: 'Last RODS day (home-terminal timezone day key) rendered at T00:00:00.000Z — a `@db.Date` column, not an instant (B-172).' }) rangeEnd!: string;
}

export class MobileTransferCreatedResponse extends MobileTransferView {
  @ApiProperty({
    type: [String],
    description: '§10.3 pre-send warning codes (UNCERTIFIED_LOGS, UNRESOLVED_UNIDENTIFIED, ACTIVE_MALFUNCTION, ERODS_TEST_MODE).',
  })
  warnings!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'integer' }, description: 'Data-line count per output-file segment.' })
  counts!: Record<string, number>;
  @ApiProperty({ type: String, nullable: true, description: 'MB-18 — echo of the request `clientId` (offline-queued transfers).' }) clientId!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'MB-18 — when the driver asked for the transfer on the device.' }) requestedAt!: string | null;
}

export class MobileTransferListResponse {
  @ApiProperty({ type: () => MobileTransferView, isArray: true }) items!: MobileTransferView[];
  @ApiProperty(INT) total!: number;
  @ApiProperty(INT) limit!: number;
}
