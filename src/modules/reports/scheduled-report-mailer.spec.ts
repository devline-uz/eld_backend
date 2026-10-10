import { SCHEDULED_REPORT_MAX_ATTACHMENT_BYTES, ScheduledReportMailer } from './scheduled-report-mailer';

describe('ScheduledReportMailer (TZ §15 — scheduled reports are emailed to their recipients)', () => {
  const report = {
    id: 'rpt_1',
    type: 'ACTIVITY',
    format: 'CSV',
    params: { from: '2026-09-01', to: '2026-09-07' },
    fileKey: 'reports/rpt_1.csv',
    fileSizeBytes: 12,
  };

  function build(recipients: string[] = ['ops@example.com', 'boss@example.com']) {
    const schedules = { findById: jest.fn(async () => ({ id: 'sch_1', recipients })) };
    const config = { get: jest.fn(() => 'https://panel.example.com') };
    const storage = { get: jest.fn(async () => Buffer.from('a,b\n')) };
    const mail = { send: jest.fn(async () => ({ delivered: true, reference: '<id@x>' })) };
    const mailer = new ScheduledReportMailer(schedules as never, config as never, storage as never, mail);
    return { mailer, schedules, storage, mail };
  }

  it('emails every recipient with the report file attached', async () => {
    const { mailer, schedules, storage, mail } = build();
    const result = await mailer.deliver('sch_1', report as never);

    expect(schedules.findById).toHaveBeenCalledWith({ id: 'sch_1' });
    expect(storage.get).toHaveBeenCalledWith('reports/rpt_1.csv');
    expect(result).toEqual({ recipients: 2, delivered: 2, attached: true });
    expect(mail.send).toHaveBeenCalledTimes(2);
    const [first] = mail.send.mock.calls[0] as unknown as [{ text: string }];
    expect(first.text).toContain('https://panel.example.com/reports');
    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.com',
        subject: 'Activity report · 2026-09-01 – 2026-09-07',
        attachments: [{ filename: 'rpt_1.csv', content: Buffer.from('a,b\n'), contentType: 'text/csv' }],
      }),
    );
  });

  it('links to the panel instead of attaching a file too large for SMTP', async () => {
    const { mailer, storage, mail } = build(['ops@example.com']);
    const result = await mailer.deliver('sch_1', { ...report, format: 'PDF', fileSizeBytes: SCHEDULED_REPORT_MAX_ATTACHMENT_BYTES + 1 } as never);
    expect(storage.get).not.toHaveBeenCalled();
    expect(result.attached).toBe(false);
    const [message] = mail.send.mock.calls[0] as unknown as [{ attachments?: unknown; text: string }];
    expect(message.attachments).toBeUndefined();
    expect(message.text).toContain('too large to attach');
  });

  it('counts an undelivered email (no SMTP_HOST) without throwing', async () => {
    const { mailer, mail } = build(['ops@example.com']);
    mail.send.mockResolvedValueOnce({ delivered: false, reference: 'NO_MAIL_TRANSPORT' });
    await expect(mailer.deliver('sch_1', report as never)).resolves.toEqual({ recipients: 1, delivered: 0, attached: true });
  });

  it('sends nothing when the schedule has no recipients (or was deleted)', async () => {
    const { mailer, mail, schedules } = build([]);
    await expect(mailer.deliver('sch_1', report as never)).resolves.toEqual({ recipients: 0, delivered: 0, attached: false });
    schedules.findById.mockResolvedValueOnce(null as never);
    await mailer.deliver('sch_gone', report as never);
    expect(mail.send).not.toHaveBeenCalled();
  });
});
