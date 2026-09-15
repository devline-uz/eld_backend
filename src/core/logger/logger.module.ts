import { Global, Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { AppConfigModule } from '../config/config.module';
import { AppConfigService } from '../config/config.service';
import { RequestContext } from '../context/request-context';

/**
 * TZ §22.5 — pino, JSON output, traceId on every line.
 * The traceId is read from the AsyncLocalStorage RequestContext so worker logs and
 * request logs correlate through the same field.
 */
@Global()
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL'),
          transport: config.get('LOG_PRETTY') ? { target: 'pino-pretty' } : undefined,
          autoLogging: true,
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.body.password',
              'req.body.token',
              'req.body.refreshToken',
            ],
            censor: '[redacted]',
          },
          mixin(): Record<string, unknown> {
            const ctx = RequestContext.get();
            if (!ctx) return {};
            return {
              traceId: ctx.traceId,
              requestId: ctx.requestId,
              userId: ctx.user?.id,
              carrierId: ctx.carrierId,
            };
          },
          customProps: (): Record<string, unknown> => ({ service: 'onebook-eld' }),
        },
      }),
    }),
  ],
  exports: [PinoLoggerModule],
})
export class AppLoggerModule {}
