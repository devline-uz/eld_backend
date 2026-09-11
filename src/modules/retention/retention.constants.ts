/**
 * TZ §5.5 / §18 / §23 compliance checklist ("RODS retained 6 months, audit retained 24
 * months") · 49 CFR §395.8(k) / §395.22(h) / §395.30.
 *
 * §5.5's table states the ELD event partition DROP threshold directly as "24 oydan eski
 * partition -> arxivga, keyin DETACH" (partitions older than 24 months are archived then
 * detached) while the same row also frames it as "minimum 6 oy issiq + 24 oy arxiv". Both
 * numbers point at the same floor: 24 months is a superset of the 6-month FMCSA RODS
 * minimum, so enforcing the 24-month threshold for the actual DROP satisfies both the RODS
 * 6-month rule and the audit/dispute 24-month rule at once. See decisions.md D-040 for the
 * full reasoning and the alternative (30-month) reading that was rejected.
 */
export const EVENT_RETENTION_MONTHS = 24;

/** TZ §18/§23 — AuditLog rows must survive at least 24 months before they may be purged. */
export const AUDIT_RETENTION_MONTHS = 24;

/** S3 prefix under which retention archives rows before a DROP/DELETE (TZ §17 — private,
 * never publicly listed; retained itself per the 24-month, 7-year-ish audit trail need). */
export const RETENTION_ARCHIVE_PREFIX = 'retention-archive';
