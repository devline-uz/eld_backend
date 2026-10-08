import { MobileCatalogController } from './mobile-catalog.controller';

describe('MobileCatalogController (MR-9)', () => {
  it('maps catalog rows to {code,name,part,category,critical,isPhoto} and passes the part filter', async () => {
    const catalog = {
      listCatalog: jest.fn().mockResolvedValue([
        { id: 'x', code: 'BRAKES_SERVICE', name: 'Brakes, Service', part: 'TRUCK', category: 'Brakes', critical: true, sortOrder: 30, active: true, isPhoto: false },
        { id: 'y', code: 'OTHER', name: 'Other', part: 'TRUCK', category: null, critical: false, sortOrder: 320, active: true, isPhoto: false },
      ]),
    };
    const controller = new MobileCatalogController(catalog as never, {} as never);
    const out = await controller.defectCatalog({ part: 'TRUCK' });
    expect(catalog.listCatalog).toHaveBeenCalledWith('TRUCK');
    expect(out).toEqual([
      { code: 'BRAKES_SERVICE', name: 'Brakes, Service', part: 'TRUCK', category: 'Brakes', critical: true, isPhoto: false },
      { code: 'OTHER', name: 'Other', part: 'TRUCK', category: null, critical: false, isPhoto: false },
    ]);
  });
});
