import { Global, Module } from '@nestjs/common';
import { S3StorageService } from './s3-storage.service';
import { STORAGE_PORT } from './storage.port';

@Global()
@Module({
  providers: [S3StorageService, { provide: STORAGE_PORT, useExisting: S3StorageService }],
  exports: [S3StorageService, STORAGE_PORT],
})
export class StorageModule {}
