import { ArgumentMetadata, Injectable } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe';

/** D-158 — max items in one `{ errors: [...] }` batch. */
export const CLIENT_ERRORS_MAX_BATCH = 10;

/** One client-side (admin web / driver app) error report. Unknown keys are stripped. */
export const ClientErrorItemDto = z.object({
  source: z.enum(['admin', 'mobile']),
  level: z.enum(['error', 'fatal']).default('error'),
  message: z.string().min(1).max(1000),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  route: z.string().max(200).optional(),
  appVersion: z.string().max(40).optional(),
  platform: z.string().max(40).optional(),
  device: z.string().max(80).optional(),
  release: z.string().max(80).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});
export type ClientErrorItemDto = z.infer<typeof ClientErrorItemDto>;

export const ClientErrorBatchDto = z.object({
  errors: z.array(ClientErrorItemDto).min(1).max(CLIENT_ERRORS_MAX_BATCH),
});
export type ClientErrorBatchDto = z.infer<typeof ClientErrorBatchDto>;

/** Body of `POST /client-errors`: one item, or `{ errors: [...] }` (1..10). Documented as `oneOf`. */
export const ClientErrorsDto = z
  .union([ClientErrorBatchDto, ClientErrorItemDto])
  .transform((body): ClientErrorItemDto[] => ('errors' in body ? body.errors : [body]));
export type ClientErrorsDto = z.infer<typeof ClientErrorsDto>;

function isBatchShape(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'errors' in value;
}

/**
 * Validates `ClientErrorsDto` but picks the branch up front (`errors` key present = batch), so a
 * 422 lists field-level issues (`errors.0.source`, `message`) instead of zod's opaque
 * `invalid_union`. Extends `ZodValidationPipe` with the union as its schema, so `applyZodSwagger`
 * still documents the request body as `oneOf [batch, item]`.
 */
@Injectable()
export class ClientErrorsValidationPipe extends ZodValidationPipe<ClientErrorItemDto[]> {
  private readonly batchPipe = new ZodValidationPipe(ClientErrorBatchDto);
  private readonly itemPipe = new ZodValidationPipe(ClientErrorItemDto);

  constructor() {
    super(ClientErrorsDto);
  }

  override transform(value: unknown, metadata: ArgumentMetadata): ClientErrorItemDto[] {
    if (isBatchShape(value)) return this.batchPipe.transform(value, metadata).errors;
    return [this.itemPipe.transform(value, metadata)];
  }
}

/** `202` payload of `POST /client-errors`. */
export class ClientErrorsAcceptedResponse {
  @ApiProperty({ type: Number, example: 1, description: 'Number of error reports accepted (forwarding is asynchronous).' })
  accepted!: number;
}
