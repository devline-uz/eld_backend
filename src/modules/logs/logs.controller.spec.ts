import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { annotationSchema, CreateLogEntryDto, CertifyDto, CreateEditRequestDto } from './dto/logs.dto';
import { LogsController } from './logs.controller';
import { MobileLogsController } from './mobile-logs.controller';

function permOf(method: keyof LogsController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, LogsController.prototype[method]) as PermRequirement | undefined;
}

/** TZ §6.4 / §9 — reading a log needs `hos`, proposing an edit needs `hosEdit: FULL`. */
describe('LogsController permissions', () => {
  it.each([
    ['getDay', 'hos', 'READ'],
    ['getRange', 'hos', 'READ'],
    ['getEvents', 'hos', 'READ'],
    ['listEditRequests', 'hos', 'READ'],
    ['createEditRequest', 'hosEdit', 'FULL'],
  ] as const)('%s requires %s:%s', (method, key, level) => {
    expect(permOf(method)).toEqual({ key, level });
  });

  it('accept/reject carry no back-office permission: only the driver may answer (§395.30)', () => {
    expect(permOf('accept')).toBeUndefined();
    expect(permOf('reject')).toBeUndefined();
  });

  it('certify is not permission-gated — the service enforces hosCertifyOnBehalf itself (§9.2)', () => {
    expect(permOf('certify')).toBeUndefined();
  });
});

describe('MobileLogsController', () => {
  it('routes the driver self-edit to the authenticated driver, never to a body-supplied id', async () => {
    const service = { createLogEntry: jest.fn(async () => ({ id: '1' })), certify: jest.fn(async () => ({})) };
    const controller = new MobileLogsController(service as never);
    const dto = { status: 'ON', startAt: new Date(), annotation: 'Loading' } as never;

    await controller.createEntry(dto, { id: 'driver-9', type: 'driver' });
    expect(service.createLogEntry).toHaveBeenCalledWith('driver-9', dto, { id: 'driver-9', type: 'driver' });

    await controller.certify({ dates: ['2026-06-01'] }, { id: 'driver-9', type: 'driver' });
    expect(service.certify).toHaveBeenCalledWith({ dates: ['2026-06-01'], driverId: undefined }, { id: 'driver-9', type: 'driver' });
  });
});

describe('RODS DTOs', () => {
  it('makes the annotation mandatory, 4-60 characters (§9.3, Appendix A)', () => {
    expect(annotationSchema.safeParse('abc').success).toBe(false);
    expect(annotationSchema.safeParse('Load').success).toBe(true);
    expect(annotationSchema.safeParse('x'.repeat(61)).success).toBe(false);
  });

  it('refuses a hand-entered driving status on the driver self-edit endpoint (§9.3)', () => {
    const parsed = CreateLogEntryDto.safeParse({
      status: 'D',
      startAt: '2026-06-01T18:00:00Z',
      annotation: 'Driving I forgot',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a carrier edit proposal with a reason and a numeric event id', () => {
    const parsed = CreateEditRequestDto.safeParse({
      originalEventId: '1234',
      proposedStatus: 'SB',
      proposedStart: '2026-06-01T18:00:00Z',
      reason: 'Driver was in the sleeper berth',
    });
    expect(parsed.success).toBe(true);
  });

  it('requires at least one date to certify', () => {
    expect(CertifyDto.safeParse({ dates: [] }).success).toBe(false);
    expect(CertifyDto.safeParse({ dates: ['2026-06-01'] }).success).toBe(true);
  });
});
