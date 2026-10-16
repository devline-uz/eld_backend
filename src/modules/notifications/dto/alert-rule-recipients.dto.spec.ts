import { CreateAlertRuleDto, UpdateAlertRuleDto } from './notifications.dto';

const rule = (roles: string[]) => ({
  key: 'rule-1',
  name: 'Rule',
  severity: 'WARNING',
  conditions: [{ event: 'hos.violation' }],
  channels: ['IN_APP'],
  recipients: { roles },
});

describe('Alert rule recipients (F3-01 — role keys are stored, legacy labels accepted)', () => {
  it('keeps role keys as they are', () => {
    expect(CreateAlertRuleDto.parse(rule(['ADMIN', 'FLEET_MANAGER', 'DISPATCHER'])).recipients.roles).toEqual(['ADMIN', 'FLEET_MANAGER', 'DISPATCHER']);
  });

  it('normalises the display labels the web used to send to role keys, de-duplicated', () => {
    expect(CreateAlertRuleDto.parse(rule(['Fleet managers', 'Assigned fleet manager', 'Dispatchers', 'Safety team'])).recipients.roles).toEqual([
      'FLEET_MANAGER',
      'DISPATCHER',
    ]);
  });

  it('normalises on update too', () => {
    expect(UpdateAlertRuleDto.parse({ recipients: { roles: ['Dispatchers', 'DISPATCHER'] } }).recipients?.roles).toEqual(['DISPATCHER']);
  });

  it('leaves an absent roles list absent', () => {
    expect(CreateAlertRuleDto.parse({ ...rule([]), recipients: { subjectDriver: true } }).recipients.roles).toBeUndefined();
  });
});
