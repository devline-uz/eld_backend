/**
 * Writes the OpenAPI document to `docs/openapi.json` — tasks.md Global gate
 * "All endpoints documented in Swagger, with example responses".
 *
 * Run: `npm run openapi:gen` (needs the dev env, since AppModule validates env and
 * connects Prisma/Redis during NestFactory.create — same cost as booting the API).
 *
 * It fails loudly (exit 1) when an operation is missing a summary, a success example, or
 * its Figma screen link, so the document cannot silently regress. The same invariants are
 * asserted in `test/e2e/openapi-contract.e2e-spec.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AppModule } from '../src/app.module';
import { AppConfigService } from '../src/core/config/config.service';
import { buildOpenApiDocument, configureApp } from '../src/main';
import { auditOpenApiDocument } from '../src/common/swagger/openapi-audit';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  configureApp(app);
  const prefix = app.get(AppConfigService).get('API_PREFIX');
  await app.init();

  const doc: OpenAPIObject = buildOpenApiDocument(app, prefix);
  const outDir = resolve(__dirname, '../docs');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);

  const audit = auditOpenApiDocument(doc);
  console.log(
    `openapi: ${audit.operationCount} operations written to docs/openapi.json ` +
      `(${audit.figmaLinked} with a Figma screen link)`,
  );
  for (const problem of audit.problems) console.error(`openapi: ${problem}`);

  await app.close();
  if (audit.problems.length > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
