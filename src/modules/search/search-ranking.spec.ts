import { candidateLimit, normalizeUnitQuery, rankDrivers, rankVehicles, searchTokens } from './search-ranking';

const driver = (firstName: string, lastName: string, username = `${firstName}.${lastName}`.toLowerCase()) => ({
  firstName,
  lastName,
  username,
});
const unit = (unitNumber: string, vin = `VIN-${unitNumber}`) => ({ unitNumber, vin });

describe('search ranking (LIVE-009)', () => {
  it('splits q into words and caps how many are matched', () => {
    expect(searchTokens('  Richard   Lewis ')).toEqual(['Richard', 'Lewis']);
    expect(searchTokens('a b c d e f g')).toHaveLength(5);
  });

  it('normalises a unit query like the vehicle form does', () => {
    expect(normalizeUnitQuery(' #106 ')).toBe('106');
    expect(normalizeUnitQuery('##7')).toBe('7');
  });

  it('fetches more candidates than it shows, bounded', () => {
    expect(candidateLimit(5)).toBe(25);
    expect(candidateLimit(25)).toBe(50);
  });

  it('puts the exact full name first, then a name that starts with q, then word-prefix matches', () => {
    const rows = [driver('Lewis', 'Richardson'), driver('Richard', 'Lewisham'), driver('Richard', 'Lewis')];
    expect(rankDrivers(rows, 'richard lewis', 5).map((r) => `${r.firstName} ${r.lastName}`)).toEqual([
      'Richard Lewis',
      'Richard Lewisham',
      'Lewis Richardson',
    ]);
  });

  it('matches a partial last name ("QA Dri")', () => {
    const rows = [driver('Dri', 'Other'), driver('QA', 'Driver')];
    expect(rankDrivers(rows, 'QA Dri', 5)[0]).toMatchObject({ firstName: 'QA', lastName: 'Driver' });
  });

  it('puts the exact unit (with or without #) first, then prefix matches, in natural order', () => {
    const rows = [unit('161'), unit('1060'), unit('#106'), unit('2106'), unit('16')];
    expect(rankVehicles(rows, '106', 5).map((r) => r.unitNumber)).toEqual(['#106', '1060', '16', '161', '2106']);
    expect(rankVehicles(rows, '#106', 1).map((r) => r.unitNumber)).toEqual(['#106']);
  });

  it('treats an exact VIN as an exact hit', () => {
    const rows = [unit('5', 'ABC1234'), unit('ABC', 'ZZZ')];
    expect(rankVehicles(rows, 'abc1234', 5)[0]?.unitNumber).toBe('5');
  });
});
