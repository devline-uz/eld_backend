import { BadRequestException, Controller, Get, Header, Param, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { DriverGuard } from '../../common/guards/driver.guard';
import { apiError, ApiStandardErrors } from '../../common/errors';
import { MobileAppConfigService } from './mobile-app-config.service';

/** Upper bound for `GET /mobile/ping?bytes=` (MR-29). */
export const PING_MAX_BYTES = 1024 * 1024;

/** One incompressible payload generated at boot and sliced per request (zero-copy), so a ping
 * costs no CPU-bound `randomBytes` call per request. */
const PING_PAYLOAD = randomBytes(PING_MAX_BYTES);

/** MR-7 / MR-29 / MR-30 — app bootstrap config, speed-test payload and legal links. */
@ApiTags('mobile')
@Controller('mobile')
export class MobileAppConfigController {
  constructor(private readonly svc: MobileAppConfigService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('app-config')
  @ApiOperation({ summary: 'MR-7 — public (no auth) app config: min/latest version, store + legal URLs, PT30 firmware. Unset values are null; `updateRequired` is computed when `appVersion` is sent.' })
  @ApiQuery({ name: 'platform', required: false, enum: ['android', 'ios'] })
  @ApiQuery({ name: 'appVersion', required: false, example: '1.0.3' })
  @ApiOkResponse({
    schema: {
      example: {
        minSupportedVersion: '1.0.0', latestVersion: '1.0.3',
        storeUrl: 'https://play.google.com/store/apps/details?id=com.onebook.eld_mobile',
        userManualUrl: null, privacyPolicyUrl: 'https://onebook.example/privacy', termsUrl: null,
        minPt30Firmware: null, recommendedPt30Firmware: null, updateRequired: false, updateAvailable: true,
      },
    },
  })
  @ApiStandardErrors({ public: true, errors: [apiError.rateLimited('60 requests per minute per IP.')] })
  appConfig(@Query('platform') platform?: string, @Query('appVersion') appVersion?: string) {
    return this.svc.getAppConfig(platform?.toLowerCase(), appVersion);
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('legal/:kind')
  @ApiOperation({ summary: 'MR-30 — privacy policy / terms pointer. `html` is always null (open `url`).' })
  @ApiParam({ name: 'kind', enum: ['privacy', 'terms'] })
  @ApiOkResponse({ schema: { example: { version: '2026-10', url: 'https://onebook.example/privacy', html: null } } })
  @ApiStandardErrors({ public: true, errors: [{ status: 400, code: 'VALIDATION_FAILED', message: 'kind must be privacy or terms.' }, apiError.rateLimited()] })
  legal(@Param('kind') kind: string) {
    if (kind !== 'privacy' && kind !== 'terms') throw new BadRequestException('kind must be privacy or terms.');
    return this.svc.getLegal(kind);
  }

  @ApiBearerAuth()
  @UseGuards(DriverGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('ping')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate')
  @Header('Pragma', 'no-cache')
  @ApiOperation({ summary: `MR-29 — network speed-test payload: \`bytes\` random bytes (default 0, capped at ${PING_MAX_BYTES} = 1 MiB). Driver token, 30 requests/min. Not enveloped.` })
  @ApiQuery({ name: 'bytes', required: false, example: 65536 })
  @ApiOkResponse({
    description: 'application/octet-stream body of the requested size.',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary', example: '<65536 random bytes>' } } },
  })
  @ApiStandardErrors()
  ping(@Query('bytes') bytes: string | undefined, @Res() res: Response) {
    const n = Math.min(Math.max(Number.parseInt(bytes ?? '0', 10) || 0, 0), PING_MAX_BYTES);
    res.status(200).type('application/octet-stream').set('Content-Length', String(n)).send(PING_PAYLOAD.subarray(0, n));
  }
}
