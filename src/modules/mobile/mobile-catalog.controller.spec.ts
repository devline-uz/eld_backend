import { MobileCatalogController } from './mobile-catalog.controller';

describe('MobileCatalogController (MR-9)', () => {
  it('maps catalog rows to {code,name,part,category,critical} and passes the part filter', async () => {
    const catalog = {
      listCatalog: jest.fn().mockResolvedValue([
        { id: 'x', code: 'BRAKES_SERVICE', name: 'Brakes, Service', part: 'TRUCK', category: 'Brakes', critical: true, sortOrder: 30, active: true },
        { id: 'y', code: 'OTHER', name: 'Other', part: 'TRUCK', category: null, critical: false, sortOrder: 320, active: true },
      ]),
    };
    const controller = new MobileCatalogController(catalog as never, {} as never);
    const out = await controller.defectCatalog({ part: 'TRUCK' });
    expect(catalog.listCatalog).toHaveBeenCalledWith('TRUCK');
    expect(out).toEqual([
      { code: 'BRAKES_SERVICE', name: 'Brakes, Service', part: 'TRUCK', category: 'Brakes', critical: true },
      { code: 'OTHER', name: 'Other', part: 'TRUCK', category: null, critical: false },
    ]);
  });
});
