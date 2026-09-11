import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma/prisma.service';

/**
 * TZ §3.5 — even a one-line `SELECT 1` goes through a repository; nothing outside a
 * *.repository.ts touches prisma. (Not a BaseRepository subclass: it has no model.)
 */
@Injectable()
export class HealthRepository {
  constructor(private readonly prisma: PrismaService) {}

  async pingDatabase(): Promise<boolean> {
    return this.prisma.ping();
  }
}
