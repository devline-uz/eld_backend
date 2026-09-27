import { Injectable } from '@nestjs/common';
import type { Driver } from '@prisma/client';
import { PrismaService } from '../../../core/prisma/prisma.service';

@Injectable()
export class DriverAuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByUsername(username: string): Promise<Driver | null> {
    return this.prisma.driver.findFirst({ where: { username, deletedAt: null } });
  }

  findById(id: string): Promise<Driver | null> {
    return this.prisma.driver.findUnique({ where: { id } });
  }

  touchLastSync(id: string): Promise<Driver> {
    return this.prisma.driver.update({ where: { id }, data: { lastSyncAt: new Date() } });
  }

  updatePasswordHash(id: string, passwordHash: string): Promise<Driver> {
    return this.prisma.driver.update({ where: { id }, data: { passwordHash } });
  }
}
