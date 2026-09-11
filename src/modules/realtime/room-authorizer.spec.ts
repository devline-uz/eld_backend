/**
 * TZ §12.4 — realtime room authorization.
 *
 * Regression guard: `subscribe` used to accept any room matching the name pattern, so any
 * authenticated socket could join `conversation:{id}` (read a thread it is not part of) or
 * `vehicle:{id}` for any unit in the fleet.
 */
import type { ContextUser } from '../../core/context/request-context';
import type { PrismaService } from '../../core/prisma/prisma.service';
import { RealtimeRoomAuthorizer } from './room-authorizer';

const DRIVER: ContextUser = { id: 'drv_1', type: 'driver' };
const USER: ContextUser = { id: 'usr_1', type: 'user', role: 'ADMIN' };

function build(options: { assignedVehicleId?: string | null; participantCount?: number } = {}) {
  const driverFindUnique = jest.fn().mockResolvedValue({ assignedVehicleId: options.assignedVehicleId ?? null });
  const participantCount = jest.fn().mockResolvedValue(options.participantCount ?? 0);
  const prisma = {
    driver: { findUnique: driverFindUnique },
    conversationParticipant: { count: participantCount },
  } as unknown as PrismaService;
  return { authorizer: new RealtimeRoomAuthorizer(prisma), driverFindUnique, participantCount };
}

describe('RealtimeRoomAuthorizer', () => {
  it('lets a principal join only its own identity room', async () => {
    const { authorizer } = build();
    await expect(authorizer.mayJoin('driver:drv_1', DRIVER)).resolves.toBe(true);
    await expect(authorizer.mayJoin('driver:drv_2', DRIVER)).resolves.toBe(false);
    await expect(authorizer.mayJoin('user:usr_1', USER)).resolves.toBe(true);
    await expect(authorizer.mayJoin('user:usr_2', USER)).resolves.toBe(false);
    // A driver token must not be able to masquerade as a back-office socket.
    await expect(authorizer.mayJoin('user:usr_1', DRIVER)).resolves.toBe(false);
  });

  it('keeps the fleet/violations broadcast rooms out of driver tokens', async () => {
    const { authorizer } = build();
    await expect(authorizer.mayJoin('fleet', DRIVER)).resolves.toBe(false);
    await expect(authorizer.mayJoin('violations', DRIVER)).resolves.toBe(false);
    await expect(authorizer.mayJoin('fleet', USER)).resolves.toBe(true);
  });

  it('limits a driver to the vehicle room of their own assigned unit', async () => {
    const { authorizer } = build({ assignedVehicleId: 'veh_1' });
    await expect(authorizer.mayJoin('vehicle:veh_1', DRIVER)).resolves.toBe(true);
    await expect(authorizer.mayJoin('vehicle:veh_9', DRIVER)).resolves.toBe(false);
  });

  it('refuses every vehicle room for a driver with no assignment', async () => {
    const { authorizer } = build({ assignedVehicleId: null });
    await expect(authorizer.mayJoin('vehicle:veh_1', DRIVER)).resolves.toBe(false);
  });

  it('requires conversation participation, checked per principal type', async () => {
    const denied = build({ participantCount: 0 });
    await expect(denied.authorizer.mayJoin('conversation:cnv_1', DRIVER)).resolves.toBe(false);
    expect(denied.participantCount).toHaveBeenCalledWith({
      where: { conversationId: 'cnv_1', driverId: 'drv_1' },
    });

    const allowed = build({ participantCount: 1 });
    await expect(allowed.authorizer.mayJoin('conversation:cnv_1', USER)).resolves.toBe(true);
    expect(allowed.participantCount).toHaveBeenCalledWith({
      where: { conversationId: 'cnv_1', userId: 'usr_1' },
    });
  });

  it('denies any room it does not explicitly know', async () => {
    const { authorizer } = build();
    for (const room of ['', 'admin', 'carrier:other', 'driver:', '*']) {
      await expect(authorizer.mayJoin(room, USER)).resolves.toBe(false);
    }
  });
});
