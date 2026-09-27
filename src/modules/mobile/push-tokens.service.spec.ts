import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { PushTokensRepository } from './push-tokens.repository';
import { PushTokensService } from './push-tokens.service';

describe('PushTokensService', () => {
  let repo: jest.Mocked<Pick<PushTokensRepository, 'upsert' | 'deleteOwnedByDriver'>>;
  let service: PushTokensService;

  beforeEach(() => {
    repo = {
      upsert: jest.fn().mockResolvedValue({ id: 'pt_1', driverId: 'drv_1', token: 'tok', platform: 'IOS' }),
      deleteOwnedByDriver: jest.fn(),
    };
    service = new PushTokensService(repo as unknown as PushTokensRepository);
  });

  it('registers a token, re-owning it to the calling driver', async () => {
    await service.register('drv_1', { token: 'tok', platform: 'IOS' });
    expect(repo.upsert).toHaveBeenCalledWith('drv_1', 'tok', 'IOS', null);
  });

  it('passes the optional deviceLabel through', async () => {
    await service.register('drv_1', { token: 'tok', platform: 'ANDROID', deviceLabel: 'Tablet #2' });
    expect(repo.upsert).toHaveBeenCalledWith('drv_1', 'tok', 'ANDROID', 'Tablet #2');
  });

  it('deletes a token owned by the calling driver', async () => {
    repo.deleteOwnedByDriver.mockResolvedValue(true);
    await expect(service.remove('drv_1', 'tok')).resolves.toEqual({ deleted: true });
  });

  it('404s when the token does not belong to (or exist for) the calling driver', async () => {
    repo.deleteOwnedByDriver.mockResolvedValue(false);
    await expect(service.remove('drv_1', 'tok')).rejects.toBeInstanceOf(AppException);
    repo.deleteOwnedByDriver.mockResolvedValue(false);
    try {
      await service.remove('drv_1', 'tok');
      fail('expected AppException');
    } catch (err) {
      expect((err as AppException).code).toBe(ERROR_CODES.NOT_FOUND);
    }
  });
});
