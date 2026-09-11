import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { AlertRulesService } from './alert-rules.service';
import type { CreateAlertRuleDto } from './dto/notifications.dto';

function buildService(overrides: { findByKey?: unknown; findById?: unknown } = {}) {
  const repo = {
    listAll: jest.fn(async () => []),
    findByKey: jest.fn(async () => overrides.findByKey ?? null),
    findById: jest.fn(async () => overrides.findById ?? { id: 'alr_1', isSystem: false }),
    create: jest.fn(async (data: unknown) => ({ id: 'alr_new', ...(data as object) })),
    update: jest.fn(async (_where: unknown, data: unknown) => ({ id: 'alr_1', ...(data as object) })),
    delete: jest.fn(async () => ({ id: 'alr_1' })),
  };
  return { service: new AlertRulesService(repo as never), repo };
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
