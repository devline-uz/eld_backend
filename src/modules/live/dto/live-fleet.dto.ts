import { z } from 'zod';

/**
 * `GET /live/fleet?view=` — `full` (default, unchanged 22-field rows) or `list`: the slim rows the
 * web's Live Fleet list/map, Vehicles and Messages read (`LiveFleetListUnit`). The default stays
 * full so every other caller (`scripts/sim-drivers.ts`, the contract suite) is untouched.
 */
export const LiveFleetQueryDto = z.object({
  view: z.enum(['full', 'list']).default('full'),
});
export type LiveFleetQueryDto = z.infer<typeof LiveFleetQueryDto>;
