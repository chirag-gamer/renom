import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { downloadFile, guardedFetch } from "../runtime/install.js";
import { EngineError } from "../../shared/errors.js";

/**
 * Minekube Connect tunnel adapter (opt-in, off by default).
 *
 * How it works: the admin enables it per Java server with an endpoint name.
 * The panel downloads the Connect plugin jar into the server's `plugins/`
 * folder and passes the endpoint via the `CONNECT_ENDPOINT` environment
 * mechanism (documented precedence over config files). On boot the plugin
 * prints the public address to the console:
 *
 *   [connect] Your public address: live-beru.play.minekube.net
 *
 * The panel scrapes that line from console history and shows it as the
 * server's join address — no port forwarding, no static IP needed.
 *
 * Sources (checked 2026-09-17): https://connect.minekube.com/guide/connectors/plugin.html
 * (download URLs, CONNECT_ENDPOINT precedence, address line format).
 */

/**
 * Resolve the pinned download URL + digest for the plugin jar (fail-closed
 * when absent). The API's asset URL replaces the mutable `latest` URL, so
 * the bytes always match the digest from the same release document.
 */
async function pluginArtifact(fetchImpl: typeof fetch): Promise<{ url: string; sha256: string }> {
  const res = await guardedFetch(
    fetchImpl,
    "https://api.github.com/repos/minekube/connect-java/releases/latest",
    {
      timeoutMs: 30_000,
    },
  );
  if (!res.ok) throw new EngineError("Could not resolve the Minekube plugin release");
  const release = (await res.json()) as {
    assets: Array<{ name: string; browser_download_url: string; digest?: string }>;
  };
  const asset = release.assets.find((a) => a.name === "connect-spigot.jar");
  const hex = asset?.digest?.includes(":") ? asset.digest.split(":")[1] : undefined;
  if (!asset || !hex || !/^[a-f0-9]{64}$/i.test(hex)) {
    throw new EngineError("Minekube plugin release has no verifiable digest");
  }
  return { url: asset.browser_download_url, sha256: hex.toLowerCase() };
}

/** Matches the documented console line; tolerant of the plugin's version prefix. */
export function parsePublicAddress(line: string): string | null {
  const m = /Your public address:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})/.exec(line);
  return m?.[1] ?? null;
}

/** Newest address wins while scanning oldest → newest history. */
export function scanHistoryForAddress(lines: Array<{ text: string }>): string | null {
  let found: string | null = null;
  for (const l of lines) {
    const addr = parsePublicAddress(l.text);
    if (addr) found = addr;
  }
  return found;
}

// Connect's grammar: 4-8 letters, then 4 digits, joined by single dashes —
// e.g. `vivid-lagoon-9784`. Validating against the real shape (rather than any
// lowercase string) means a stored endpoint can actually come up, instead of
// failing silently in the connector log on first boot.
export function endpointValid(endpoint: string): boolean {
  return /^[a-z][a-z]{3,7}(?:-[a-z][a-z]{3,7})?-\d{4}$/.test(endpoint);
}

/**
 * Reserve an endpoint name for one server.
 *
 * The value is the server's public join address, so two servers claiming one
 * name means one of them silently never connects (the connector rejects a
 * name held by another token). Callers that mint their own name should retry
 * until this returns a free one.
 */
export function endpointTaken(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  endpoint: string,
  ownerId: string,
): boolean {
  const row = db
    .prepare(
      "SELECT server_id FROM server_variables WHERE key = 'tunnel.endpoint' AND value = ? AND server_id != ?",
    )
    .get(endpoint, ownerId) as { server_id: string } | undefined;
  return row !== undefined;
}

/** A free endpoint name, minting again on the (vanishingly rare) collision. */
export function claimEndpointName(
  db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } },
  serverId: string,
): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateEndpointName();
    if (!endpointTaken(db, candidate, serverId)) return candidate;
  }
  throw new Error("could not find a free tunnel endpoint name");
}

// Small word pairs, so a generated name reads like a place. The shape is
// `<adj>-<noun>-NNNN`: two words, then the four digits Connect requires.
const ADJECTIVES = [
  "amber",
  "brisk",
  "calm",
  "dusky",
  "eager",
  "frost",
  "gentle",
  "hardy",
  "ivory",
  "jolly",
  "keen",
  "lucid",
  "mellow",
  "noble",
  "open",
  "prime",
  "quiet",
  "rapid",
  "steady",
  "tidal",
  "umber",
  "vivid",
  "warm",
  "zesty",
];
const NOUNS = [
  "atlas",
  "brook",
  "cedar",
  "delta",
  "ember",
  "fjord",
  "grove",
  "haven",
  "inlet",
  "junction",
  "kettle",
  "lagoon",
  "meadow",
  "nimbus",
  "orchard",
  "prairie",
  "quarry",
  "ridge",
  "summit",
  "tundra",
  "upland",
  "valley",
  "willow",
  "zenith",
];

function pick<T>(items: T[]): T {
  return items[randomInt(items.length)]!;
}

function randomInt(max: number): number {
  // crypto, not Math.random: this name is the server's public identity.
  return randomBytes(4).readUInt32BE(0) % max;
}

/**
 * A Connect endpoint name the panel can own.
 *
 * The Minekube connector is documented to use a temporary random name when
 * none is configured (connect.minekube.com/guide/connectors/plugin), so
 * generating one here means the server is reachable without the owner
 * inventing a name and without colliding with an endpoint another
 * organization already owns — the 401 in the connector log happens when a
 * name is taken by a different token.
 */
export function generateEndpointName(): string {
  const suffix = String(randomInt(10_000)).padStart(4, "0");
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${suffix}`;
}

/** Download the plugin jar into <serverDir>/plugins (offline servers only, by route guard). */
export async function installPlugin(
  serverDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const pluginsDir = join(serverDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const dest = join(pluginsDir, "connect-spigot.jar");
  if (!existsSync(dest)) {
    const artifact = await pluginArtifact(fetchImpl);
    await downloadFile(fetchImpl, artifact.url, dest, {
      maxBytes: 64 * 1024 * 1024,
      sha256: artifact.sha256,
    });
  }
  return dest;
}
