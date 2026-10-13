import { loadCoDrivers, resolveCoDrivers, type PairingWithDrivers } from './co-drivers';

const ME = { id: 'drv_1', username: 'jsmith' };
const ANN = { id: 'drv_2', username: 'alee' };
const BO = { id: 'drv_3', username: 'bkim' };

function pairing(primary: { id: string }, co: { id: string }, startedAt: string, endedAt: string | null): PairingWithDrivers {
  return {
    id: `${primary.id}-${co.id}-${startedAt}`,
    primaryDriverId: primary.id,
    coDriverId: co.id,
    vehicleId: 'veh_1',
    startedAt: new Date(startedAt),
    endedAt: endedAt ? new Date(endedAt) : null,
    startedById: null,
    endedById: null,
    primaryDriver: primary,
    coDriver: co,
  } as never;
}

describe('resolveCoDrivers (Appendix A 4.8.2.1.1 line 2 / 4.8.2.1.2)', () => {
  it('no pairing => no co-driver', () => {
    expect(resolveCoDrivers('drv_1', [])).toEqual({ coDriver: null, otherCoDrivers: [] });
  });

  it('driver in the primary seat => the partner is the co-driver', () => {
    expect(resolveCoDrivers('drv_1', [pairing(ME, ANN, '2026-09-05T00:00:00Z', null)]).coDriver).toBe(ANN);
  });

  it('driver in the co seat => the partner is the primary', () => {
    expect(resolveCoDrivers('drv_1', [pairing(ANN, ME, '2026-09-05T00:00:00Z', null)]).coDriver).toBe(ANN);
  });

  it('a seat swap (ended row + mirrored row) yields the partner once', () => {
    const r = resolveCoDrivers('drv_1', [
      pairing(ME, ANN, '2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z'),
      pairing(ANN, ME, '2026-09-06T00:00:00Z', null),
    ]);
    expect(r).toEqual({ coDriver: ANN, otherCoDrivers: [] });
  });

  it('several partners: the open / latest-ended one goes to the header, the rest to the user list', () => {
    const r = resolveCoDrivers('drv_1', [
      pairing(ME, ANN, '2026-09-04T00:00:00Z', '2026-09-05T00:00:00Z'),
      pairing(BO, ME, '2026-09-06T00:00:00Z', '2026-09-08T00:00:00Z'),
    ]);
    expect(r).toEqual({ coDriver: BO, otherCoDrivers: [ANN] });
    const open = resolveCoDrivers('drv_1', [
      pairing(ME, BO, '2026-09-08T00:00:00Z', '2026-09-09T00:00:00Z'),
      pairing(ANN, ME, '2026-09-04T00:00:00Z', null),
    ]);
    expect(open.coDriver).toBe(ANN);
  });

  it('never reports the driver as their own co-driver', () => {
    expect(resolveCoDrivers('drv_1', [pairing(ME, ME, '2026-09-05T00:00:00Z', null)]).coDriver).toBeNull();
  });

  it('loadCoDrivers queries the period for the driver', async () => {
    const repo = { findCoDriverPairings: jest.fn().mockResolvedValue([pairing(ANN, ME, '2026-09-05T00:00:00Z', null)]) };
    const from = new Date('2026-09-04T04:00:00Z');
    const to = new Date('2026-09-12T03:59:59.999Z');
    expect((await loadCoDrivers(repo, 'drv_1', from, to)).coDriver).toBe(ANN);
    expect(repo.findCoDriverPairings).toHaveBeenCalledWith('drv_1', from, to);
  });
});
