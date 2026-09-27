import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { ERROR_CODES } from '../../common/errors/codes';
import { PushTokensRepository } from './push-tokens.repository';
import type { RegisterPushTokenDto } from './dto/push-tokens.dto';

/**
 * TZ §14 (push) — MB-1. One driver has more than one device (phone + tablet), so
 * `PushToken` is never a column on `Driver`: it is its own table, upserted by the unique
 * `token`, and deleted per-token, never per-driver.
 */
@Injectable()
export class PushTokensService {
  constructor(private readonly repo: PushTokensRepository) {}

  register(driverId: string, dto: RegisterPushTokenDto) {
    return this.repo.upsert(driverId, dto.token, dto.platform, dto.deviceLabel ?? null);
  }

  async remove(driverId: string, token: string): Promise<{ deleted: true }> {
    const deleted = await this.repo.deleteOwnedByDriver(driverId, token);
    if (!deleted) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Push token not found for this driver.', 404, { token });
    }
    return { deleted: true };
  }
}
