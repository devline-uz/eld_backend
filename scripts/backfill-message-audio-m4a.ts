/**
 * One-off: convert legacy web voice clips (Attachment.kind = MESSAGE_AUDIO, audio/webm|ogg) to
 * AAC/M4A so the driver app can play them.
 *
 *   npx ts-node scripts/backfill-message-audio-m4a.ts            # dry-run (default): lists candidates
 *   npx ts-node scripts/backfill-message-audio-m4a.ts --apply    # writes new .m4a, updates the row, deletes the old object
 *
 * Per row: download -> ffmpeg -> put `<old key without ext>.m4a` -> UPDATE key/mimeType/sizeBytes/sha256
 * (the old object is deleted only after the row points at the new one). A failing row is skipped and
 * reported; others continue. DATABASE_URL: exported value wins, else `.env.development`. Refuses prod.
 */
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../src/core/config/config.service';
import { assertDatabaseTarget, PROD_DB_NAME } from '../src/core/config/db-guard';
import { parseEnv } from '../src/core/config/env.schema';
import { S3StorageService } from '../src/core/storage/s3-storage.service';
import { transcodeToM4a } from '../src/modules/messaging/audio-transcode';

async function main(): Promise<void> {
  const envFile = join(__dirname, '..', '.env.development');
  if (!process.env.DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);
  const apply = process.argv.includes('--apply');

  const env = parseEnv();
  const config = new AppConfigService(env);
  if (config.isProduction) throw new Error('refusing to run with NODE_ENV=production.');
  if (new URL(env.DATABASE_URL).pathname.slice(1) === PROD_DB_NAME) throw new Error('DATABASE_URL points at the prod database.');
  assertDatabaseTarget(env);

  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
  const storage = new S3StorageService(config as never);
  try {
    const rows = await prisma.attachment.findMany({
      where: { kind: 'MESSAGE_AUDIO', mimeType: { in: ['audio/webm', 'audio/ogg'] } },
      select: { id: true, key: true, mimeType: true, sizeBytes: true },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`${apply ? '[apply]' : '[dry-run]'} ${rows.length} MESSAGE_AUDIO row(s) with webm/ogg audio`);
    let done = 0;
    let failed = 0;
    for (const r of rows) {
      const ext = r.key.split('.').pop() ?? 'webm';
      const newKey = r.key.replace(/\.[^./]+$/, '') + '.m4a';
      console.log(`- ${r.id} ${r.mimeType} ${r.sizeBytes}B ${r.key} -> ${newKey}`);
      if (!apply) continue;
      try {
        const out = await transcodeToM4a(await storage.get(r.key), ext);
        await storage.put(newKey, out.buffer, { contentType: out.contentType, contentLength: out.buffer.length });
        await prisma.attachment.update({
          where: { id: r.id },
          data: { key: newKey, mimeType: out.contentType, sizeBytes: out.buffer.length, sha256: createHash('sha256').update(out.buffer).digest('hex') },
        });
        await storage.delete(r.key).catch((e) => console.warn(`  old object not deleted: ${(e as Error).message}`));
        done++;
      } catch (e) {
        failed++;
        console.error(`  FAILED ${r.id}: ${(e as Error).message}`);
      }
    }
    if (apply) console.log(`converted ${done}, failed ${failed}`);
    else console.log('dry-run only; re-run with --apply to convert.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`backfill-message-audio-m4a: ${(e as Error).message}`);
  process.exit(1);
});
