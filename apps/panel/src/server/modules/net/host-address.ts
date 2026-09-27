import { networkInterfaces } from "node:os";

/**
 * The address players actually dial.
 *
 * Allocations bind the wildcard `0.0.0.0` so a server listens on every
 * interface, but `0.0.0.0` is not connectable — showing it in the panel sends
 * people to an address that cannot be reached. This resolves the host's real
 * outbound address once and caches it.
 *
 * Preference order:
 *   1. `publicIp` configured on the node (set by the installer or an admin).
 *   2. The first non-internal IPv4 on an up interface.
 *   3. `127.0.0.1` — honest for a loopback-only host, and still not a wildcard.
 */
let cached: string | null = null;

function detectIpv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue; // link-local autoconf
      return address.address;
    }
  }
  return null;
}

export function hostAddress(configuredPublicIp?: string | null): string {
  const configured = configuredPublicIp?.trim();
  if (configured) return configured;
  if (cached) return cached;
  cached = detectIpv4() ?? "127.0.0.1";
  return cached;
}

/** Test seam: forget the cached probe so a new address can be detected. */
export function resetHostAddressCache(): void {
  cached = null;
}
