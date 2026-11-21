// The headers of the connector's own upgrade to the gateway. They are built here from what the
// connector knows, never copied from the phone: the relay passes no phone header on, and the
// connector would not forward one if it did.
//
// `X-Forwarded-For` is always set and never loopback. The gateway treats a loopback socket with
// no forwarded headers as `direct-local` and pairs it silently, as if it sat at the gateway's
// keyboard, so a relayed phone must always arrive with a forwarded address. With
// `gateway.trustedProxies` covering loopback the gateway then attributes the connection as
// `trusted-proxy`, which is remote, and a new phone waits for its owner's approval
// (docs/research/relay.md). A loopback `X-Forwarded-For` would be refused with 403.

/**
 * The address sent when the relay reported none, or one that is not public: 192.0.2.1, from the
 * documentation range (RFC 5737), which is neither loopback nor any network's own.
 */
export const FALLBACK_FORWARDED_FOR = "192.0.2.1";

/** The upgrade headers, by their exact names. Nothing else is set but what WebSocket needs. */
export interface ForwardedHeaders {
  readonly "X-Forwarded-For": string;
  readonly "X-Forwarded-Proto": "https" | "http";
  readonly "X-Forwarded-Host": string;
}

/**
 * The headers for one phone's upgrade. `from` is the phone's address as the relay saw it; the
 * relay can lie about it, which only changes the address the gateway records and rate-limits.
 */
export function forwardedHeaders(from: string, relayOrigin: string): ForwardedHeaders {
  const relay = new URL(relayOrigin);
  return {
    "X-Forwarded-For": forwardedFor(from),
    "X-Forwarded-Proto": relay.protocol === "wss:" ? "https" : "http",
    "X-Forwarded-Host": relay.host,
  };
}

/** The phone's address if it is a public unicast address, written canonically; otherwise the fallback. */
export function forwardedFor(from: string): string {
  const v4 = ipv4Octets(from);
  if (v4 !== null) return isPublicIpv4(v4) ? v4.join(".") : FALLBACK_FORWARDED_FOR;
  const v6 = ipv6Groups(from);
  if (v6 === null) return FALLBACK_FORWARDED_FOR;
  // An IPv4-mapped address (the ::ffff:0:0/96 block) is its IPv4 address.
  if (v6.slice(0, 5).every((group) => group === 0) && v6[5] === 0xffff) {
    const octets = [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff];
    return isPublicIpv4(octets) ? octets.join(".") : FALLBACK_FORWARDED_FOR;
  }
  return isPublicIpv6(v6)
    ? v6.map((group) => group.toString(16)).join(":")
    : FALLBACK_FORWARDED_FOR;
}

function ipv4Octets(text: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) return null;
  const octets = match.slice(1).map(Number);
  // Leading zeros are refused: some readers take them as octal.
  if (match.slice(1).some((part) => part.length > 1 && part.startsWith("0"))) return null;
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/**
 * Public unicast IPv4. Refused, by IANA's special-purpose registry: this network (0/8), the
 * private ranges (10/8, 172.16/12, 192.168/16), shared address space (100.64/10), loopback
 * (127/8), link-local (169.254/16), IETF protocol assignments (192.0.0/24), the documentation
 * ranges (192.0.2/24, 198.51.100/24, 203.0.113/24), benchmarking (198.18/15), multicast and
 * reserved (224/3).
 */
function isPublicIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/**
 * Public unicast IPv6: global unicast (2000::/3) less the documentation prefix (2001:db8::/32),
 * Teredo (2001::/32) and 6to4 (2002::/16), whose embedded addresses say nothing reliable.
 */
function isPublicIpv6(groups: readonly number[]): boolean {
  const first = groups[0]!;
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (groups[1] === 0x0db8 || groups[1] === 0)) return false;
  return first !== 0x2002;
}

/** The eight 16-bit groups of an IPv6 address, or null. No zone, no brackets. */
function ipv6Groups(text: string): number[] | null {
  if (text.length > 45 || !/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const out: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        const octets = ipv4Octets(part);
        if (octets === null) return null;
        out.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else if (/^[0-9A-Fa-f]{1,4}$/.test(part)) {
        out.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  if (left === null || right === null) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}
