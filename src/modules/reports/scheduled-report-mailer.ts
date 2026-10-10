import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Report } from '@prisma/client';
import { AppConfigService } from '../../core/config/config.service';
import { TRANSACTIONAL_MAIL, type TransactionalMailPort } from '../../core/mail/mail.port';
import { STORAGE_PORT, type StoragePort } from '../../core/storage/storage.port';
import { ReportSchedulesRepository } from './reports.repository';

/** Files above this are linked to the web panel instead of attached — most SMTP relays
 * (Gmail included) reject a message over ~25 MB once base64 has inflated it by a third. */
export const SCHEDULED_REPORT_MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const REPORT_LABEL: Record<string, string> = {
  IFTA: 'IFTA mileage report',
  ACTIVITY: 'Activity report',
  DVIR: 'DVIR report',
  FMCSA_PACK: 'FMCSA audit pack',
  RODS: 'Driver logs (RODS)',
  IDLE_FUEL: 'Idle & fuel report',
};

export interface ScheduledReportDeliveryResult {
  recipients: number;
  delivered: number;
  attached: boolean;
}

/**
 * TZ §15 report scheduler — emails a READY scheduled report to `ReportSchedule.recipients`.
 * Runs in the worker right after `report.processor` marks the row READY. A delivery failure is
 * logged and returned, never thrown: the report itself is generated and downloadable from the
 * panel either way, and a retry would regenerate the file.
 */
@Injectable()
export class ScheduledReportMailer {
  private readonly logger = new Logger(ScheduledReportMailer.name);

  constructor(
    private readonly schedules: ReportSchedulesRepository,
    private readonly config: AppConfigService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(TRANSACTIONAL_MAIL) private readonly mail: TransactionalMailPort,
  ) {}

  async deliver(scheduleId: string, report: Report): Promise<ScheduledReportDeliveryResult> {
    const schedule = await this.schedules.findById({ id: scheduleId });
    const recipients = schedule?.recipients ?? [];
    if (recipients.length === 0 || !report.fileKey) {
      this.logger.warn({ scheduleId, reportId: report.id }, 'Scheduled report has no recipients or no file — no email sent');
      return { recipients: 0, delivered: 0, attached: false };
    }

    const fileName = report.fileKey.split('/').pop() ?? report.fileKey;
    const label = REPORT_LABEL[report.type] ?? report.type;
    const attached = (report.fileSizeBytes ?? 0) <= SCHEDULED_REPORT_MAX_ATTACHMENT_BYTES;
    const content = attached ? await this.storage.get(report.fileKey) : null;
    const panelUrl = new URL('/reports', this.config.get('WEB_APP_URL')).toString();
    const period = describePeriod(report.params);
    const text = [
      `Your scheduled ${label}${period ? ` for ${period}` : ''} is ready.`,
      '',
      content
        ? `The file (${fileName}) is attached.`
        : `The file (${fileName}) is too large to attach — download it from the web panel.`,
      `All generated reports: ${panelUrl}`,
    ].join('\n');

    let delivered = 0;
    for (const to of recipients) {
      const result = await this.mail.send({
        to,
        subject: `${label}${period ? ` · ${period}` : ''}`,
        text,
        ...(content
          ? { attachments: [{ filename: fileName, content, contentType: report.format === 'PDF' ? 'application/pdf' : 'text/csv' }] }
          : {}),
      });
      if (result.delivered) delivered += 1;
      else this.logger.warn({ scheduleId, reportId: report.id, reason: result.reference }, 'Scheduled report email was NOT delivered');
    }
    this.logger.log({ scheduleId, reportId: report.id, recipients: recipients.length, delivered }, 'Scheduled report emailed');
    return { recipients: recipients.length, delivered, attached: content !== null };
  }
}

function describePeriod(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (typeof p.quarter === 'string') return p.quarter;
  if (typeof p.from === 'string' && typeof p.to === 'string') return `${p.from} – ${p.to}`;
  return null;
}
