// The phone's address, as the relay reports it to the connector and counts it for rate limits.
// The relay reports what its runtime saw; the connector checks it again before using it (R3).

const MAX_ADDRESS_CHARS = 45;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** An IPv4 or IPv6 address as text, or empty when the runtime gave none or something else. */
export function addressText(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  const text = raw.trim();
  if (text.length > MAX_ADDRESS_CHARS) return "";
  if (isIpv4(text)) return text;
  return ipv6Groups(text) === null ? "" : text.toLowerCase();
}

/**
 * The key a phone's dials are counted under: an IPv4 address whole (an IPv4-mapped IPv6 one as
 * IPv4), an IPv6 address by its first 64 bits, since one host can hold a whole /64.
 */
export function addressRateKey(address: string): string {
  if (isIpv4(address)) return address;
  const groups = ipv6Groups(address);
  if (groups === null) return "unknown";
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const [high, low] = [groups[6]!, groups[7]!];
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

function isIpv4(text: string): boolean {
  const match = IPV4.exec(text);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255);
}

/** The eight 16-bit groups of an IPv6 address, or null if it is not one. */
function ipv6Groups(text: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (half: string): number[] | null => {
    if (half === "") return [];
    const out: number[] = [];
    const parts = half.split(":");
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes(".")) {
        if (!isIpv4(part)) return null;
        const [a, b, c, d] = part.split(".").map(Number) as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
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
