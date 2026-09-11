import { z } from 'zod';

export const GeofenceTypeEnum = z.enum(['CIRCLE', 'POLYGON']);

/** TZ §5.10 / eld.docs "Live Fleet" §5 — "Geofences chip draws a terminal/customer area". */
export const CreateGeofenceDto = z
  .object({
    name: z.string().min(1).max(120),
    type: GeofenceTypeEnum.default('CIRCLE'),
    centerLat: z.number().min(-90).max(90).optional(),
    centerLon: z.number().min(-180).max(180).optional(),
    radiusMi: z.number().positive().max(500).optional(),
    polygon: z.array(z.object({ lat: z.number(), lon: z.number() })).min(3).optional(),
    category: z.string().max(60).optional(),
    alertOnEnter: z.boolean().default(false),
    alertOnExit: z.boolean().default(false),
  })
  .refine(
    (v) => (v.type === 'CIRCLE' ? v.centerLat != null && v.centerLon != null && v.radiusMi != null : v.polygon),
    { message: 'CIRCLE requires centerLat/centerLon/radiusMi; POLYGON requires polygon points.' },
  );
export type CreateGeofenceDto = z.infer<typeof CreateGeofenceDto>;

export const UpdateGeofenceDto = z.object({
  name: z.string().min(1).max(120).optional(),
  centerLat: z.number().min(-90).max(90).optional(),
  centerLon: z.number().min(-180).max(180).optional(),
  radiusMi: z.number().positive().max(500).optional(),
  polygon: z.array(z.object({ lat: z.number(), lon: z.number() })).min(3).optional(),
  category: z.string().max(60).optional(),
  alertOnEnter: z.boolean().optional(),
  alertOnExit: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateGeofenceDto = z.infer<typeof UpdateGeofenceDto>;
