import { SearchService } from './search.service';

function buildService() {
  const repo = {
    findDrivers: jest.fn(async () => [
      { id: 'drv_1', firstName: 'John', lastName: 'Smith', username: 'jsmith', homeTerminalName: 'Columbus', assignedVehicle: { unitNumber: 'U-100' } },
    ]),
    findVehicles: jest.fn(async () => [
      { id: 'veh_1', unitNumber: 'U-100', make: 'Freightliner', model: 'Cascadia', vin: '1HGCM82633A123456', driver: { firstName: 'John', lastName: 'Smith' } },
    ]),
  };
  const activeViolations = { openCountsByDriver: jest.fn(async () => new Map([['drv_1', 2]])) };
  return { service: new SearchService(repo as never, activeViolations as never), repo, activeViolations };
}

const FULL = { permissions: { drivers: 'READ', vehicles: 'READ', hos: 'READ' } } as const;

describe('SearchService — §20 B-10', () => {
  it('joins driver hits with their unit number and open-violation count', async () => {
    const { service } = buildService();
    const result = await service.search('smith', 5, FULL);
    expect(result.drivers).toEqual([
      { id: 'drv_1', name: 'John Smith', unitNumber: 'U-100', dutyStatus: null, openViolations: 2, openWarnings: null, homeTerminalName: 'Columbus' },
    ]);
  });

  it('joins vehicle hits with their driver name', async () => {
    const { service } = buildService();
    const result = await service.search('u-100', 5, FULL);
    expect(result.vehicles).toEqual([
      { id: 'veh_1', unitNumber: 'U-100', make: 'Freightliner', model: 'Cascadia', vin: '1HGCM82633A123456', driverName: 'John Smith' },
    ]);
  });

  it('echoes q back on the response', async () => {
    const { service } = buildService();
    const result = await service.search('smith', 5, FULL);
    expect(result.q).toBe('smith');
  });

  describe('B-090 — each section is gated by its own permission', () => {
    it('never queries drivers (or violation counts) for a caller without drivers READ', async () => {
      const { service, repo, activeViolations } = buildService();
      const result = await service.search('smith', 5, { permissions: { vehicles: 'READ', drivers: 'NONE', hos: 'FULL' } });
      expect(repo.findDrivers).not.toHaveBeenCalled();
      expect(activeViolations.openCountsByDriver).not.toHaveBeenCalled();
      expect(result.drivers).toEqual([]);
      expect(result.vehicles).toHaveLength(1);
      expect(result.vehicles[0].driverName).toBeNull();
    });

    it('never queries vehicles for a caller without vehicles READ', async () => {
      const { service, repo } = buildService();
      const result = await service.search('smith', 5, { permissions: { drivers: 'READ' } });
      expect(repo.findVehicles).not.toHaveBeenCalled();
      expect(result.vehicles).toEqual([]);
      expect(result.drivers).toHaveLength(1);
    });

    it('leaves openViolations null without hos READ', async () => {
      const { service, activeViolations } = buildService();
      const result = await service.search('smith', 5, { permissions: { drivers: 'READ' } });
      expect(activeViolations.openCountsByDriver).not.toHaveBeenCalled();
      expect(result.drivers[0].openViolations).toBeNull();
    });

    it('returns nothing for a principal with no permission matrix (driver token / API key)', async () => {
      const { service, repo } = buildService();
      const result = await service.search('smith', 5, undefined);
      expect(repo.findDrivers).not.toHaveBeenCalled();
      expect(repo.findVehicles).not.toHaveBeenCalled();
      expect(result).toEqual({ q: 'smith', drivers: [], vehicles: [] });
    });
  });

  describe('LIVE-009 — matching, ranking and the violation count', () => {
    const vehicle = (unitNumber: string) => ({
      id: `veh_${unitNumber}`, unitNumber, make: null, model: null, vin: `VIN${unitNumber}`, driver: null,
    });

    it('counts ACTIVE violations per matched driver (the roster rule), not every OPEN row', async () => {
      const { service, activeViolations } = buildService();
      await service.search('john', 5, FULL);
      expect(activeViolations.openCountsByDriver).toHaveBeenCalledWith(['drv_1']);
    });

    it('fetches a wider candidate set and returns the exact unit first, cut to the limit', async () => {
      const { service, repo } = buildService();
      repo.findVehicles.mockResolvedValueOnce(
        ['161', '166', '165', '164', '163', '1060', '106'].map(vehicle) as never,
      );
      const result = await service.search('106', 5, FULL);
      expect(repo.findVehicles).toHaveBeenCalledWith('106', 25);
      expect(result.vehicles.map((v) => v.unitNumber)).toEqual(['106', '1060', '161', '163', '164']);
    });

    it('ranks the exact full name above other matches', async () => {
      const { service, repo } = buildService();
      const driver = (id: string, firstName: string, lastName: string) => ({
        id, firstName, lastName, username: id, homeTerminalName: 'Columbus', assignedVehicle: null,
      });
      repo.findDrivers.mockResolvedValueOnce([
        driver('d1', 'Lewis', 'Richardson'),
        driver('d2', 'Richard', 'Lewis'),
      ] as never);
      const result = await service.search('Richard Lewis', 5, FULL);
      expect(result.drivers.map((d) => d.name)).toEqual(['Richard Lewis', 'Lewis Richardson']);
    });
  });
});
