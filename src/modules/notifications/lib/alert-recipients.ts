/**
 * F3-01 — `AlertRule.recipients.roles` holds role KEYS: `AlertProcessor` matches
 * `role.key IN roles`. The web rule editor used to save display labels ("Fleet managers"), which
 * match no user, so those rules notified nobody. The editor now sends keys; the API stores keys
 * whatever it is sent, and the worker reads already-saved labels as keys, so no data migration is
 * needed. Same mapping as `eld_web/src/features/settings/lib/alertRecipients.ts`. Pure.
 */
const LABEL_TO_KEY: Record<string, string> = {
  admins: 'ADMIN',
  'fleet managers': 'FLEET_MANAGER',
  dispatchers: 'DISPATCHER',
  // There is no "assigned fleet manager" resolver and no safety role: both meant the fleet managers.
  'assigned fleet manager': 'FLEET_MANAGER',
  'safety team': 'FLEET_MANAGER',
};

/** Stored roles (keys or legacy labels) → unique role keys, in their stored order. */
export function normalizeRecipientRoles(roles: unknown): string[] {
  if (!Array.isArray(roles)) return [];
  const out: string[] = [];
  for (const role of roles) {
    if (typeof role !== 'string') continue;
    const key = LABEL_TO_KEY[role.trim().toLowerCase()] ?? role;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}
