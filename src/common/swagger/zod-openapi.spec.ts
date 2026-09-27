import { z } from 'zod';
import { zodObjectFields, ZodSchemaRegistry } from './zod-openapi';

describe('zod → OpenAPI converter (Phase 13B)', () => {
  it('documents the input side: optional/default not required, nullable, formats, bounds', () => {
    const reg = new ZodSchemaRegistry();
    const schema = z
      .object({
        id: z.string().uuid(),
        at: z.string().datetime(),
        note: z.string().max(10).nullable(),
        limit: z.coerce.number().int().min(1).max(200).default(25),
        status: z.enum(['A', 'B']).optional(),
        tags: z.array(z.string()).min(1),
      })
      .refine(() => true);
    expect(reg.toSchema(schema)).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        at: { type: 'string', format: 'date-time' },
        note: { type: 'string', maxLength: 10, nullable: true },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
        status: { type: 'string', enum: ['A', 'B'] },
        tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['id', 'at', 'note', 'tags'],
    });
  });

  it('emits named schemas once into components and references them, nullable via allOf', () => {
    const reg = new ZodSchemaRegistry();
    const Location = z.object({ lat: z.number() });
    reg.register(Location, 'LocationDto');
    const Body = z.object({ from: Location, to: Location.nullable() });
    reg.register(Body, 'TripDto');
    expect(reg.toSchema(Body)).toEqual({ $ref: '#/components/schemas/TripDto' });
    expect(reg.components.TripDto.properties).toEqual({
      from: { $ref: '#/components/schemas/LocationDto' },
      to: { allOf: [{ $ref: '#/components/schemas/LocationDto' }], nullable: true },
    });
    expect(reg.components.LocationDto).toEqual({
      type: 'object',
      properties: { lat: { type: 'number' } },
      required: ['lat'],
    });
  });

  it('suffixes a clashing name for a different schema', () => {
    const reg = new ZodSchemaRegistry();
    expect(reg.register(z.string(), 'X')).toBe('X');
    expect(reg.register(z.number(), 'X')).toBe('X2');
  });

  it('spreads merged / extended query DTOs into top-level fields', () => {
    const base = z.object({ page: z.coerce.number().default(1), q: z.string().optional() });
    const fields = zodObjectFields(base.extend({ driverId: z.string().uuid() }));
    expect(fields.map((f) => [f.name, f.required])).toEqual([
      ['page', false],
      ['q', false],
      ['driverId', true],
    ]);
  });
});
