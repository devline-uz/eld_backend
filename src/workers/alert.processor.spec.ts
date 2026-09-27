import { AlertProcessor } from './alert.processor';

function buildProcessor(overrides: {
  rulesFound?: unknown[];
  deliveriesTodayCount?: number;
  lastDelivered?: { sentAt: Date } | null;
  notificationChannels?: unknown;
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
    markSent: jest.fn(async (id: string) => sentIds.push(id)),
    markSuppressed: jest.fn(async (id: string, reason: string) => suppressed.push({ id, reason })),
    markFailed: jest.fn(async () => undefined),
  };
  const prisma = {
    user: { findMany: jest.fn(async () => []) },
    driver: { findUnique: jest.fn(async () => ({ homeTerminalTimezone: 'America/Chicago' })) },
    carrier: {
      findFirst: jest.fn(async () => ({ timezone: 'America/New_York', notificationChannels: overrides.notificationChannels ?? {} })),
    },
    notification: { create: jest.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'ntf_1', ...args.data })) },
  };
  const mobile = { findPushTokens: jest.fn(async (): Promise<{ token: string }[]> => []) };
  const firebase = { enabled: false, sendToToken: jest.fn() };
  const webhooks = { notify: jest.fn(async () => null) };
  const events = { publish: jest.fn(async () => undefined) };

  const processor = new AlertProcessor(
    rules as never,
    deliveries as never,
    prisma as never,
    mobile as never,
    firebase as never,
    webhooks as never,
    events as never,
  );
  return { processor, rules, deliveries, prisma, mobile, firebase, webhooks, events, created, sentIds, suppressed };
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
    expect(webhooks.notify).toHaveBeenCalledWith('alert', expect.objectContaining({ driverId: 'drv_1' }));
  });

  it('MB-13 — derives kind + objectType/objectId from the event name and includes kind in the FCM data payload', async () => {
    const rule = { ...baseRule, recipients: { driverIds: ['drv_1'] } };
    const { processor, prisma, firebase, mobile } = buildProcessor({ rulesFound: [rule] });
    firebase.enabled = true;
    mobile.findPushTokens = jest.fn(async () => [{ token: 'tok_1' }]);
    await processor.process({ name: 'alert.trip_assigned', data: { driverId: 'drv_1', tripId: 'trip_9' } } as never);

    const expectedData: Record<string, unknown> = { kind: 'TRIP', objectType: 'Trip', objectId: 'trip_9' };
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expectedData) as Record<string, unknown> }),
    );
    expect(firebase.sendToToken).toHaveBeenCalledWith(
      'tok_1',
      expect.anything(),
      expect.objectContaining({ type: rule.id, driverId: 'drv_1', kind: 'TRIP' }),
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
    const { processor, deliveries, suppressed } = buildProcessor({
      rulesFound: [rule],
      notificationChannels: { email: { enabled: false } },
    });
    await processor.process({ name: 'alert.odometer_anomaly', data: { driverId: 'drv_1' } } as never);
    expect(deliveries.create).toHaveBeenCalledTimes(1);
    expect(suppressed).toEqual([{ id: 'del_1', reason: 'CHANNEL_DISABLED' }]);
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
    const { processor, prisma, firebase, mobile } = buildProcessor({ rulesFound: [rule] });
    firebase.enabled = true;
    mobile.findPushTokens = jest.fn(async () => [{ token: 'tok_bg' }]);

    await processor.process({ name: 'alert.edit_request', data: { driverId: 'drv_9', requestId: 'evt_1' } } as never);

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ driverId: 'drv_9' }) as Record<string, unknown> }),
    );
    expect(mobile.findPushTokens).toHaveBeenCalledWith('drv_9');
    expect(firebase.sendToToken).toHaveBeenCalledWith('tok_bg', expect.anything(), expect.objectContaining({ driverId: 'drv_9' }));
  });

  it('a subjectDriver: true rule sends nothing when the job payload carries no driverId', async () => {
    const rule = { ...baseRule, recipients: { subjectDriver: true } };
    const { processor, deliveries } = buildProcessor({ rulesFound: [rule] });
    await processor.process({ name: 'alert.edit_request', data: { requestId: 'evt_1' } } as never);
    expect(deliveries.create).not.toHaveBeenCalled();
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
