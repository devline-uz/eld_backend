import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import type { ContextUser } from '../../core/context/request-context';
import { AlertRulesService } from './alert-rules.service';
import type { CreateAlertRuleDto } from './dto/notifications.dto';

function buildService(
  overrides: {
    findByKey?: unknown;
    findById?: unknown;
    email?: string | null;
    mailResult?: { delivered: boolean; reference: string };
    org?: { email: { enabled: boolean }; webhook: { enabled: boolean } };
    webhookDelivery?: unknown;
  } = {},
) {
  const repo = {
    listAll: jest.fn(async () => []),
    findByKey: jest.fn(async () => overrides.findByKey ?? null),
    findById: jest.fn(async () => overrides.findById ?? { id: 'alr_1', isSystem: false }),
    create: jest.fn(async (data: unknown) => ({ id: 'alr_new', ...(data as object) })),
    update: jest.fn(async (_where: unknown, data: unknown) => ({ id: 'alr_1', ...(data as object) })),
    delete: jest.fn(async () => ({ id: 'alr_1' })),
  };
  const notifications = {
    create: jest.fn(async (data: Record<string, unknown>) => ({ id: 'ntf_test', readAt: null, ...data })),
    findLiveEmail: jest.fn(async () => (overrides.email === undefined ? 'anna@example.com' : overrides.email)),
  };
  const events = { publish: jest.fn(async () => undefined) };
  const webhooks = {
    notify: jest.fn(async () => (overrides.webhookDelivery === undefined ? { id: 'whd_1' } : overrides.webhookDelivery)),
  };
  const orgChannels = {
    get: jest.fn(async () => overrides.org ?? { email: { enabled: true }, webhook: { enabled: true } }),
  };
  const mail = { send: jest.fn(async () => overrides.mailResult ?? { delivered: true, reference: '<msg@x>' }) };
  return {
    service: new AlertRulesService(
      repo as never,
      notifications as never,
      events as never,
      webhooks as never,
      orgChannels as never,
      mail,
    ),
    repo,
    notifications,
    events,
    webhooks,
    mail,
  };
}

const baseDto: CreateAlertRuleDto = {
  key: 'custom_rule',
  name: 'Custom rule',
  severity: 'WARNING',
  conditions: [{ event: 'alert.custom' }],
  channels: ['IN_APP'],
  recipients: { subjectDriver: true },
  enabled: true,
};

describe('AlertRulesService — SMS rejection (TZ §14)', () => {
  it('creates a rule fine when SMS is not among the channels', async () => {
    const { service } = buildService();
    const rule = await service.create(baseDto);
    expect(rule).toBeDefined();
  });

  it('rejects creation with 422 CHANNEL_NOT_AVAILABLE when channels include SMS', async () => {
    const { service } = buildService();
    await expect(service.create({ ...baseDto, channels: ['IN_APP', 'SMS'] })).rejects.toMatchObject({
      code: ERROR_CODES.CHANNEL_NOT_AVAILABLE,
    });
  });

  it('the rejection carries { channel: "SMS", availableIn: "v2" } in details', async () => {
    const { service } = buildService();
    try {
      await service.create({ ...baseDto, channels: ['SMS'] });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppException);
      expect((err as AppException).details).toEqual({ channel: 'SMS', availableIn: 'v2' });
    }
  });

  it('rejects an update that adds SMS to an existing rule', async () => {
    const { service } = buildService({ findById: { id: 'alr_1', isSystem: false } });
    await expect(service.update('alr_1', { channels: ['SMS'] })).rejects.toMatchObject({
      code: ERROR_CODES.CHANNEL_NOT_AVAILABLE,
    });
  });
});

describe('AlertRulesService — system rule protection', () => {
  it('refuses to delete a system rule', async () => {
    const { service } = buildService({ findById: { id: 'alr_sys', isSystem: true } });
    await expect(service.remove('alr_sys')).rejects.toMatchObject({ code: ERROR_CODES.ALERT_RULE_INVALID });
  });

  it('refuses to change a system rule\'s conditions', async () => {
    const { service } = buildService({ findById: { id: 'alr_sys', isSystem: true } });
    await expect(service.update('alr_sys', { conditions: [{ event: 'x' }] })).rejects.toMatchObject({
      code: ERROR_CODES.ALERT_RULE_INVALID,
    });
  });
});

describe('AlertRulesService — key conflict', () => {
  it('rejects creating a rule with a duplicate key', async () => {
    const { service } = buildService({ findByKey: { id: 'alr_existing' } });
    await expect(service.create(baseDto)).rejects.toMatchObject({ code: ERROR_CODES.CONFLICT });
  });
});

const backOfficeActor: ContextUser = { id: 'usr_1', type: 'user' };
const driverActor: ContextUser = { id: 'drv_1', type: 'driver' };

describe('AlertRulesService — test rule (TZ §20 B-9)', () => {
  it('sends through every configured channel and returns { triggered: true }', async () => {
    const { service, notifications, events, webhooks } = buildService({
      findById: { id: 'alr_1', isSystem: false, enabled: true, name: 'HOS violation', severity: 'CRITICAL', channels: ['IN_APP', 'WEBHOOK'] },
    });
    const result = await service.testRule('alr_1', backOfficeActor);
    expect(result).toEqual({
      triggered: true,
      channels: [
        { channel: 'IN_APP', status: 'SENT' },
        { channel: 'WEBHOOK', status: 'QUEUED' },
      ],
    });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'usr_1', severity: 'CRITICAL' }));
    expect(events.publish).toHaveBeenCalledWith('realtime.push', expect.objectContaining({ room: 'user:usr_1', event: 'notification.new' }));
    expect(webhooks.notify).toHaveBeenCalledWith('alert.test', expect.objectContaining({ ruleId: 'alr_1' }));
  });

  it('addresses a driver actor by driverId, not userId', async () => {
    const { service, notifications } = buildService({
      findById: { id: 'alr_1', isSystem: false, enabled: true, name: 'HOS violation', severity: 'WARNING', channels: ['IN_APP'] },
    });
    await service.testRule('alr_1', driverActor);
    expect(notifications.create).toHaveBeenCalledWith(expect.objectContaining({ driverId: 'drv_1' }));
  });

  it('never sends through SMS even if somehow present on the row', async () => {
    const { service, notifications, webhooks } = buildService({
      findById: { id: 'alr_1', isSystem: false, enabled: true, name: 'X', severity: 'INFO', channels: ['SMS'] },
    });
    const result = await service.testRule('alr_1', backOfficeActor);
    expect(result).toEqual({ triggered: false, channels: [] });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(webhooks.notify).not.toHaveBeenCalled();
  });

  it('a disabled rule triggers nothing', async () => {
    const { service, notifications, webhooks } = buildService({
      findById: { id: 'alr_1', isSystem: false, enabled: false, name: 'X', severity: 'INFO', channels: ['IN_APP', 'WEBHOOK'] },
    });
    const result = await service.testRule('alr_1', backOfficeActor);
    expect(result).toEqual({ triggered: false, channels: [] });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(webhooks.notify).not.toHaveBeenCalled();
  });

  it('reports WEBHOOK as FAILED when no webhook integration is configured', async () => {
    const { service } = buildService({
      findById: { id: 'alr_1', isSystem: false, enabled: true, name: 'X', severity: 'INFO', channels: ['WEBHOOK'] },
      webhookDelivery: null,
    });
    await expect(service.testRule('alr_1', backOfficeActor)).resolves.toEqual({
      triggered: false,
      channels: [{ channel: 'WEBHOOK', status: 'FAILED', reason: 'NO_WEBHOOK_CONFIGURED' }],
    });
  });
});

describe('AlertRulesService — test rule EMAIL channel', () => {
  const emailRule = { id: 'alr_1', isSystem: false, enabled: true, name: 'HOS violation', severity: 'CRITICAL', channels: ['EMAIL'] };

  it('sends a real [TEST] email to the acting user via TRANSACTIONAL_MAIL', async () => {
    const { service, notifications, mail } = buildService({ findById: emailRule });
    const result = await service.testRule('alr_1', backOfficeActor);
    expect(result).toEqual({ triggered: true, channels: [{ channel: 'EMAIL', status: 'SENT' }] });
    expect(notifications.findLiveEmail).toHaveBeenCalledWith('user', 'usr_1');
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [message] = mail.send.mock.calls[0] as unknown as [{ to: string; subject: string; text: string }];
    expect(message.to).toBe('anna@example.com');
    expect(message.subject).toBe('[TEST] OneBook ELD critical alert: HOS violation');
    expect(message.text).toContain('Severity: CRITICAL');
    expect(message.text).toContain('Rule: HOS violation');
  });

  it('looks up a driver actor\'s address as a driver', async () => {
    const { service, notifications } = buildService({ findById: emailRule });
    await service.testRule('alr_1', driverActor);
    expect(notifications.findLiveEmail).toHaveBeenCalledWith('driver', 'drv_1');
  });

  it('reports FAILED with the transport reason when SMTP does not deliver', async () => {
    const { service } = buildService({ findById: emailRule, mailResult: { delivered: false, reference: 'SMTP_SEND_FAILED' } });
    await expect(service.testRule('alr_1', backOfficeActor)).resolves.toEqual({
      triggered: false,
      channels: [{ channel: 'EMAIL', status: 'FAILED', reason: 'SMTP_SEND_FAILED' }],
    });
  });

  it('reports FAILED NO_MAIL_TRANSPORT when SMTP is not configured', async () => {
    const { service } = buildService({ findById: emailRule, mailResult: { delivered: false, reference: 'NO_MAIL_TRANSPORT' } });
    const result = await service.testRule('alr_1', backOfficeActor);
    expect(result.channels).toEqual([{ channel: 'EMAIL', status: 'FAILED', reason: 'NO_MAIL_TRANSPORT' }]);
  });

  it('reports FAILED NO_EMAIL_ADDRESS and never calls SMTP when the actor has no live address', async () => {
    const { service, mail } = buildService({ findById: emailRule, email: null });
    await expect(service.testRule('alr_1', backOfficeActor)).resolves.toEqual({
      triggered: false,
      channels: [{ channel: 'EMAIL', status: 'FAILED', reason: 'NO_EMAIL_ADDRESS' }],
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('an api-key caller has no mailbox — NO_EMAIL_ADDRESS', async () => {
    const { service, notifications, mail } = buildService({ findById: emailRule });
    const result = await service.testRule('alr_1', { id: 'key_1', type: 'api-key' });
    expect(result.channels).toEqual([{ channel: 'EMAIL', status: 'FAILED', reason: 'NO_EMAIL_ADDRESS' }]);
    expect(notifications.findLiveEmail).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('honours the org-level Email switch (SUPPRESSED CHANNEL_DISABLED), like live delivery', async () => {
    const { service, mail } = buildService({
      findById: emailRule,
      org: { email: { enabled: false }, webhook: { enabled: true } },
    });
    await expect(service.testRule('alr_1', backOfficeActor)).resolves.toEqual({
      triggered: false,
      channels: [{ channel: 'EMAIL', status: 'SUPPRESSED', reason: 'CHANNEL_DISABLED' }],
    });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('IN_APP still counts as triggered when EMAIL fails alongside it', async () => {
    const { service } = buildService({
      findById: { ...emailRule, channels: ['IN_APP', 'EMAIL'] },
      mailResult: { delivered: false, reference: 'SMTP_SEND_FAILED' },
    });
    await expect(service.testRule('alr_1', backOfficeActor)).resolves.toEqual({
      triggered: true,
      channels: [
        { channel: 'IN_APP', status: 'SENT' },
        { channel: 'EMAIL', status: 'FAILED', reason: 'SMTP_SEND_FAILED' },
      ],
    });
  });
});
