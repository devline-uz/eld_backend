import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './config.service';
import { assertDatabaseTarget } from './db-guard';
import { parseEnv } from './env.schema';

/**
 * Validates the environment once at bootstrap and runs the non-disableable
 * db-guard (TZ §22.3.4) before any other provider can open a connection.
 */
@Global()
@Module({
  providers: [
    {
      provide: AppConfigService,
      useFactory: (): AppConfigService => {
        const env = parseEnv();
        assertDatabaseTarget(env);
        return new AppConfigService(env);
      },
    },
  ],
  exports: [AppConfigService],
})
export class AppConfigModule {}
