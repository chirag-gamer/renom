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

export const MINEKUBE_PLUGIN_URL =
  "https://github.com/minekube/connect-java/releases/download/latest/connect-spigot.jar";

/** Resolve the pinned digest for the plugin jar (fail-closed when absent). */
async function pluginDigest(fetchImpl: typeof fetch): Promise<string> {
  const res = await guardedFetch(fetchImpl, "https://api.github.com/repos/minekube/connect-java/releases/latest", {
    timeoutMs: 30_000,
  });
  if (!res.ok) throw new EngineError("Could not resolve the Minekube plugin release");
  const release = (await res.json()) as {
    assets: Array<{ name: string; browser_download_url: string; digest?: string }>;
  };
  const asset = release.assets.find((a) => a.name === "connect-spigot.jar");
  const hex = asset?.digest?.includes(":") ? asset.digest.split(":")[1] : undefined;
  if (!asset || !hex || !/^[a-f0-9]{64}$/i.test(hex)) {
    throw new EngineError("Minekube plugin release has no verifiable digest");
  }
  return hex.toLowerCase();
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

export function endpointValid(endpoint: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(endpoint);
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
    await downloadFile(fetchImpl, MINEKUBE_PLUGIN_URL, dest, {
      maxBytes: 64 * 1024 * 1024,
      sha256: await pluginDigest(fetchImpl),
    });
  }
  return dest;
}
