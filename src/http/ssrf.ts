import dns from "node:dns";
import net from "node:net";

/**
 * Guards against server-side request forgery: a page or prompt could ask the agent to fetch
 * http://localhost:…, a router admin page or a cloud metadata endpoint. Clear-web requests may
 * only reach public addresses. (Onion requests go through the Tor proxy and never resolve locally.)
 */

const blocked = new net.BlockList();
const IPV4_RANGES: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];
const IPV6_RANGES: Array<[string, number]> = [
  ["::", 96], // unspecified, loopback and deprecated IPv4-compatible addresses
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8]
];
for (const [address, prefix] of IPV4_RANGES) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of IPV6_RANGES) blocked.addSubnet(address, prefix, "ipv6");

export class BlockedRequestError extends Error {
  readonly code = "EBLOCKED";
  constructor(message: string) {
    super(message);
    this.name = "BlockedRequestError";
  }
}

/** Canonical (compressed, hex) form of an IPv6 address, as the URL parser writes it. */
function canonicalIPv6(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return address.toLowerCase();
  }
}

/**
 * IPv4 embedded in an IPv6 address that reaches it: IPv4-mapped (::ffff:1.2.3.4) or NAT64
 * (64:ff9b::1.2.3.4). NAT64 is judged by its IPv4 part so IPv6-only networks keep working.
 */
function embeddedIPv4(address: string): string | undefined {
  const hex = canonicalIPv6(address).match(/^(?:::ffff|64:ff9b:):([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex?.[1] || !hex[2]) return undefined;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True for loopback, private, link-local, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return isPrivateAddress(v4);
    return blocked.check(address, "ipv6");
  }
  return true;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/** Rejects URLs that obviously target the local machine or network (IP literals and local names). */
export function assertPublicHost(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || LOCAL_SUFFIXES.some(s => host.endsWith(s))) {
    throw new BlockedRequestError(`Refusing to fetch ${host}: local network addresses are not allowed.`);
  }
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new BlockedRequestError(`Refusing to fetch ${host}: private or reserved IP addresses are not allowed.`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * DNS lookup used by the clear-web HTTP agent: resolves normally, then refuses to connect when any
 * resolved address is private. Checking at connect time also covers redirects and DNS rebinding.
 */
export function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 0);
      return;
    }
    const list = addresses as dns.LookupAddress[];
    const bad = list.find(a => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      callback(
        new BlockedRequestError(`Refusing to connect to ${hostname}: it resolves to a private or reserved address.`),
        "",
        0
      );
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      const first = list[0]!;
      callback(null, first.address, first.family);
    }
  });
}
