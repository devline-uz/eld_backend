import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppException } from '../errors/app.exception';
import { ERROR_CODES } from '../errors/codes';
import type { ErrorEnvelope } from './error-envelope';

function makeHost(url = '/api/vehicles') {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
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
      getStatus(): number {
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
});
