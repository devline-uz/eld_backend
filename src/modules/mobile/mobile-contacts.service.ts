import { Injectable } from '@nestjs/common';
import { MobileFleetOpsRepository } from './mobile-fleet-ops.repository';
import { MobileRepository } from './mobile.repository';

export interface MobileContact {
  id: string;
  name: string;
  role: string;
  phone: string | null;
}

const SUPPORT_CONTACT_ID = 'support';

/**
 * mobile/tz.md §21.1 MB-14, screens M-15/M-16 — the driver's in-app contact list: fleet
 * staff, the active co-driver (if any), and a synthetic "support" entry.
 */
@Injectable()
export class MobileContactsService {
  constructor(
    private readonly repo: MobileFleetOpsRepository,
    private readonly mobileRepo: MobileRepository,
  ) {}

  async list(driverId: string): Promise<MobileContact[]> {
    const [staff, pairing, carrier] = await Promise.all([
      this.repo.listStaffContacts(),
      this.mobileRepo.findActivePairing(driverId),
      this.mobileRepo.findCarrier(),
    ]);

    const contacts: MobileContact[] = staff.map((user) => ({
      id: user.id,
      name: `${user.firstName} ${user.lastName}`,
      role: user.role.key,
      phone: user.phone ?? null,
    }));

    if (pairing) {
      const coDriverId = pairing.primaryDriverId === driverId ? pairing.coDriverId : pairing.primaryDriverId;
      const coDriver = await this.mobileRepo.findDriver(coDriverId);
      if (coDriver) {
        contacts.push({ id: coDriver.id, name: `${coDriver.firstName} ${coDriver.lastName}`, role: 'CO_DRIVER', phone: coDriver.phone ?? null });
      }
    }

    contacts.push({ id: SUPPORT_CONTACT_ID, name: `${carrier?.name ?? 'OneBook ELD'} Support`, role: 'SUPPORT', phone: carrier?.phone ?? null });

    return contacts;
  }
}
