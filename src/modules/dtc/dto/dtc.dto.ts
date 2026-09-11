import { z } from 'zod';

export const DtcListQueryDto = z.object({
  includeCleared: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
});
export type DtcListQueryDto = z.infer<typeof DtcListQueryDto>;
