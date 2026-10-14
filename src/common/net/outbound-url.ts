import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * CODE-018 — outbound requests to a user-configured URL (integration webhooks). Without these
 * checks an `integrations:FULL` user could point the worker at `127.0.0.1`, the cloud metadata
 * endpoint (`169.254.169.254`) or any private host and read its response in the delivery log.
 *
 * - `outboundUrlProblem` — the static check at save time and before every send: absolute
 *   `https://`, no credentials in the URL, no `localhost`, no literal private / loopback /
 *   link-local / reserved IP;
 * - `assertPublicDestination` — at send time, after DNS resolution: every address the host
 *   resolves to must be public (a public name pointing at `10.0.0.5` is refused too).
 *
 * The send itself must not follow redirects (`redirect: 'manual'`), or a public URL could bounce
 * the request to a private one.
 */

/** IPv4 ranges that are never a legitimate webhook destination. */
const BLOCKED_V4: ReadonlyArray<[number, number]> = [
  [ip4('0.0.0.0'), 8], // "this" network
  [ip4('10.0.0.0'), 8], // private
  [ip4('100.64.0.0'), 10], // carrier-grade NAT
  [ip4('127.0.0.0'), 8], // loopback
  [ip4('169.254.0.0'), 16], // link-local, cloud metadata
  [ip4('172.16.0.0'), 12], // private
  [ip4('192.0.0.0'), 24], // IETF protocol assignments
  [ip4('192.0.2.0'), 24], // TEST-NET-1
  [ip4('192.168.0.0'), 16], // private
  [ip4('198.18.0.0'), 15], // benchmarking
  [ip4('198.51.100.0'), 24], // TEST-NET-2
  [ip4('203.0.113.0'), 24], // TEST-NET-3
  [ip4('224.0.0.0'), 4], // multicast
  [ip4('240.0.0.0'), 4], // reserved + broadcast
];

function ip4(address: string): number {
  return address.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

function isBlockedV4(address: string): boolean {
  const value = ip4(address);
  return BLOCKED_V4.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    return value >= base && value < base + size;
  });
}

/** Expands an IPv6 literal to its eight 16-bit groups (handles `::` and an embedded IPv4 tail). */
function ip6Groups(address: string): number[] {
  let text = address.toLowerCase();
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4Tail) {
    const v4 = ip4(v4Tail[1]);
    text = `${text.slice(0, -v4Tail[1].length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const parse = (part: string | undefined) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const front = parse(head);
  const back = parse(tail);
  const fill = tail === undefined ? [] : new Array<number>(8 - front.length - back.length).fill(0);
  return [...front, ...fill, ...back];
}

function isBlockedV6(address: string): boolean {
  const g = ip6Groups(address);
  if (g.length !== 8) return true;
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(8)) return true; // ::
  if (allZeroUntil(7) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) — judge the IPv4 inside.
  if (allZeroUntil(5) && (g[5] === 0xffff || g[5] === 0)) {
    return isBlockedV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g[0] === 0x64 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64 (could reach private v4)
  return false;
}

/** `true` for any address an outbound webhook must never reach. Non-IP input is `true` too. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(bare);
  if (family === 4) return isBlockedV4(bare);
  if (family === 6) return isBlockedV6(bare);
  return true;
}

/** `null` when `raw` may be stored / sent to, else a short reason (user-facing). */
export function outboundUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'must be a full https:// URL';
  }
  if (url.protocol !== 'https:') return 'must be a full https:// URL';
  if (url.username || url.password) return 'must not contain a username or password';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return 'must be a full https:// URL';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'must be a public address';
  if (isIP(host) && isBlockedAddress(host)) return 'must be a public address';
  return null;
}

export class BlockedDestinationError extends Error {}

export type LookupAll = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: LookupAll = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Throws `BlockedDestinationError` unless `raw` passes `outboundUrlProblem` and every address its
 * host resolves to is public. Call right before the request. */
export async function assertPublicDestination(raw: string, lookup: LookupAll = defaultLookup): Promise<void> {
  const problem = outboundUrlProblem(raw);
  if (problem) throw new BlockedDestinationError(`Webhook URL ${problem}.`);
  const host = new URL(raw.trim()).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new BlockedDestinationError(`Webhook host "${host}" could not be resolved.`);
  }
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new BlockedDestinationError(`Webhook host "${host}" resolves to a private or reserved address.`);
  }
}
