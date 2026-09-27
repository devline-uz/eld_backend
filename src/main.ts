import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AppConfigService } from './core/config/config.service';
import { applyZodSwagger, attachZodComponents } from './common/swagger/zod-swagger';

/**
 * Shared app wiring (prefix, pipes, CORS, helmet) between the real entrypoint and e2e
 * tests (`test/e2e/*.e2e-spec.ts` call this on a `Test.createTestingModule` instance so
 * routes resolve at the same `/api/v1/...` paths the real server uses).
 */
export function configureApp(app: INestApplication): AppConfigService {
  const config = app.get(AppConfigService);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  // TZ §7.3 rule 2 — an ingest batch may be up to 1 MB (500 §395 events). Express's default
  // JSON limit is 100 KB, which rejected legitimate batches with a body-parser error before
  // validation could ever see them.
  app.use(json({ limit: '1mb' }));
  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    exposedHeaders: ['x-trace-id', 'x-request-id'],
  });
  app.setGlobalPrefix(config.get('API_PREFIX'), {
    exclude: ['health/live', 'health/ready', 'health/deep', 'metrics'],
  });
  // DTO validation is zod + ZodValidationPipe (TZ §6.5). This global pipe only handles
  // primitive route/query params (`:id` → number etc.).
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  return config;
}

/**
 * API entrypoint (TZ §3.3). No heavy work here — that belongs to worker.ts.
 * Environment validation and the db-guard (TZ §22.3.4) run inside AppModule during
 * NestFactory.create, before this function gets a chance to listen.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const config = configureApp(app);

  if (config.get('SWAGGER_ENABLED')) setupSwagger(app, config.get('API_PREFIX'));

  // Graceful shutdown: SIGTERM drains in-flight requests before the process exits.
  app.enableShutdownHooks();

  const port = config.get('PORT');
  await app.listen(port, '0.0.0.0');
  app.get(Logger).log(`API listening on :${port} (${config.get('NODE_ENV')})`);
}

/**
 * Builds the OpenAPI document. Exported so `scripts/generate-openapi.ts` and
 * `test/e2e/openapi-contract.e2e-spec.ts` assert on exactly the document this process
 * serves at `/docs` (tasks.md Global gate: every endpoint documented with examples).
 */
export function buildOpenApiDocument(app: INestApplication, prefix: string): OpenAPIObject {
  // Phase 13B — zod DTOs → requestBody / query params / components.schemas.
  applyZodSwagger(app);
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('OneBook ELD API')
      .setDescription('FMCSA 49 CFR §395 compliant ELD backend')
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addServer(`/${prefix}`)
      .build(),
  );
  return attachZodComponents(doc);
}

function setupSwagger(app: INestApplication, prefix: string): void {
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app, prefix), {
    swaggerOptions: { persistAuthorization: true },
  });
}

// Guarded so `test/e2e/*.e2e-spec.ts` can `import { configureApp } from '../../src/main'`
// without also starting a real listening server / duplicate DB pool as an import side effect.
if (require.main === module) {
  void bootstrap();
}
