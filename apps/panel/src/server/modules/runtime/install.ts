import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
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
  /** Blueprint slug (drives loader/folder choices for mod platforms). */
  blueprintSlug?: string;
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
      case "extract": {
        await extractArchive(
          confine(ctx.dir, sub(ctx.vars, op.src)),
          ctx.dir,
          sub(ctx.vars, op.dest),
          op.strip,
          op.safe,
        );
        break;
      }
      case "chmod":
        throw new EngineError("Install op 'chmod' is not wired yet");
      case "template-render":
        throw new EngineError("Install op 'template-render' is not wired yet");
      case "fetch-fabric":
      case "fetch-forge":
      case "fetch-neoforge":
      case "fetch-velocity":
        throw new EngineError(`Install op '${op.op}' is not wired yet`);
      case "fetch-bds": {
        const artifact = await resolveBds(fetchImpl, sub(ctx.vars, op.version ?? ""), op.channel);
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "bedrock-server.zip"), {
          maxBytes: 256 * 1024 * 1024,
          sha256: artifact.sha256,
        });
        await extractArchive(join(ctx.dir, "bedrock-server.zip"), ctx.dir, ".", 0, true);
        rmSync(join(ctx.dir, "bedrock-server.zip"), { force: true });
        break;
      }
      case "fetch-pocketmine": {
        const pmmp = await resolvePocketMine(fetchImpl, sub(ctx.vars, op.version ?? ""));
        await downloadFile(fetchImpl, pmmp.pharUrl, join(ctx.dir, "PocketMine-MP.phar"), {
          maxBytes: 128 * 1024 * 1024,
          sha256: pmmp.pharSha256,
        });
        await downloadFile(fetchImpl, pmmp.phpUrl, join(ctx.dir, "php-runtime" + pmmp.phpExt), {
          maxBytes: 256 * 1024 * 1024,
          sha256: pmmp.phpSha256,
        });
        // The PHP archive carries its own top-level `bin/` — extract at root.
        await extractArchive(join(ctx.dir, "php-runtime" + pmmp.phpExt), ctx.dir, ".", 0, true);
        rmSync(join(ctx.dir, "php-runtime" + pmmp.phpExt), { force: true });
        break;
      }
      case "fetch-endstone": {
        await pipInstall(fetchImpl, ctx.dir, "endstone", sub(ctx.vars, op.version ?? ""));
        break;
      }
      case "modrinth-install": {
        await installModrinthProjects(fetchImpl, ctx, op.projects);
        break;
      }
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
  sha512?: string;
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
  const hash = guards.sha512
    ? createHash("sha512")
    : guards.sha256
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
  const want = guards.sha512 ?? guards.sha256 ?? guards.sha1 ?? guards.md5;
  if (!want) {
    throw new EngineError(`Refusing unverified download (no checksum): ${url}`);
  }
  if (digest !== want.toLowerCase()) {
    rmSync(tmp, { force: true });
    throw new EngineError(`Checksum mismatch for ${url} — refusing a corrupt jar`);
  }
  renameSync(tmp, dest);
}

// --- providers ---

/**
 * Bedrock Dedicated Server via the EndstoneMC version registry (verified
 * 2026-09-17): versions.json pins the latest release, per-version
 * metadata.json carries OS download URLs + sha256. Preview channel reads the
 * same layout under `preview`.
 */
async function resolveBds(
  fetchImpl: typeof fetch,
  version: string,
  channel: "stable" | "preview",
): Promise<{ url: string; sha256: string }> {
  const base = "https://raw.githubusercontent.com/EndstoneMC/bedrock-server-data/v2";
  const want = version === "" || version === "latest" ? null : version;
  const picked =
    want ??
    ((await fetchJson(fetchImpl, `${base}/versions.json`)) as { release: { latest: string } }).release.latest;
  const group = channel === "preview" ? "preview" : "release";
  const meta = (await fetchJson(fetchImpl, `${base}/${group}/${encodeURIComponent(picked)}/metadata.json`)) as {
    binary: Record<string, { url: string; sha256: string }>;
  };
  const os = process.platform === "win32" ? "windows" : "linux";
  const bin = meta.binary[os];
  if (!bin) throw new EngineError(`No Bedrock server build for ${os} at ${picked}`);
  return bin;
}

/**
 * PocketMine-MP the Pterodactyl way: server phar from the latest GitHub
 * release + a matching static PHP binary (PM5 builds) for this OS.
 * Windows and Linux x64 are covered; anything else refuses honestly.
 */
async function resolvePocketMine(
  fetchImpl: typeof fetch,
  version?: string,
): Promise<{ pharUrl: string; pharSha256?: string; phpUrl: string; phpSha256?: string; phpExt: string }> {
  const want = version && version !== "" && version !== "latest" ? `/tags/${encodeURIComponent(version)}` : "/latest";
  const release = (await fetchJson(
    fetchImpl,
    `https://api.github.com/repos/pmmp/PocketMine-MP/releases${want}`,
  )) as { assets: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const phar = release.assets.find((a) => a.name === "PocketMine-MP.phar");
  if (!phar) throw new EngineError("PocketMine-MP release has no phar asset");

  const phpTag = "pm5-php-8.4-latest";
  const phpRelease = (await fetchJson(
    fetchImpl,
    `https://api.github.com/repos/pmmp/PHP-Binaries/releases/tags/${phpTag}`,
  )) as { assets: Array<{ name: string; browser_download_url: string; digest?: string }> };
  const isWin = process.platform === "win32";
  const phpName = isWin ? "PHP-8.4-Windows-x64-PM5.zip" : "PHP-8.4-Linux-x86_64-PM5.tar.gz";
  const php = phpRelease.assets.find((a) => a.name === phpName);
  if (!php) throw new EngineError(`No PocketMine PHP build for this OS (${process.platform})`);
  return {
    pharUrl: phar.browser_download_url,
    pharSha256: assetDigest(phar.digest),
    phpUrl: php.browser_download_url,
    phpSha256: assetDigest(php.digest),
    phpExt: isWin ? ".zip" : ".tar.gz",
  };
}

/** GitHub asset digests look like "sha256:abc…"; pull the hex part. */
function assetDigest(digest: string | undefined): string | undefined {
  if (!digest) return undefined;
  const hex = digest.includes(":") ? digest.split(":")[1] : digest;
  return hex && /^[a-f0-9]{64}$/i.test(hex) ? hex.toLowerCase() : undefined;
}

/**
 * Endstone (`pip install endstone`, then `endstone`): needs Python 3.10+ on
 * the host. Installed globally by explicit admin choice (the blueprint is
 * opt-in experimental); the run command uses the `endstone` entrypoint.
 * Version pins pass straight through to pip.
 */
async function pipInstall(fetchImpl: typeof fetch, serverDir: string, pkg: string, version?: string): Promise<void> {
  void fetchImpl;
  void serverDir;
  const execFileAsync = promisify(execFileCb);
  const spec = version && version !== "" && version !== "latest" ? `${pkg}==${version}` : pkg;
  try {
    await execFileAsync("python", ["-m", "pip", "install", spec], {
      timeout: 10 * 60_000,
      windowsHide: true,
    });
  } catch (err) {
    throw new EngineError(
      `pip install ${spec} failed (needs Python 3.10+ on PATH): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Archive extraction with real zip-slip protection: `.tar.gz`/`.tgz` via tar,
 * `.zip` via unzip → 7z → tar (bsdtar covers Windows/macOS). `safe` must be
 * true, every member is listed and validated BEFORE extraction, and anything
 * absolute or escaping `dest` aborts the whole op. When no tool can even list
 * members, extraction is refused rather than done blind.
 */
async function extractArchive(src: string, serverDir: string, dest: string, strip: number, safe: boolean): Promise<void> {
  if (!safe) throw new EngineError("Refusing archive extraction without safe=true");
  const outDir = confine(serverDir, dest);
  mkdirSync(outDir, { recursive: true });
  const lower = src.toLowerCase();
  const execFileAsync = promisify(execFileCb);
  const runOut = async (cmd: string, args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(cmd, args, {
        timeout: 5 * 60_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      return String(stdout);
    } catch {
      return null;
    }
  };
  const runOk = async (cmd: string, args: string[]): Promise<boolean> => {
    try {
      await execFileAsync(cmd, args, { timeout: 5 * 60_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  };

  // List members with the same tool family that will extract, then validate.
  let members: string[] | null = null;
  let extract: ((archive: string, out: string) => Promise<boolean>) | null = null;
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const listing = await runOut("tar", ["-tzf", src]);
    if (listing !== null) {
      members = listing.split(/\r?\n/).filter((l) => l.length > 0);
      const stripArgs = strip > 0 ? [`--strip-components=${strip}`] : [];
      extract = (a, o) => runOk("tar", ["-xzf", a, "-C", o, ...stripArgs]);
    }
  } else if (lower.endsWith(".zip")) {
    const unzipList = await runOut("unzip", ["-Z1", src]);
    if (unzipList !== null) {
      members = unzipList.split(/\r?\n/).filter((l) => l.length > 0);
      extract = (a, o) => runOk("unzip", ["-q", "-o", a, "-d", o]);
    } else {
      const sevenList = await runOut("7z", ["l", "-slt", src]);
      if (sevenList !== null) {
        members = sevenList
          .split(/\r?\n/)
          .filter((l) => l.startsWith("Path = "))
          .map((l) => l.slice("Path = ".length).trim())
          .filter((l) => l.length > 0 && l !== src.split(/[\\/]/).pop());
        extract = (a, o) => runOk("7z", ["x", a, `-o${o}`, "-y"]);
      } else {
        const tarList = await runOut("tar", ["-tf", src]);
        if (tarList !== null) {
          members = tarList.split(/\r?\n/).filter((l) => l.length > 0);
          extract = (a, o) => runOk("tar", ["-xf", a, "-C", o]);
        }
      }
    }
  } else {
    throw new EngineError(`Unsupported archive format: ${src}`);
  }
  if (!members || !extract) {
    throw new EngineError(`Could not list archive members of ${src} (no suitable tool found)`);
  }
  for (const m of members) {
    // Strip tar's leading ./ the same way extraction sees it.
    const cleaned = strip > 0 ? stripLeading(m, strip) : m.replace(/^\.\//, "");
    if (cleaned === "" || cleaned === "." || cleaned.endsWith("/")) continue; // dir entries
    const resolved = resolve(outDir, cleaned);
    if (resolved !== outDir && !resolved.startsWith(outDir + sep)) {
      throw new EngineError(`Archive member escapes destination: ${m}`);
    }
  }
  if (!(await extract(src, outDir))) {
    throw new EngineError(`Could not extract ${src} (extraction failed after validation)`);
  }
}

/** Remove N leading path segments (mirrors tar --strip-components for validation). */
function stripLeading(member: string, n: number): string {
  const parts = member.replace(/^\.\//, "").split("/");
  return parts.slice(n).join("/");
}

/**
 * Modrinth addons (mods + plugins, the JTG-era workflow): resolve each project
 * to its newest compatible file for this server's loader + MC version and drop
 * the jar into `mods/` (loaders) or `plugins/` (paper-likes, velocity).
 * Vanilla has no mod platform and refuses honestly.
 */
export async function installModrinthProjects(
  fetchImpl: typeof fetch,
  ctx: InstallContext,
  projects: string[],
): Promise<void> {
  const slug = ctx.blueprintSlug ?? "";
  const platform = modrinthPlatform(slug);
  if (!platform) {
    throw new EngineError(`Modrinth addons are not supported on '${slug || "this blueprint"}'`);
  }
  const mcVersion = ctx.vars["mcVersion"];
  if (!mcVersion || mcVersion === "latest") {
    throw new EngineError("Pick an exact Minecraft version first (Startup tab), then add addons");
  }
  const dir = join(ctx.dir, platform.dir);
  mkdirSync(dir, { recursive: true });
  for (const project of projects) {
    const id = project.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(id)) {
      throw new EngineError(`Not a Modrinth project id: '${project}'`);
    }
    const versions = (await fetchJson(
      fetchImpl,
      `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version` +
        `?loaders=${encodeURIComponent(JSON.stringify(platform.loaders))}` +
        `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`,
    )) as Array<{
      files: Array<{ url: string; filename: string; hashes: { sha256?: string; sha512?: string }; primary: boolean }>;
    }>;
    const newest = versions[0];
    const file = newest?.files.find((f) => f.primary) ?? newest?.files[0];
    if (!file) throw new EngineError(`No ${mcVersion} file for '${id}' on Modrinth`);
    if (!/\.jar$/i.test(file.filename)) throw new EngineError(`Refusing non-jar addon '${file.filename}'`);
    // The filename comes from the network: strip separators and confine it.
    // A mismatch with the advertised name aborts rather than writing blind.
    const safeName = file.filename.replace(/[\\/]/g, "");
    if (safeName !== file.filename || safeName.includes("..")) {
      throw new EngineError(`Unsafe addon filename '${file.filename}'`);
    }
    await downloadFile(fetchImpl, file.url, confine(ctx.dir, `${platform.dir}/${safeName}`), {
      maxBytes: 256 * 1024 * 1024,
      sha512: file.hashes.sha512,
      sha256: file.hashes.sha256,
    });
  }
}

function modrinthPlatform(slug: string): { loaders: string[]; dir: string } | null {
  if (slug === "fabric") return { loaders: ["fabric"], dir: "mods" };
  if (slug === "forge") return { loaders: ["forge"], dir: "mods" };
  if (slug === "paper" || slug === "purpur")
    return { loaders: ["paper", "purpur", "spigot", "bukkit"], dir: "plugins" };
  if (slug === "velocity") return { loaders: ["velocity"], dir: "plugins" };
  return null;
}

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
