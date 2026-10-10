import { z } from 'zod';

export const GeofenceTypeEnum = z.enum(['CIRCLE', 'POLYGON', 'ADDRESS']);
/** Map colour from the web "Create a geofence" modal (overlay 11.1) — Prisma `GeofenceColour`. */
export const GeofenceColourEnum = z.enum(['BLUE', 'GREEN', 'AMBER', 'RED', 'VIOLET']);

/** §20 B-93 — the web form's `radiusMeters` field actually carries miles (WD naming bug, not
 * ours to fix here); accepted as an alias of `radiusMi` on both create and update so the real
 * wire payload the panel sends is not silently dropped (decisions.md). */
const radiusFields = {
  radiusMi: z.number().positive().max(500).optional(),
  radiusMeters: z.number().positive().max(500).optional(),
};

/** TZ §5.10 / eld.docs "Live Fleet" §5 — "Geofences chip draws a terminal/customer area". */
export const CreateGeofenceDto = z
  .object({
    name: z.string().min(1).max(120),
    type: GeofenceTypeEnum.default('CIRCLE'),
    centerLat: z.number().min(-90).max(90).optional(),
    centerLon: z.number().min(-180).max(180).optional(),
    ...radiusFields,
    polygon: z.array(z.object({ lat: z.number(), lon: z.number() })).min(3).optional(),
    /** §20 B-93 — required for `type: 'ADDRESS'`; server geocodes into center/radius. */
    address: z.string().min(1).max(300).optional(),
    category: z.string().max(60).optional(),
    alertOnEnter: z.boolean().default(false),
    alertOnExit: z.boolean().default(false),
    /** §20 B-15. */
    dwellMinutes: z.number().int().positive().max(1440).optional(),
    afterHoursOnly: z.boolean().default(false),
    colour: GeofenceColourEnum.default('BLUE'),
    /** Time a unit spends inside counts as on-duty yard move (overlay 11.1 footer checkbox). */
    countAsYardMove: z.boolean().default(false),
    /** §20 B-104 — "Applies to" vehicle group (overlay 11.1). null/absent = all groups. */
    vehicleGroupId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (v) => {
      if (v.type === 'CIRCLE') return v.centerLat != null && v.centerLon != null && (v.radiusMi != null || v.radiusMeters != null);
      if (v.type === 'ADDRESS') return Boolean(v.address) && (v.radiusMi != null || v.radiusMeters != null);
      return Boolean(v.polygon);
    },
    { message: 'CIRCLE requires centerLat/centerLon/radiusMi; POLYGON requires polygon points; ADDRESS requires address + radiusMi.' },
  );
export type CreateGeofenceDto = z.infer<typeof CreateGeofenceDto>;

export const UpdateGeofenceDto = z.object({
  name: z.string().min(1).max(120).optional(),
  centerLat: z.number().min(-90).max(90).optional(),
  centerLon: z.number().min(-180).max(180).optional(),
  ...radiusFields,
  polygon: z.array(z.object({ lat: z.number(), lon: z.number() })).min(3).optional(),
  address: z.string().min(1).max(300).optional(),
  category: z.string().max(60).optional(),
  alertOnEnter: z.boolean().optional(),
  alertOnExit: z.boolean().optional(),
  dwellMinutes: z.number().int().positive().max(1440).nullable().optional(),
  afterHoursOnly: z.boolean().optional(),
  colour: GeofenceColourEnum.optional(),
  countAsYardMove: z.boolean().optional(),
  enabled: z.boolean().optional(),
  /** §20 B-104 — null resets the fence to "all groups"; absent leaves it unchanged. */
  vehicleGroupId: z.string().uuid().nullable().optional(),
});
export type UpdateGeofenceDto = z.infer<typeof UpdateGeofenceDto>;
