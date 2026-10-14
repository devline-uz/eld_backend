import { z } from 'zod';

/**
 * CODE-036 - boolean query flag. `z.coerce.boolean()` turns every non-empty string (incl. "false"
 * and "0") into `true`; this accepts only `true|false|1|0` (or a real boolean) and rejects the rest.
 */
export const QueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');
