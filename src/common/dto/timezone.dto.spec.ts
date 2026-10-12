import { IanaTimezoneSchema, isValidIanaTimezone } from './timezone.dto';
import { CreateDriverDto, UpdateDriverDto } from '../../modules/drivers/dto/drivers.dto';
import { UpdateCarrierDto } from '../../modules/carrier/dto/carrier.dto';

describe('IanaTimezoneSchema (BE-003)', () => {
  it.each(['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'])(
    'accepts %s',
    (tz) => expect(IanaTimezoneSchema.parse(tz)).toBe(tz),
  );

  it.each(['America/Chicagoo', 'Mars/Phobos', 'not a zone', ''])('rejects %p', (tz) => {
    expect(IanaTimezoneSchema.safeParse(tz).success).toBe(false);
    expect(isValidIanaTimezone(tz)).toBe(false);
  });

  it('is enforced on driver create/update and carrier update', () => {
    const driver = { username: 'jsmith', firstName: 'J', lastName: 'S', cdlNumber: 'D1', cdlState: 'OH' };
    expect(CreateDriverDto.safeParse({ ...driver, homeTerminalTimezone: 'America/Chicagoo' }).success).toBe(false);
    expect(CreateDriverDto.parse(driver).homeTerminalTimezone).toBe('America/New_York');
    expect(UpdateDriverDto.safeParse({ homeTerminalTimezone: 'Bad/Zone' }).success).toBe(false);
    expect(UpdateCarrierDto.safeParse({ timezone: 'Bad/Zone' }).success).toBe(false);
    expect(UpdateCarrierDto.safeParse({ timezone: 'America/Chicago' }).success).toBe(true);
  });
});
