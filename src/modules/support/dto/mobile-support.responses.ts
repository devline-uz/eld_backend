import { ApiProperty } from '@nestjs/swagger';
import { SupportContactMethod, TicketPriority, TicketStatus } from '@prisma/client';

/** Swagger response classes (D-131) for the driver's support routes — mirror `toMobileTicket` and the raw rows. */
const DT = { type: String, format: 'date-time' } as const;

export class FeedbackResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) driverId!: string | null;
  @ApiProperty({ type: String, nullable: true }) userId!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The survey answers as sent (MR-28).' }) answers!: Record<string, unknown>;
  @ApiProperty({ type: String, nullable: true }) comment!: string | null;
  @ApiProperty({ type: String, nullable: true }) appVersion!: string | null;
  @ApiProperty({ type: String, nullable: true }) platform!: string | null;
  @ApiProperty(DT) createdAt!: string;
}

/** `GET /mobile/support/tickets[/{id}]` row. */
export class MobileSupportTicketView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, example: 'TCK-000009' }) number!: string;
  @ApiProperty({ type: String }) subject!: string;
  @ApiProperty({ type: String }) body!: string;
  @ApiProperty({ type: String, nullable: true, example: 'diagnostics' }) category!: string | null;
  @ApiProperty({ enum: TicketPriority, enumName: 'TicketPriority' }) priority!: TicketPriority;
  @ApiProperty({ enum: TicketStatus, enumName: 'TicketStatus' }) status!: TicketStatus;
  @ApiProperty({ enum: SupportContactMethod, enumName: 'SupportContactMethod', nullable: true }) contactMethod!: SupportContactMethod | null;
  @ApiProperty(DT) createdAt!: string;
  @ApiProperty(DT) updatedAt!: string;
}

/** `POST /mobile/support/tickets` answers the stored row: the list fields plus the ownership columns. */
export class MobileSupportTicketCreatedResponse extends MobileSupportTicketView {
  @ApiProperty({ type: String, nullable: true }) createdByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) createdByDriverId!: string | null;
  @ApiProperty({ type: String, nullable: true }) assignedToId!: string | null;
  @ApiProperty({ ...DT, nullable: true }) resolvedAt!: string | null;
}

export class MobileSupportTicketListResponse {
  @ApiProperty({ type: () => MobileSupportTicketView, isArray: true }) items!: MobileSupportTicketView[];
}
