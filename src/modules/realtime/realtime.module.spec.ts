import { Test } from '@nestjs/testing';
import { TokenVerifier } from '../../common/guards/token-verifier.port';
import { AppConfigService } from '../../core/config/config.service';
import { parseEnv } from '../../core/config/env.schema';
import { AppConfigModule } from '../../core/config/config.module';
import { PrismaModule } from '../../core/prisma/prisma.module';
import { PrismaService } from '../../core/prisma/prisma.service';
import { EventsModule } from '../../core/events/events.module';
import { FirebaseModule } from '../../core/firebase/firebase.module';
import { TokenService } from '../auth/token.service';
import { RealtimeModule } from './realtime.module';
import { CommonModule } from '../../common/common.module';
import { StorageModule } from '../../core/storage/storage.module';
import { S3StorageService } from '../../core/storage/s3-storage.service';

/**
 * B-0NN regression guard (WB-011 on the web side): `RealtimeGateway` injects `TokenVerifier`
 * and must resolve the same real binding `JwtAuthGuard` uses (`TokenService`, via AuthModule),
 * never `CommonModule`'s `NotImplementedTokenVerifier` stub — which unconditionally rejects
 * every handshake. This compiles `RealtimeModule` in isolation, the way Nest's real module
 * graph does, and asserts the resolved instance actually verifies a token instead of throwing
 * NOT_IMPLEMENTED.
 */
describe('RealtimeModule wiring', () => {
  it('resolves TokenVerifier to the real TokenService binding, not the NotImplemented stub', async () => {
    const env = parseEnv({
      ...process.env,
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'unit-test-secret-at-least-32-characters-long',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        EventsModule,
        FirebaseModule,
        CommonModule,
        StorageModule,
        RealtimeModule,
      ],
    })
      .overrideProvider(AppConfigService)
      .useValue(new AppConfigService(env))
      .overrideProvider(PrismaService)
      .useValue({ $connect: jest.fn(), $disconnect: jest.fn() })
      .overrideProvider(S3StorageService)
      .useValue({})
      .compile();

    const verifier = moduleRef.get(TokenVerifier);

    // The bug: CommonModule is never imported here, so if RealtimeModule (or something it
    // imports) doesn't bind TokenVerifier itself, Nest would throw "Nest can't resolve
    // dependency" — that alone would fail this compile(). This assertion catches the more
    // subtle regression where a *different* NotImplementedTokenVerifier sneaks back in.
    expect(verifier).toBeInstanceOf(TokenService);
    await expect(verifier.verifyAccessToken('not-a-real-token')).rejects.not.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});
