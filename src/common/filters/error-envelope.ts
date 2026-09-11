import { ErrorCode } from '../errors/codes';

/** The TZ §20 error envelope. Shape is contract — clients parse it. */
export interface ErrorEnvelope {
  statusCode: number;
  /** A code from ERROR_CODES; typed loosely so upstream HttpExceptions still fit. */
  code: ErrorCode | (string & {});
  message: string;
  details?: Record<string, unknown>;
  traceId: string;
  timestamp: string;
}
