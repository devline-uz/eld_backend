import { AlertProcessor } from './alert.processor';

function buildProcessor(overrides: {
  rulesFound?: unknown[];
  deliveriesTodayCount?: number;
  lastDelivered?: { sentAt: Date } | null;
  notificationChannels?: unknown;
  user?: { email: string; status: string } | null;
  driver?: { email: string | null; status: string; deletedAt: Date | null; homeTerminalTimezone?: string } | null;
  mailResult?: { delivered: boolean; reference: string };
  breakEpisodeDelivered?: boolean;
} = {}) {
  const created: unknown[] = [];
  const sentIds: string[] = [];
  const suppressed: Array<{ id: string; reason: string }> = [];

  const rules = { findByEvent: jest.fn(async () => overrides.rulesFound ?? []) };
  const deliveries = {
    create: jest.fn(async (data: Record<string, unknown>) => {
      const row = { id: `del_${created.length + 1}`, ...data };
      created.push(row);
      return row;
    }),
    countToday: jest.fn(async () => overrides.deliveriesTodayCount ?? 0),
    lastDelivered: jest.fn(async () => overrides.lastDelivered ?? null),
    existsForBreakEpisode: jest.fn(async () => overrides.breakEpisodeDelivered ?? false),
    markSent: jest.fn(async (id: string) => sentIds.push(id)),
    markSuppressed: jest.fn(async (id: string, reason: string) => suppressed.push({ id, reason })),
    markFailed: jest.fn(async () => undefined),
  };
  const prisma = {
    user: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => (overrides.user === undefined ? { email: 'dispatch@example.com', status: 'ACTIVE' } : overrides.user)),
    },
    driver: {
      findUnique: jest.fn(async () =>
        overrides.driver === undefined
          ? { homeTerminalTimezone: 'America/Chicago', email: 'driver@example.com', status: 'ACTIVE', deletedAt: null }
          : overrides.driver,
      ),
    },
    carrier: {
      findFirst: jest.fn(async () => ({ timezone: 'America/New_York', notificationChannels: overrides.notificationChannels ?? {} })),
    },
    notification: { create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'ntf_1', ...args.data })) },
  };
  const push = { sendToDriver: jest.fn(async () => undefined) };
  const webhooks = { notify: jest.fn(async () => null) };
  const events = { publish: jest.fn(async () => undefined) };
  const mail = { send: jest.fn(async () => overrides.mailResult ?? { delivered: true, reference: '<msg@x>' }) };

  const processor = new AlertProcessor(
    rules as never,
    deliveries as never,
    prisma as never,
    push as never,
    webhooks as never,
    events as never,
    mail,
  );
  return { processor, rules, deliveries, prisma, push, webhooks, events, mail, created, sentIds, suppressed };
}

const baseRule = {
  id: 'alr_1',
  severity: 'WARNING',
  channels: ['IN_APP'],
  recipients: { driverIds: ['drv_1'] },
  throttle: null,
  quietHours: null,
};

describe('AlertProcessor', () => {
  it('does nothing when no alert rule matches the event', async () => {
    const { processor, deliveries } = buildProcessor({ rulesFound: [] });
    await processor.process({ name: 'alert.odometer_anomaly', data: {} } as never);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  it('delivers IN_APP and creates a Notification row for a matched rule', async () => {
    const { processor, prisma, deliveries, sentIds } = buildProcessor({ rulesFound: [baseRule] });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    expect(deliveries.create).toHaveBeenCalledTimes(1);
    expect(sentIds).toHaveLength(1);
  });

  it('BE-12 — delivers a break-due rule once per (driver, break deadline)', async () => {
    const payload = { driverId: 'drv_1', minutesUntilBreak: 25, nextBreakDueAt: '2025-01-15T03:00:00.000Z' };
    const first = buildProcessor({ rulesFound: [baseRule] });
    await first.processor.process({ name: 'alert.break_due', data: payload } as never);
    expect(first.deliveries.existsForBreakEpisode).toHaveBeenCalledWith('alr_1', 'driver:drv_1', { driverId: 'drv_1', nextBreakDueAt: '2025-01-15T03:00:00.000Z' });
    expect(first.sentIds).toHaveLength(1);

    const repeat = buildProcessor({ rulesFound: [baseRule], breakEpisodeDelivered: true });
    await repeat.processor.process({ name: 'alert.break_due', data: { ...payload, minutesUntilBreak: 20 } } as never);
    expect(repeat.deliveries.create).not.toHaveBeenCalled();
    expect(repeat.prisma.notification.create).not.toHaveBeenCalled();
  });

  it('BE-12 — other alerts never consult the break-episode dedupe', async () => {
    const { processor, deliveries } = buildProcessor({ rulesFound: [baseRule], breakEpisodeDelivered: true });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(deliveries.existsForBreakEpisode).not.toHaveBeenCalled();
    expect(deliveries.create).toHaveBeenCalledTimes(1);
  });

  it('never dispatches an SMS channel even if one were somehow on the rule (defence in depth)', async () => {
    const rule = { ...baseRule, channels: ['IN_APP', 'SMS'] };
    const { processor, deliveries } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    // Only IN_APP creates a delivery row — SMS is skipped entirely.
    expect(deliveries.create).toHaveBeenCalledTimes(1);
    expect((deliveries.create.mock.calls[0][0] as { channel: string }).channel).toBe('IN_APP');
  });

  it('suppresses (but still records) a delivery blocked by throttle', async () => {
    const rule = { ...baseRule, throttle: { perDriverPerDay: 1 } };
    const { processor, deliveries, suppressed } = buildProcessor({ rulesFound: [rule], deliveriesTodayCount: 1 });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(deliveries.create).toHaveBeenCalledTimes(1);
    expect(suppressed).toEqual([{ id: 'del_1', reason: 'THROTTLED' }]);
  });

  it('suppresses a delivery blocked by cooldown', async () => {
    const rule = { ...baseRule, throttle: { cooldownMin: 60 } };
    const { processor, suppressed } = buildProcessor({
      rulesFound: [rule],
      lastDelivered: { sentAt: new Date() },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(suppressed[0]?.reason).toBe('COOLDOWN');
  });

  it('CRITICAL severity bypasses quiet-hours suppression', async () => {
    const rule = {
      ...baseRule,
      severity: 'CRITICAL',
      quietHours: { from: '00:00', to: '23:59', timezone: 'America/Chicago' },
    };
    const { processor, sentIds } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
    expect(sentIds).toHaveLength(1);
  });

  it('routes the WEBHOOK channel through WebhooksService.notify', async () => {
    const rule = { ...baseRule, channels: ['WEBHOOK'] };
    const { processor, webhooks } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(webhooks.notify).toHaveBeenCalledWith('alert', expect.objectContaining({ driverId: 'drv_1' }), {});
  });

  it('CODE-084: sends WEBHOOK alerts to the org webhook URL from Settings › Notifications', async () => {
    const rule = { ...baseRule, channels: ['WEBHOOK'] };
    const { processor, webhooks } = buildProcessor({
      rulesFound: [rule],
      notificationChannels: { webhook: { enabled: true, url: 'https://alerts.example.com/hook' } },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(webhooks.notify).toHaveBeenCalledWith('alert', expect.anything(), { url: 'https://alerts.example.com/hook' });
  });

  it('MB-13 — derives kind + objectType/objectId from the event name and includes kind in the FCM data payload', async () => {
    const rule = { ...baseRule, recipients: { driverIds: ['drv_1'] } };
    const { processor, prisma, push } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.trip_assigned', data: { driverId: 'drv_1', tripId: 'trip_9' } } as never);

    const expectedData: Record<string, unknown> = { kind: 'TRIP', objectType: 'Trip', objectId: 'trip_9' };
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expectedData) as Record<string, unknown> }),
    );
    expect(push.sendToDriver).toHaveBeenCalledWith(
      'drv_1',
      expect.anything(),
      expect.objectContaining({ type: rule.id, driverId: 'drv_1', kind: 'TRIP', objectType: 'Trip', objectId: 'trip_9' }),
    );
  });

  it('TZ §20 B-58 — writes a human body, category and severity onto the Notification row', async () => {
    const rule = { ...baseRule, severity: 'CRITICAL' };
    const { processor, prisma } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: 'An HOS violation was detected.',
          category: 'VIOLATIONS',
          severity: 'CRITICAL',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('TZ §20 B-87 — a disabled org EMAIL channel suppresses delivery without attempting to send', async () => {
    const rule = { ...baseRule, channels: ['EMAIL'] };
    const { processor, deliveries, suppressed, mail } = buildProcessor({
      rulesFound: [rule],
      notificationChannels: { email: { enabled: false } },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(deliveries.create).toHaveBeenCalledTimes(1);
    expect(suppressed).toEqual([{ id: 'del_1', reason: 'CHANNEL_DISABLED' }]);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('TZ §20 B-87 — a disabled org WEBHOOK channel suppresses delivery and never calls WebhooksService', async () => {
    const rule = { ...baseRule, channels: ['WEBHOOK'] };
    const { processor, webhooks, suppressed } = buildProcessor({
      rulesFound: [rule],
      notificationChannels: { webhook: { enabled: false } },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(webhooks.notify).not.toHaveBeenCalled();
    expect(suppressed).toEqual([{ id: 'del_1', reason: 'CHANNEL_DISABLED' }]);
  });

  it('D-095 follow-up — a subjectDriver: true rule (the seeded default) resolves the driver off payload.driverId and pushes FCM', async () => {
    const rule = { ...baseRule, recipients: { subjectDriver: true } };
    const { processor, prisma, push } = buildProcessor({ rulesFound: [rule] });

    await processor.process({ name: 'alert.edit_request', data: { driverId: 'drv_9', requestId: 'evt_1' } } as never);

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ driverId: 'drv_9' }) as Record<string, unknown> }),
    );
    expect(push.sendToDriver).toHaveBeenCalledWith('drv_9', expect.anything(), expect.objectContaining({ driverId: 'drv_9' }));
  });

  it('a subjectDriver: true rule sends nothing when the job payload carries no driverId', async () => {
    const rule = { ...baseRule, recipients: { subjectDriver: true } };
    const { processor, deliveries } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.edit_request', data: { requestId: 'evt_1' } } as never);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  describe('EMAIL channel (real SMTP via TRANSACTIONAL_MAIL)', () => {
    const emailRule = { ...baseRule, channels: ['EMAIL'] };

    it('emails a driver recipient and marks the delivery SENT', async () => {
      const { processor, mail, sentIds, deliveries } = buildProcessor({ rulesFound: [emailRule] });
      await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
      expect(mail.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'driver@example.com',
          subject: 'OneBook ELD warning alert: Alert',
          text: expect.stringContaining('An HOS violation was detected.') as string,
        }),
      );
      expect(sentIds).toEqual(['del_1']);
      expect(deliveries.markFailed).not.toHaveBeenCalled();
    });

    it('emails an ACTIVE user recipient', async () => {
      const rule = { ...emailRule, recipients: { userIds: ['usr_1'] } };
      const { processor, mail, sentIds } = buildProcessor({ rulesFound: [rule] });
      await processor.process({ name: 'alert.odometer_anomaly', data: { title: 'Odometer jump' } } as never);
      expect(mail.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'dispatch@example.com', subject: 'OneBook ELD warning alert: Odometer jump' }));
      expect(sentIds).toEqual(['del_1']);
    });

    it('marks the delivery FAILED (and does not throw) when SMTP does not deliver', async () => {
      const { processor, deliveries, sentIds } = buildProcessor({
        rulesFound: [emailRule],
        mailResult: { delivered: false, reference: 'SMTP_SEND_FAILED' },
      });
      await expect(processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never)).resolves.toBeUndefined();
      expect(deliveries.markFailed).toHaveBeenCalledWith('del_1', 'SMTP_SEND_FAILED');
      expect(sentIds).toHaveLength(0);
    });

    it('without SMTP_HOST (dev/CI) records NO_MAIL_TRANSPORT as the failure reason', async () => {
      const { processor, deliveries } = buildProcessor({
        rulesFound: [emailRule],
        mailResult: { delivered: false, reference: 'NO_MAIL_TRANSPORT' },
      });
      await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
      expect(deliveries.markFailed).toHaveBeenCalledWith('del_1', 'NO_MAIL_TRANSPORT');
    });

    it('never sends to a driver without an email and marks the delivery FAILED', async () => {
      const { processor, mail, deliveries } = buildProcessor({
        rulesFound: [emailRule],
        driver: { email: null, status: 'ACTIVE', deletedAt: null, homeTerminalTimezone: 'America/Chicago' },
      });
      await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
      expect(mail.send).not.toHaveBeenCalled();
      expect(deliveries.markFailed).toHaveBeenCalledWith('del_1', 'NO_EMAIL_ADDRESS');
    });

    it('never emails a DISABLED user', async () => {
      const rule = { ...emailRule, recipients: { userIds: ['usr_1'] } };
      const { processor, mail, deliveries } = buildProcessor({
        rulesFound: [rule],
        user: { email: 'gone@example.com', status: 'DISABLED' },
      });
      await processor.process({ name: 'alert.odometer_anomaly', data: {} } as never);
      expect(mail.send).not.toHaveBeenCalled();
      expect(deliveries.markFailed).toHaveBeenCalledWith('del_1', 'NO_EMAIL_ADDRESS');
    });

    it('a failed EMAIL does not block the IN_APP delivery of the same rule', async () => {
      const rule = { ...baseRule, channels: ['EMAIL', 'IN_APP'] };
      const { processor, prisma, sentIds, deliveries } = buildProcessor({
        rulesFound: [rule],
        mailResult: { delivered: false, reference: 'SMTP_SEND_FAILED' },
      });
      await processor.process({ name: 'alert.hos_violation', data: { driverId: 'drv_1' } } as never);
      expect(deliveries.markFailed).toHaveBeenCalledWith('del_1', 'SMTP_SEND_FAILED');
      expect(prisma.notification.create).toHaveBeenCalledTimes(1);
      expect(sentIds).toEqual(['del_2']);
    });
  });

  it('IN_APP is never gated by the org channel toggles', async () => {
    const { processor, sentIds } = buildProcessor({
      rulesFound: [baseRule],
      notificationChannels: { email: { enabled: false }, webhook: { enabled: false } },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(sentIds).toHaveLength(1);
  });
});
