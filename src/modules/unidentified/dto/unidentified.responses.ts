import { ApiProperty } from '@nestjs/swagger';
import { UnidentifiedStatus } from '@prisma/client';

/**
 * MB-12 — Swagger response classes for the unidentified-driving routes. Documentation only: the
 * shapes mirror `UnidentifiedService.toView` / `listConfirmationRequests`; the global
 * `TransformInterceptor` wraps them as `{ data, traceId, timestamp }` (`ApiEnvelopeResponse`).
 */
const DT = { type: String, format: 'date-time' } as const;
const INT = { type: 'integer' } as const;

export class UnidentifiedSegmentResponse {
  @ApiProperty({ type: String, format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid' }) vehicleId!: string;
  @ApiProperty(DT) startAt!: string;
  @ApiProperty(DT) endAt!: string;
  @ApiProperty(INT) durationSec!: number;
  @ApiProperty(INT) distanceMi!: number;
  @ApiProperty({ enum: UnidentifiedStatus, enumName: 'UnidentifiedStatus' }) status!: UnidentifiedStatus;
  @ApiProperty({ type: String, nullable: true, description: 'Driver the records belong to (ASSIGNED) or who is asked to confirm (PENDING_CONFIRMATION).' })
  assignedDriverId!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Carrier user who made / requested the assignment.' }) assignedById!: string | null;
  @ApiProperty({ ...DT, nullable: true }) assignedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 60 }) annotation!: string | null;
  @ApiProperty({ ...DT, nullable: true, description: 'B-83 — set while the segment waits for the asked driver.' }) confirmationRequestedAt!: string | null;
  @ApiProperty({ type: Boolean, description: '§23 — the records came out of the PT30 memory. Never dropped.' }) fromStoredEvents!: boolean;
  @ApiProperty({ type: [String], description: 'EldEvent ids (bigint as strings) of the unidentified records.' }) eventIds!: string[];
}

/** MB-11 — one "Was this you?" card (`GET /unidentified/confirmation-requests`). */
export class UnidentifiedConfirmationRequestView extends UnidentifiedSegmentResponse {
  @ApiProperty({ type: String, nullable: true, description: 'Appendix A 7.29 location text at the start (stored, else offline geo-location).' })
  startLocation!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Appendix A 7.29 location text at the end.' }) endLocation!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Vehicle unit number (Appendix A 7.4 CMV power unit number).' }) unitNumber!: string | null;
  @ApiProperty({ ...INT, nullable: true, description: 'Total vehicle miles on the first record that has one.' }) startOdometerMi!: number | null;
  @ApiProperty({ ...INT, nullable: true, description: 'Total vehicle miles on the last record that has one.' }) endOdometerMi!: number | null;
}

export class UnidentifiedConfirmationRequestListResponse {
  @ApiProperty({ type: () => UnidentifiedConfirmationRequestView, isArray: true }) items!: UnidentifiedConfirmationRequestView[];
}
