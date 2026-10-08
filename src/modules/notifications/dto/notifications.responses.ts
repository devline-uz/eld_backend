import { ApiProperty } from '@nestjs/swagger';
import { AlertSeverity, NotificationKind } from '@prisma/client';

/** Swagger response classes (D-131) for `/notifications` — the raw `Notification` row and the list page. */
const DT = { type: String, format: 'date-time' } as const;
const INT = { type: 'integer' } as const;

export class NotificationView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) userId!: string | null;
  @ApiProperty({ type: String, nullable: true }) driverId!: string | null;
  @ApiProperty({ type: String, example: 'hos_violation', description: 'Event type that produced the notification.' }) type!: string;
  @ApiProperty({ enum: NotificationKind, enumName: 'NotificationKind', nullable: true }) kind!: NotificationKind | null;
  @ApiProperty({ type: String }) title!: string;
  @ApiProperty({ type: String }) body!: string;
  @ApiProperty({ type: String, nullable: true }) objectType!: string | null;
  @ApiProperty({ type: String, nullable: true }) objectId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'VIOLATIONS', description: 'Segment: VIOLATIONS | MAINTENANCE | null.' }) category!: string | null;
  @ApiProperty({ enum: AlertSeverity, enumName: 'AlertSeverity', nullable: true }) severity!: AlertSeverity | null;
  @ApiProperty({ ...DT, nullable: true }) readAt!: string | null;
  @ApiProperty(DT) createdAt!: string;
}

export class NotificationCountsView {
  @ApiProperty({ ...INT, description: 'Total rows (read + unread).' }) all!: number;
  @ApiProperty(INT) violations!: number;
  @ApiProperty(INT) maintenance!: number;
}

export class NotificationListResponse {
  @ApiProperty({ type: () => NotificationView, isArray: true }) items!: NotificationView[];
  @ApiProperty(INT) page!: number;
  @ApiProperty(INT) limit!: number;
  @ApiProperty({ ...INT, description: 'Rows matching `unreadOnly`/`category`.' }) total!: number;
  @ApiProperty(INT) totalPages!: number;
  @ApiProperty({ type: () => NotificationCountsView, description: 'TOTAL rows per segment, ignoring the filters — not unread counts.' }) counts!: NotificationCountsView;
  @ApiProperty({ ...INT, description: 'Unread notifications across all categories (badge).' }) unreadCount!: number;
}

export class NotificationsUpdatedResponse {
  @ApiProperty(INT) updated!: number;
}

export class NotificationReadResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ ...DT, nullable: true }) readAt!: string | null;
}
