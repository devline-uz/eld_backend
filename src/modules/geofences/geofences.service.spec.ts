import { GeofencesService } from './geofences.service';

function buildService(geocoderUrl: string | undefined = undefined) {
  const repo = {
    findById: jest.fn(async () => ({ id: 'gf_1', type: 'ADDRESS' })),
    create: jest.fn(async (data: unknown) => ({ id: 'gf_new', ...(data as object) })),
    update: jest.fn(async (_where: unknown, data: unknown) => ({ id: 'gf_1', ...(data as object) })),
  };
  const config = { get: jest.fn(() => geocoderUrl) };
  const service = new GeofencesService(repo as never, config as never);
  return { service, repo, config };
}

describe('GeofencesService — §20 B-93 ADDRESS geocoding', () => {
  it('rejects an ADDRESS create with GEOCODER_NOT_CONFIGURED when GEOCODER_URL is unset', async () => {
    const { service } = buildService(undefined);
    await expect(
      service.create({ name: 'Cust dock', type: 'ADDRESS', address: '123 Main St', radiusMi: 0.5 } as never),
    ).rejects.toMatchObject({ code: 'GEOCODER_NOT_CONFIGURED' });
  });

  it('geocodes and stores centerLat/centerLon when GEOCODER_URL is set', async () => {
    const { service, repo } = buildService('http://nominatim.local');
    global.fetch = jest.fn(async () => new Response(JSON.stringify([{ lat: '40.0', lon: '-83.0' }]), { status: 200 })) as never;
    await service.create({ name: 'Cust dock', type: 'ADDRESS', address: '123 Main St', radiusMi: 0.5 } as never);
    const data = repo.create.mock.calls[0][0] as { centerLat?: number; centerLon?: number };
    expect(data.centerLat).toBe(40.0);
    expect(data.centerLon).toBe(-83.0);
  });

  it('accepts radiusMeters as an alias of radiusMi for a CIRCLE', async () => {
    const { service, repo } = buildService(undefined);
    await service.create({ name: 'Terminal', type: 'CIRCLE', centerLat: 40, centerLon: -83, radiusMeters: 1.5 } as never);
    const data = repo.create.mock.calls[0][0] as { radiusMi?: number; radiusMeters?: number };
    expect(data.radiusMi).toBe(1.5);
    expect(data.radiusMeters).toBeUndefined();
  });
});
