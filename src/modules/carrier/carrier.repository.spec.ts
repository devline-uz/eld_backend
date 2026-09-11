import { CarrierRepository, CARRIER_ID } from './carrier.repository';

describe('CarrierRepository', () => {
  let carrier: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
  let repo: CarrierRepository;

  beforeEach(() => {
    carrier = { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() };
    repo = new CarrierRepository({ carrier } as never);
  });

  it('findById queries by the given id', async () => {
    await repo.findById('some-id');
    expect(carrier.findUnique).toHaveBeenCalledWith({ where: { id: 'some-id' } });
  });

  it('get queries the singleton row', async () => {
    await repo.get();
    expect(carrier.findUnique).toHaveBeenCalledWith({ where: { id: CARRIER_ID } });
  });

  it('ensure upserts the singleton row with TZ §5.1 defaults', async () => {
    await repo.ensure();
    expect(carrier.upsert).toHaveBeenCalledWith({
      where: { id: CARRIER_ID },
      create: { id: CARRIER_ID, name: 'Carrier', dotNumber: '' },
      update: {},
    });
  });

  it('update writes to the singleton row', async () => {
    await repo.update({ name: 'New Name' });
    expect(carrier.update).toHaveBeenCalledWith({ where: { id: CARRIER_ID }, data: { name: 'New Name' } });
  });
});
