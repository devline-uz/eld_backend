import { normalizeRecipientRoles } from './alert-recipients';

describe('normalizeRecipientRoles (F3-01)', () => {
  it('maps every label the web rule editor ever saved to the role key it meant', () => {
    expect(normalizeRecipientRoles(['Fleet managers'])).toEqual(['FLEET_MANAGER']);
    expect(normalizeRecipientRoles(['Dispatchers'])).toEqual(['DISPATCHER']);
    expect(normalizeRecipientRoles(['Admins'])).toEqual(['ADMIN']);
    // No "assigned fleet manager" resolver and no safety role exist: both mean the fleet managers.
    expect(normalizeRecipientRoles(['Assigned fleet manager'])).toEqual(['FLEET_MANAGER']);
    expect(normalizeRecipientRoles(['Safety team'])).toEqual(['FLEET_MANAGER']);
  });

  it('is tolerant of case and surrounding space in a label, never in a key', () => {
    expect(normalizeRecipientRoles([' fleet Managers '])).toEqual(['FLEET_MANAGER']);
  });

  it('keeps keys and unknown (custom) roles as stored, in order, without duplicates', () => {
    expect(normalizeRecipientRoles(['SUPER_ADMIN', 'Fleet managers', 'FLEET_MANAGER', 'CUSTOM_ROLE'])).toEqual(['SUPER_ADMIN', 'FLEET_MANAGER', 'CUSTOM_ROLE']);
  });

  it('treats anything but a string list as no roles', () => {
    expect(normalizeRecipientRoles(undefined)).toEqual([]);
    expect(normalizeRecipientRoles('FLEET_MANAGER')).toEqual([]);
    expect(normalizeRecipientRoles([1, null, 'DISPATCHER'])).toEqual(['DISPATCHER']);
  });
});
