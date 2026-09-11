import { HttpStatus } from '@nestjs/common';
import { AppException } from './app.exception';
import { ERROR_CODES } from './codes';

describe('AppException', () => {
  it('defaults to 400 BAD_REQUEST when no status is given', () => {
    const err = new AppException(ERROR_CODES.VALIDATION_FAILED, 'bad input');
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(err.message).toBe('bad input');
  });

  it('carries optional details through to the response body', () => {
    const err = new AppException(ERROR_CODES.VALIDATION_FAILED, 'bad input', 422, { field: 'email' });
    expect(err.details).toEqual({ field: 'email' });
    expect(err.getResponse()).toMatchObject({ code: ERROR_CODES.VALIDATION_FAILED, details: { field: 'email' } });
  });

  it('notFound() builds a 404 with NOT_FOUND', () => {
    const err = AppException.notFound('missing');
    expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(err.code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it('forbidden() builds a 403 with FORBIDDEN', () => {
    const err = AppException.forbidden('nope');
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe(ERROR_CODES.FORBIDDEN);
  });

  it('unauthorized() builds a 401 with UNAUTHORIZED', () => {
    const err = AppException.unauthorized('nope');
    expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    expect(err.code).toBe(ERROR_CODES.UNAUTHORIZED);
  });

  it('conflict() builds a 409 with CONFLICT', () => {
    const err = AppException.conflict('dup');
    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.code).toBe(ERROR_CODES.CONFLICT);
  });

  it('unprocessable() builds a 422 with the given code', () => {
    const err = AppException.unprocessable(ERROR_CODES.TRANSFER_VALIDATION_FAILED, 'bad transfer');
    expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(err.code).toBe(ERROR_CODES.TRANSFER_VALIDATION_FAILED);
  });

  it('notImplemented() builds a 501 with NOT_IMPLEMENTED', () => {
    const err = AppException.notImplemented('Feature X');
    expect(err.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
    expect(err.code).toBe(ERROR_CODES.NOT_IMPLEMENTED);
    expect(err.message).toBe('Feature X is not implemented yet.');
  });
});
