import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { CarrierRepository } from '../carrier/carrier.repository';
import { NotificationChannelsDto } from './dto/notifications.dto';

export interface NotificationChannelsShape {
  email: { enabled: boolean };
  webhook: { enabled: boolean; url?: string };
}

const DEFAULTS: NotificationChannelsShape = { email: { enabled: true }, webhook: { enabled: true } };

/**
 * TZ §20 B-87 — "Settings · Alert rules" org-level Email/Webhook switches
 * (`Carrier.notificationChannels`, a JSON column on the singleton row — see D-0xx). Read by
 * `AlertProcessor.isOrgChannelEnabled` before every EMAIL/WEBHOOK delivery; per-rule channel
 * selection (`AlertRule.channels`) is unaffected and evaluated independently.
 */
@Injectable()
export class NotificationChannelsService {
  constructor(private readonly carrier: CarrierRepository) {}

  async get(): Promise<NotificationChannelsShape> {
    const row = (await this.carrier.get()) ?? (await this.carrier.ensure());
    return this.merge((row.notificationChannels as Partial<NotificationChannelsShape> | null) ?? {});
  }

  async update(dto: NotificationChannelsDto): Promise<NotificationChannelsShape> {
    const current = await this.get();
    const next: NotificationChannelsShape = {
      email: { ...current.email, ...dto.email },
      webhook: { ...current.webhook, ...dto.webhook },
    };
    await this.carrier.update({ notificationChannels: next as unknown as Prisma.InputJsonValue });
    return next;
  }

  private merge(stored: Partial<NotificationChannelsShape>): NotificationChannelsShape {
    return {
      email: { ...DEFAULTS.email, ...stored.email },
      webhook: { ...DEFAULTS.webhook, ...stored.webhook },
    };
  }
}
