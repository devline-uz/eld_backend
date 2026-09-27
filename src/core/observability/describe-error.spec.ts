import { describeError, toDescriptiveError } from './describe-error';

function econnrefused(): AggregateError {
  const a = Object.assign(new Error('connect ECONNREFUSED ::1:9000'), { code: 'ECONNREFUSED' });
  const b = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9000'), { code: 'ECONNREFUSED' });
  return Object.assign(new AggregateError([a, b], ''), { code: 'ECONNREFUSED' });
}

describe('describeError', () => {
  it('describes an AggregateError with an empty message via code + nested errors', () => {
    expect(describeError(econnrefused())).toBe(
      'AggregateError [ECONNREFUSED] (connect ECONNREFUSED ::1:9000; connect ECONNREFUSED 127.0.0.1:9000)',
    );
  });

  it('handles non-Error values and causes', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError({ foo: 1 })).toBe('{"foo":1}');
    expect(describeError(new Error('outer', { cause: new Error('inner') }))).toBe('outer caused by: inner');
  });
});

describe('toDescriptiveError', () => {
  it('returns an Error with a message unchanged', () => {
    const e = new Error('x');
    expect(toDescriptiveError(e)).toBe(e);
  });

  it('wraps an empty-message error, keeping cause and original stack', () => {
    const original = econnrefused();
    const wrapped = toDescriptiveError(original);
    expect(wrapped.message).toContain('ECONNREFUSED 127.0.0.1:9000');
    expect(wrapped.cause).toBe(original);
    expect(wrapped.stack).toContain('Caused by: AggregateError');
  });
});
