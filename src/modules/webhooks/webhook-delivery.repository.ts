import { Injectable } from '@nestjs/common';
import type { DeliveryStatus, Prisma, WebhookDelivery } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';

export interface CreateWebhookDeliveryInput {
  integrationId?: string | null;
  url: string;
  eventType: string;
  payload: Prisma.InputJsonValue;
}

@Injectable()
export class WebhookDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateWebhookDeliveryInput): Promise<WebhookDelivery> {
    return this.prisma.webhookDelivery.create({ data: { ...input, signature: '' } });
  }

  findById(id: string): Promise<WebhookDelivery | null> {
    return this.prisma.webhookDelivery.findUnique({ where: { id } });
  }

  recordAttempt(
    id: string,
    data: {
      status: DeliveryStatus;
      attempts: number;
      signature: string;
      httpStatus?: number | null;
      responseBody?: string | null;
      nextRetryAt?: Date | null;
    },
  ): Promise<WebhookDelivery> {
    return this.prisma.webhookDelivery.update({ where: { id }, data });
  }
}
