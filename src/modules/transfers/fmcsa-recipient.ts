/**
 * Email transfer recipient rule — tz.md §10.4 / §23 ("Email uzatish faqat `fmcsa.dot.gov`
 * domeniga"), 49 CFR §395.24 / Appendix A 4.9.1.
 *
 * The output file may only ever be emailed to FMCSA. Anything else is
 * `422 INVALID_TRANSFER_RECIPIENT` — this is a hard rule, not a configurable allowlist,
 * because it is the only thing standing between a driver's RODS and an arbitrary mailbox.
 */

/** The apex domain plus any subdomain of it (`*.fmcsa.dot.gov`). */
export const FMCSA_DOMAIN = 'fmcsa.dot.gov';

/** True only for `local@fmcsa.dot.gov` and `local@<sub>.fmcsa.dot.gov`. */
export function isFmcsaRecipient(recipient: string): boolean {
  const value = (recipient ?? '').trim().toLowerCase();
  // Exactly one `@`, a non-empty local part, no whitespace and no comma-separated list.
  if (!/^[^\s@,;]+@[^\s@,;]+$/.test(value)) return false;
  const domain = value.slice(value.indexOf('@') + 1);
  return domain === FMCSA_DOMAIN || domain.endsWith(`.${FMCSA_DOMAIN}`);
}
