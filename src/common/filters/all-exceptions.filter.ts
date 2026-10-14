import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { RequestContext } from '../../core/context/request-context';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import { ErrorEnvelope } from './error-envelope';

/** Renders every failure as the TZ §20 envelope, with the request's traceId. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const envelope = this.toEnvelope(exception);

    if (envelope.statusCode >= 500) {
      this.logger.error(
        { err: exception, traceId: envelope.traceId, path: req.url },
        envelope.message,
      );
    } else {
      this.logger.warn(
        { code: envelope.code, traceId: envelope.traceId, path: req.url },
        envelope.message,
      );
    }

    res.status(envelope.statusCode).json(envelope);
  }

  private toEnvelope(exception: unknown): ErrorEnvelope {
    const traceId = RequestContext.traceId ?? randomUUID();
    const timestamp = new Date().toISOString();

    if (exception instanceof AppException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        traceId,
        timestamp,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const parsed = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
      return {
        statusCode: status,
        code: typeof parsed.code === 'string' ? parsed.code : defaultCodeFor(status),
        message: extractMessage(parsed, exception.message),
        details: typeof parsed.details === 'object' && parsed.details !== null
          ? (parsed.details as Record<string, unknown>)
          : undefined,
        traceId,
        timestamp,
      };
    }

    // CODE-014 — a constraint error that no service translated is a client-state problem
    // (duplicate, still referenced, already gone), not a server fault: never a bare 500.
    const prismaMapped = mapPrismaError(exception);
    if (prismaMapped) return { ...prismaMapped, traceId, timestamp };

    // body-parser rejects an oversized body before Nest sees it and throws a plain
    // `PayloadTooLargeError` (not an HttpException). Ingest batches are capped at 1 MB
    // (TZ §7.3 rule 2), so this must answer 413, not 500.
    if (isPayloadTooLarge(exception)) {
      return {
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        code: ERROR_CODES.PAYLOAD_TOO_LARGE,
        message: 'Request body is too large.',
        traceId,
        timestamp,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Internal server error.',
      traceId,
      timestamp,
    };
  }
}

function extractMessage(body: Record<string, unknown>, fallback: string): string {
  const raw = body.message;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(String).join('; ');
  return fallback;
}

const STATUS_CODE_MAP: Record<number, string> = {
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.CONFLICT,
  [HttpStatus.PAYLOAD_TOO_LARGE]: ERROR_CODES.PAYLOAD_TOO_LARGE,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMITED,
  [HttpStatus.NOT_IMPLEMENTED]: ERROR_CODES.NOT_IMPLEMENTED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ERROR_CODES.SERVICE_UNAVAILABLE,
};

function defaultCodeFor(status: number): string {
  return (
    STATUS_CODE_MAP[status] ??
    (status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.VALIDATION_FAILED)
  );
}

/** body-parser's `entity.too.large` (or any error carrying a 413 status). */
function isPayloadTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const err = exception as { type?: string; status?: number; statusCode?: number };
  return err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413;
}

/** CODE-014 — Prisma known-request errors that mean "conflict with stored data", mapped once here. */
export function mapPrismaError(
  exception: unknown,
): Pick<ErrorEnvelope, 'statusCode' | 'code' | 'message' | 'details'> | null {
  if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (exception.code) {
    case 'P2002': {
      const target = exception.meta?.target;
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ERROR_CODES.CONFLICT,
        message: 'A record with the same unique value already exists.',
        details: target !== undefined ? { target } : undefined,
      };
    }
    case 'P2003':
      return {
        statusCode: HttpStatus.CONFLICT,
        code: ERROR_CODES.CONFLICT,
        message: 'This record is still referenced by other records and cannot be changed or deleted.',
      };
    case 'P2025':
      return { statusCode: HttpStatus.NOT_FOUND, code: ERROR_CODES.NOT_FOUND, message: 'Record not found.' };
    default:
      return null;
  }
}
