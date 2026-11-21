// iOS asks the person before an app reaches a device on their local network, and
// a refusal looks to the app like a gateway that does not answer. So when a
// gateway on a local address cannot be reached, the error says that the
// permission may be the cause, and where to allow it. Pure, so the unit tests
// cover it.

export const LOCAL_NETWORK_HINT =
  "If the gateway is on your local network, iOS may be keeping Clawtrate from it: allow Local Network for Clawtrate in Settings, Privacy & Security, Local Network.";

/** Whether a gateway's address is on the local network: a private, link-local or .local host. */
export function isLocalAddress(url: string | null | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".local") || host === "local") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  // IPv6 unique local (the fc00 /7 prefix) and link-local (the fe80 /10 prefix).
  return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

/** The hint to add to an unreachable gateway's error, or null. */
export function localNetworkHint(
  code: string | null | undefined,
  url: string | null | undefined,
): string | null {
  return code === "UNREACHABLE" && isLocalAddress(url) ? LOCAL_NETWORK_HINT : null;
}
