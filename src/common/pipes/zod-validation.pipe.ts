import { ArgumentMetadata, HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { ZodError, ZodType, ZodTypeDef } from 'zod';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';

/**
 * TZ §6.5 — every DTO is a zod schema validated through this pipe.
 * Failures surface as 422 VALIDATION_FAILED inside the §20 envelope.
 */
@Injectable()
export class ZodValidationPipe<TOut = unknown> implements PipeTransform<unknown, TOut> {
  // Input side is `unknown`, not `TOut`: DTOs that `.transform()` (ingest parses ISO
  // strings into `Date`) have a different input than output type (TZ §7.2 payloads).
  constructor(private readonly schema: ZodType<TOut, ZodTypeDef, unknown>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): TOut {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new AppException(
          ERROR_CODES.VALIDATION_FAILED,
          'Request validation failed.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          {
            issues: err.issues.map((i) => ({
              path: i.path.join('.'),
              code: i.code,
              message: i.message,
            })),
          },
        );
      }
      throw err;
    }
  }
}

/** Convenience factory: `@Body(zodBody(CreateDriverDto))`. */
export const zodBody = <T>(schema: ZodType<T, ZodTypeDef, unknown>): ZodValidationPipe<T> =>
  new ZodValidationPipe(schema);
