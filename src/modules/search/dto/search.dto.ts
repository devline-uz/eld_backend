import { z } from 'zod';

/** §20 B-10 `GET /search?q=&limit=`. */
export const SearchQueryDto = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(25).default(5),
});
export type SearchQueryDto = z.infer<typeof SearchQueryDto>;
