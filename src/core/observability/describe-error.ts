/**
 * Turns any thrown value into a non-empty, human-readable message.
 *
 * Why: Node's network errors are often an `AggregateError` with an EMPTY `message` (e.g. a
 * `localhost` connect that tries ::1 and 127.0.0.1 and both are refused). BullMQ stores
 * `err.message` as the job's `failedReason`, so such a failure showed up as
 * `worker.job_failed { failedReason: "" }` and hid the real cause. This helper walks
 * `code`, nested `errors[]` and `cause` so the message always says what actually happened.
 */
export function describeError(err: unknown, depth = 0): string {
  if (depth > 4) return '';
  if (err === null || err === undefined) return String(err);
  if (typeof err !== 'object') return String(err);

  const e = err as { name?: unknown; message?: unknown; code?: unknown; errors?: unknown; cause?: unknown };
  const parts: string[] = [];
  const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
  const message = typeof e.message === 'string' ? e.message.trim() : '';
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';

  if (message) parts.push(message);
  else parts.push(code ? `${name} [${code}]` : name);

  if (Array.isArray(e.errors) && e.errors.length > 0) {
    const nested = [...new Set(e.errors.map((x) => describeError(x, depth + 1)).filter(Boolean))];
    if (nested.length) parts.push(`(${nested.join('; ')})`);
  }
  if (e.cause !== undefined && e.cause !== err) {
    const cause = describeError(e.cause, depth + 1);
    if (cause) parts.push(`caused by: ${cause}`);
  }
  if (!message && !code && parts.length === 1 && !(err instanceof Error)) {
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}') return json;
    } catch {
      /* fall through */
    }
  }
  return parts.join(' ');
}

/**
 * Returns an `Error` whose `message` is guaranteed non-empty. If `err` already is an Error
 * with a message it is returned unchanged; otherwise a wrapping Error is returned that keeps
 * the original as `cause` and its stack appended, so BullMQ's `failedReason`/`stacktrace`
 * carry the real reason.
 */
export function toDescriptiveError(err: unknown): Error {
  if (err instanceof Error && err.message.trim()) return err;
  const wrapped = new Error(describeError(err), { cause: err });
  if (err instanceof Error && err.stack) {
    wrapped.stack = `${wrapped.stack ?? `Error: ${wrapped.message}`}\nCaused by: ${err.stack}`;
  }
  return wrapped;
}
