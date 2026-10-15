import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import type { ErrorEnvelope } from './error-envelope';

function makeHost(url = '/api/vehicles') {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), setHeader: jest.fn() };
  const req = { url };
  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => res,
        getRequest: () => req,
      }),
    },
    res,
  };
}

function envelopeOf(res: { json: jest.Mock }): ErrorEnvelope {
  return (res.json.mock.calls[0] as [ErrorEnvelope])[0];
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it('renders an AppException as the TZ §20 envelope, warn-logged (< 500)', () => {
    const { host, res } = makeHost();
    const err = new AppException(ERROR_CODES.VEHICLE_NOT_FOUND, 'Vehicle not found.', 404, {
      id: 'veh_1',
    });

    filter.catch(err, host as never);

    expect(res.status).toHaveBeenCalledWith(404);
    const body = envelopeOf(res);
    expect(body.code).toBe(err.code);
    expect(body.message).toBe('Vehicle not found.');
    expect(body.details).toEqual({ id: 'veh_1' });
    expect(typeof body.traceId).toBe('string');
    expect(typeof body.timestamp).toBe('string');
  });

  it('error-logs (>= 500) an AppException-shaped 500', () => {
    const { host, res } = makeHost();
    const err = new AppException(ERROR_CODES.INTERNAL_ERROR, 'boom', 500);
    filter.catch(err, host as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('renders a generic HttpException using its own code/message when present', () => {
    const { host, res } = makeHost();
    const err = new ForbiddenException({ code: 'CUSTOM_FORBIDDEN', message: 'nope', details: { x: 1 } });

    filter.catch(err, host as never);

    const body = envelopeOf(res);
    expect(body.statusCode).toBe(403);
    expect(body.code).toBe('CUSTOM_FORBIDDEN');
    expect(body.message).toBe('nope');
    expect(body.details).toEqual({ x: 1 });
  });

  it('falls back to a status-derived default code when the HttpException body has none', () => {
    const { host, res } = makeHost();
    const err = new ForbiddenException();
    filter.catch(err, host as never);
    const body = envelopeOf(res);
    expect(body.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('joins an array of validation messages from Nest ValidationPipe-shaped bodies', () => {
    const { host, res } = makeHost();
    const err = new BadRequestException({ message: ['field a is required', 'field b is required'] });
    filter.catch(err, host as never);
    const body = envelopeOf(res);
    expect(body.message).toBe('field a is required; field b is required');
  });

  it('uses exception.message as a fallback when the body has no message field', () => {
    const { host, res } = makeHost();
    const err = new BadRequestException('plain string body is coerced by Nest, so use a class instance');
    filter.catch(err, host as never);
    const body = envelopeOf(res);
    expect(typeof body.message).toBe('string');
  });

  it('maps an unrecognized 5xx HttpException status to INTERNAL_ERROR', () => {
    const { host, res } = makeHost();
    class WeirdException extends BadRequestException {
      override getStatus(): number {
        return 599;
      }
    }
    const err = new WeirdException();
    filter.catch(err, host as never);
    const body = envelopeOf(res);
    expect(body.code).toBe(ERROR_CODES.INTERNAL_ERROR);
  });

  it('answers 413 PAYLOAD_TOO_LARGE for a body-parser entity.too.large error', () => {
    const { host, res } = makeHost();
    const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large' });
    filter.catch(err, host as never);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    const body = envelopeOf(res);
    expect(body.code).toBe(ERROR_CODES.PAYLOAD_TOO_LARGE);
  });

  it('also recognizes a plain 413 status/statusCode without the entity.too.large type', () => {
    const { host, res } = makeHost();
    filter.catch(Object.assign(new Error('x'), { status: 413 }), host as never);
    expect(res.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);

    const { host: host2, res: res2 } = makeHost();
    filter.catch(Object.assign(new Error('x'), { statusCode: 413 }), host2 as never);
    expect(res2.status).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
  });

  it('renders any other unknown throwable as a generic 500 INTERNAL_ERROR', () => {
    const { host, res } = makeHost();
    filter.catch('a bare string throw', host as never);
    expect(res.status).toHaveBeenCalledWith(500);
    const body = envelopeOf(res);
    expect(body.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(body.message).toBe('Internal server error.');
  });

  it('renders null/non-object exceptions without throwing', () => {
    const { host, res } = makeHost();
    filter.catch(null, host as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  describe('CODE-014 — Prisma constraint errors', () => {
    const known = (code: string, meta?: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError('db says no', { code, clientVersion: 'test', meta });

    it.each([
      ['P2002', 409, ERROR_CODES.CONFLICT],
      ['P2003', 409, ERROR_CODES.CONFLICT],
      ['P2025', 404, ERROR_CODES.NOT_FOUND],
    ])('%s -> %i %s (never a bare 500)', (code, status, errorCode) => {
      const { host, res } = makeHost('/api/users/u1');
      filter.catch(known(code, code === 'P2002' ? { target: ['email'] } : undefined), host as never);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(envelopeOf(res)).toMatchObject({ statusCode: status, code: errorCode });
      if (code === 'P2002') expect(envelopeOf(res).details).toEqual({ target: ['email'] });
      // The raw driver message (table/constraint names) is not echoed to the client.
      expect(envelopeOf(res).message).not.toContain('db says no');
    });

    it('an unmapped Prisma code is still a 500', () => {
      const { host, res } = makeHost();
      filter.catch(known('P2010'), host as never);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('D-164 — Retry-After on transient failures', () => {
    it('503 INGEST_ASSIGNMENT_PENDING sets Retry-After from details.retryAfterSec', () => {
      const { host, res } = makeHost('/api/ingest/events');
      filter.catch(new AppException(ERROR_CODES.INGEST_ASSIGNMENT_PENDING, 'pending', 503, { retryAfterSec: 30 }), host as never);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    });

    it('429 RATE_LIMITED sets Retry-After (rounded up, at least 1)', () => {
      const { host, res } = makeHost('/api/ingest/events');
      filter.catch(new AppException(ERROR_CODES.RATE_LIMITED, 'slow down', 429, { retryAfterSec: 0 }), host as never);
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1');
    });

    it('pool timeout / transaction wait (P2024, P2028, P2034, P2037 too many connections) -> 503 SERVICE_UNAVAILABLE + Retry-After, not 500', () => {
      for (const code of ['P2024', 'P2028', 'P2034', 'P2037']) {
        const { host, res } = makeHost('/api/ingest/events');
        filter.catch(new Prisma.PrismaClientKnownRequestError('busy', { code, clientVersion: 'test' }), host as never);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(envelopeOf(res).code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
        expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '5');
      }
    });

    it('4xx refusals carry no Retry-After', () => {
      const { host, res } = makeHost('/api/ingest/events');
      filter.catch(AppException.forbidden('nope'), host as never);
      expect(res.setHeader).not.toHaveBeenCalled();
    });
  });
});
