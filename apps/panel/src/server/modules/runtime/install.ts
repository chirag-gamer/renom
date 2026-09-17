import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { BlueprintDoc, InstallOp } from "../blueprints/schema.js";
import { substitute } from "./engine.js";
import { EngineError } from "../../shared/errors.js";

export interface InstallContext {
  serverId: string;
  /** Absolute server directory (already created). */
  dir: string;
  /** Variables merged from blueprint defaults + stored overrides + allocation context. */
  vars: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const FETCH_TIMEOUT_MS = 60_000;
const JSON_TIMEOUT_MS = 30_000;

/**
 * Executes a blueprint's declarative install ops into the server directory.
 * Network-touching providers implemented: PaperMC Fill v3, Mojang piston-meta,
 * Purpur v2. `fabric`/`forge`/`neoforge`/`bds`/`velocity`/`modrinth` fetchers
 * are explicit 409s until wired — never silent no-ops.
 *
 * All file paths are confined to the server directory; downloads are size-
 * capped and checksum-verified whenever the provider supplies a digest.
 */
export async function runInstallOps(doc: BlueprintDoc, ctx: InstallContext): Promise<void> {
  const fetchImpl = ctx.fetchImpl ?? fetch;
  for (const rawOp of doc.install) {
    const op = rawOp as InstallOp;
    switch (op.op) {
      case "mkdir": {
        mkdirSync(confine(ctx.dir, sub(ctx.vars, op.path)), { recursive: true });
        break;
      }
      case "writefile": {
        const dest = confine(ctx.dir, sub(ctx.vars, op.path));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, substitute(op.contentTemplate, ctx.vars), "utf8");
        break;
      }
      case "move": {
        renameSync(
          confine(ctx.dir, sub(ctx.vars, op.from)),
          confine(ctx.dir, sub(ctx.vars, op.to)),
        );
        break;
      }
      case "delete": {
        rmSync(confine(ctx.dir, sub(ctx.vars, op.path)), { recursive: true, force: true });
        break;
      }
      case "eula-accept": {
        writeFileSync(
          join(ctx.dir, "eula.txt"),
          "# Accepted in the Renom panel by the server owner.\neula=true\n",
          "utf8",
        );
        break;
      }
      case "download": {
        await downloadFile(
          fetchImpl,
          sub(ctx.vars, op.url),
          confine(ctx.dir, sub(ctx.vars, op.dest)),
          {
            maxBytes: op.maxMB * 1024 * 1024,
            sha256: op.sha256,
          },
        );
        break;
      }
      case "fetch-paper": {
        const version = await resolvePaperVersion(fetchImpl, sub(ctx.vars, op.version));
        const build = await latestPaperBuild(fetchImpl, version, op.buildChannel ?? "default");
        await downloadFile(fetchImpl, build.url, join(ctx.dir, "paper.jar"), {
          maxBytes: 512 * 1024 * 1024,
          sha256: build.sha256,
        });
        break;
      }
      case "fetch-vanilla": {
        const artifact = await resolveVanilla(fetchImpl, sub(ctx.vars, op.version));
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "server.jar"), {
          maxBytes: 512 * 1024 * 1024,
          sha1: artifact.sha1,
        });
        break;
      }
      case "fetch-purpur": {
        const artifact = await resolvePurpur(fetchImpl, sub(ctx.vars, op.version));
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "purpur.jar"), {
          maxBytes: 512 * 1024 * 1024,
          md5: artifact.md5,
        });
        break;
      }
      case "extract":
        throw new EngineError("Install op 'extract' is not wired yet");
      case "chmod":
        throw new EngineError("Install op 'chmod' is not wired yet");
      case "template-render":
        throw new EngineError("Install op 'template-render' is not wired yet");
      case "fetch-fabric":
      case "fetch-forge":
      case "fetch-neoforge":
      case "fetch-bds":
      case "fetch-velocity":
      case "modrinth-install":
        throw new EngineError(`Install op '${op.op}' is not wired yet`);
      default:
        throw new EngineError(`Unknown install op '${(op as { op: string }).op}'`);
    }
  }
}

function sub(vars: Record<string, string>, template: string): string {
  return substitute(template, vars);
}

/** Every op path stays inside the server directory. */
export function confine(serverDir: string, rel: string): string {
  const trimmed = rel.trim().replace(/^[/\\]+/, "");
  const resolved = resolve(serverDir, trimmed);
  if (resolved !== serverDir && !resolved.startsWith(serverDir + sep)) {
    throw new EngineError(`Install path escapes the server directory: ${rel}`);
  }
  return resolved;
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
  if (!res.ok) throw new EngineError(`Registry request failed (${res.status}): ${url}`);
  return res.json() as Promise<unknown>;
}

interface DownloadGuards {
  maxBytes: number;
  sha256?: string;
  sha1?: string;
  md5?: string;
}

/** Streamed download with a hard size cap and optional digest verification. */
export async function downloadFile(
  fetchImpl: typeof fetch,
  url: string,
  dest: string,
  guards: DownloadGuards,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok || !res.body) {
    throw new EngineError(`Download failed (${res.status}): ${url}`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > guards.maxBytes) {
    throw new EngineError(`Download too large (${declared} bytes): ${url}`);
  }
  const hash = guards.sha256
    ? createHash("sha256")
    : guards.sha1
      ? createHash("sha1")
      : guards.md5
        ? createHash("md5")
        : null;
  let seen = 0;
  const metering = new Transform({
    transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      try {
        seen += chunk.length;
        if (seen > guards.maxBytes) throw new EngineError(`Download exceeded size cap: ${url}`);
        if (hash) hash.update(chunk);
        cb(null, chunk);
      } catch (err) {
        cb(err as Error);
      }
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as WebReadableStream),
      metering,
      createWriteStream(tmp),
    );
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err instanceof EngineError ? err : new EngineError(`Download interrupted: ${url}`);
  }
  const digest = hash?.digest("hex");
  const want = guards.sha256 ?? guards.sha1 ?? guards.md5;
  if (want && digest !== want.toLowerCase()) {
    rmSync(tmp, { force: true });
    throw new EngineError(`Checksum mismatch for ${url} — refusing a corrupt jar`);
  }
  renameSync(tmp, dest);
}

// --- providers ---

async function resolvePaperVersion(fetchImpl: typeof fetch, version: string): Promise<string> {
  if (version !== "" && version !== "latest") return version;
  const data = (await fetchJson(
    fetchImpl,
    "https://fill.papermc.io/v3/projects/paper/versions",
  )) as {
    versions: Array<{ version: { id: string }; support?: { status?: string } }>;
  };
  // First SUPPORTED non-prerelease entry (list is newest-first).
  const stable = data.versions.find(
    (v) =>
      !/-(rc|pre|snapshot)/i.test(v.version.id) &&
      (v.support?.status ?? "SUPPORTED") === "SUPPORTED",
  );
  const pick = stable ?? data.versions[0];
  if (!pick) throw new EngineError("PaperMC returned no versions");
  return pick.version.id;
}

async function latestPaperBuild(
  fetchImpl: typeof fetch,
  version: string,
  channel: "default" | "experimental",
): Promise<{ url: string; sha256: string }> {
  const builds = (await fetchJson(
    fetchImpl,
    `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`,
  )) as Array<{
    channel: string;
    downloads: Record<string, { url: string; checksums: { sha256: string } }>;
  }>;
  const pool = channel === "experimental" ? builds : builds.filter((b) => b.channel === "STABLE");
  const build = (pool.length > 0 ? pool : builds).at(-1);
  const dl = build?.downloads["server:default"];
  if (!dl) throw new EngineError(`No PaperMC build found for ${version}`);
  return { url: dl.url, sha256: dl.checksums.sha256 };
}

async function resolveVanilla(
  fetchImpl: typeof fetch,
  version: string,
): Promise<{ url: string; sha1: string }> {
  const manifest = (await fetchJson(
    fetchImpl,
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
  )) as { latest: { release: string }; versions: Array<{ id: string; url: string }> };
  const id = version === "" || version === "latest" ? manifest.latest.release : version;
  const entry = manifest.versions.find((v) => v.id === id);
  if (!entry) throw new EngineError(`Unknown vanilla version '${id}'`);
  const detail = (await fetchJson(fetchImpl, entry.url)) as {
    downloads: { server: { url: string; sha1: string } };
  };
  return { url: detail.downloads.server.url, sha1: detail.downloads.server.sha1 };
}

async function resolvePurpur(
  fetchImpl: typeof fetch,
  version: string,
): Promise<{ url: string; md5?: string }> {
  const id = version === "" || version === "latest" ? "latest" : version;
  const info = (await fetchJson(
    fetchImpl,
    `https://api.purpurmc.org/v2/paper/${encodeURIComponent(id)}`,
  )) as {
    version: string;
    builds: { latest: string };
    md5?: string;
  };
  const build = info.builds.latest;
  const detail = (await fetchJson(
    fetchImpl,
    `https://api.purpurmc.org/v2/paper/${encodeURIComponent(info.version)}/${encodeURIComponent(build)}`,
  )) as { md5?: string };
  return {
    url: `https://api.purpurmc.org/v2/paper/${encodeURIComponent(info.version)}/${encodeURIComponent(build)}/download`,
    md5: detail.md5 ?? info.md5,
  };
}
