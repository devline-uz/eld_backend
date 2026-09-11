import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from './codes';

export type ErrorDetails = Record<string, unknown>;

/**
 * The only exception type application code should throw.
 * AllExceptionsFilter renders it into the TZ §20 envelope.
 */
export class AppException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: number = HttpStatus.BAD_REQUEST,
    readonly details?: ErrorDetails,
  ) {
    super({ code, message, details }, status);
  }

  static notFound(message: string, details?: ErrorDetails): AppException {
    return new AppException(ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND, details);
  }

  static forbidden(message: string, details?: ErrorDetails): AppException {
    return new AppException(ERROR_CODES.FORBIDDEN, message, HttpStatus.FORBIDDEN, details);
  }

  static unauthorized(message: string, details?: ErrorDetails): AppException {
    return new AppException(ERROR_CODES.UNAUTHORIZED, message, HttpStatus.UNAUTHORIZED, details);
  }

  static conflict(message: string, details?: ErrorDetails): AppException {
    return new AppException(ERROR_CODES.CONFLICT, message, HttpStatus.CONFLICT, details);
  }

  static unprocessable(code: ErrorCode, message: string, details?: ErrorDetails): AppException {
    return new AppException(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  /** Placeholder used by skeleton code owned by a later phase. */
  static notImplemented(what: string): AppException {
    return new AppException(
      ERROR_CODES.NOT_IMPLEMENTED,
      `${what} is not implemented yet.`,
      HttpStatus.NOT_IMPLEMENTED,
    );
  }
}
