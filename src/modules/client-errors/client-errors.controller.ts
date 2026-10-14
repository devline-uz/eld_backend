import { Body, Controller, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { apiError, ApiStandardErrors, ERROR_CODES } from '../../common/errors';
import { envelopeSchema } from '../../common/swagger/api-envelope';
import { ClientErrorsService } from './client-errors.service';
import { ClientErrorsAcceptedResponse, ClientErrorsValidationPipe, type ClientErrorItemDto } from './dto/client-errors.dto';

/** D-158 — client-side error intake (admin web panel + driver app). Thin: all logic in the service. */
@ApiTags('client-errors')
@Controller('client-errors')
export class ClientErrorsController {
  constructor(private readonly clientErrors: ClientErrorsService) {}

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiExtraModels(ClientErrorsAcceptedResponse)
  @ApiOperation({
    summary: 'Report client-side errors from the admin panel or the driver app (D-158).',
    description:
      'Public — works before login. A valid Bearer access token, if sent, tags the report with `user:<id>` / `driver:<id>`; an invalid or expired token is ignored (never 401). Body: one item or `{ errors: [...] }` (1..10), max 32 KB. Bearer tokens, JWTs, password/token values and email addresses are scrubbed, then the reports are forwarded asynchronously to the ops error channel. Always 202 once validated; delivery is best-effort.',
  })
  @ApiResponse({
    status: 202,
    description: 'Accepted for asynchronous forwarding.',
    schema: envelopeSchema([ClientErrorsAcceptedResponse], { example: { accepted: 1 } }),
  })
  @ApiStandardErrors({
    public: true,
    errors: [
      apiError.validation('Request validation failed.'),
      { status: 413, code: ERROR_CODES.PAYLOAD_TOO_LARGE, message: 'Request body is too large.', description: 'PAYLOAD_TOO_LARGE — body over 32 KB.' },
      apiError.rateLimited('Client error reports are limited to 30 requests per minute per IP.'),
    ],
  })
  report(
    @Body(new ClientErrorsValidationPipe()) items: ClientErrorItemDto[],
    @Headers('authorization') authorization?: string,
  ) {
    return this.clientErrors.report(items, authorization);
  }
}
