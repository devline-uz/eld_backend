import 'reflect-metadata';
import { PERM_METADATA_KEY, PermRequirement } from '../../common/decorators/perm.decorator';
import { DEFAULT_ROLE_MATRIX } from '../roles/permission-matrix';
import { TransfersController } from './transfers.controller';

function permOf(method: keyof TransfersController): PermRequirement | undefined {
  return Reflect.getMetadata(PERM_METADATA_KEY, TransfersController.prototype[method]) as
    | PermRequirement
    | undefined;
}

/** TZ §6.4 — `reportsTransfer`: ADMIN/FLEET_MANAGER FULL, DISPATCHER/VIEWER NONE. */
describe('TransfersController permissions', () => {
  it.each([
    ['create', 'FULL'],
    ['list', 'READ'],
    ['get', 'READ'],
    ['download', 'READ'],
  ] as const)('%s requires reportsTransfer:%s', (method, level) => {
    expect(permOf(method)).toEqual({ key: 'reportsTransfer', level });
  });

  it('is reachable only by ADMIN and FLEET_MANAGER per the §6.4 matrix', () => {
    const levels = Object.fromEntries(
      Object.entries(DEFAULT_ROLE_MATRIX).map(([role, perms]) => [role, perms.reportsTransfer]),
    );
    expect(levels).toMatchObject({ ADMIN: 'FULL', FLEET_MANAGER: 'FULL', DISPATCHER: 'NONE', VIEWER: 'NONE' });
  });
});

describe('TransfersController — delegates to TransfersService', () => {
  const service = {
    create: jest.fn().mockResolvedValue({ transfer: { id: 'trf_1' }, warnings: [], counts: {} }),
    list: jest.fn().mockResolvedValue({ items: [] }),
    get: jest.fn().mockResolvedValue({ id: 'trf_1' }),
    download: jest.fn().mockResolvedValue({ fileName: 'SMITH38018.csv', csv: 'ELD File Header Segment:\r\n' }),
  };
  const controller = new TransfersController(service as never);
  const actor = { id: 'usr_1', type: 'user' as const };

  it('create', async () => {
    const dto = { driverId: 'd', method: 'WEB_SERVICES' } as never;
    await controller.create(dto, actor);
    expect(service.create).toHaveBeenCalledWith(dto, actor);
  });

  it('list and get', async () => {
    await controller.list({ status: 'ALL', page: 1, limit: 25 } as never);
    await controller.get('trf_1');
    expect(service.list).toHaveBeenCalled();
    expect(service.get).toHaveBeenCalledWith('trf_1');
  });

  it('download sets the Appendix A 4.8.2.2 file name as the attachment name', async () => {
    const res = { setHeader: jest.fn() };
    const csv = await controller.download('trf_1', actor, res as never);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'attachment; filename="SMITH38018.csv"');
    // A string return value opts out of the JSON success envelope.
    expect(typeof csv).toBe('string');
  });
});
