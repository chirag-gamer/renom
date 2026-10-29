import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { BlueprintDoc, InstallOp } from "../blueprints/schema.js";
import { resolveJavaExecutable, substitute } from "./engine.js";
import { EngineError } from "../../shared/errors.js";
import { extractArchiveSafe, ArchiveError } from "../files/archive.js";

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
 * Hosts the panel may download from. Anything else — cloud metadata,
 * localhost admin ports, random mirrors — is refused before connecting.
 * Add a host here only with a pinned reason, never `*`.
 */
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "fill.papermc.io",
  "fill-data.papermc.io",
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launchermeta.mojang.com",
  "api.purpurmc.org",
  "cdn.purpurmc.org",
  "api.modrinth.com",
  "cdn.modrinth.com",
  "www.minecraft.net",
  "minecraft.net",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "raw.githubusercontent.com",
  // Mod-loader metadata and installers. Each is a single-purpose vendor host
  // for one documented artifact (Fabric meta/maven, Forge promotions/maven);
  // nothing here serves arbitrary files.
  "meta.fabricmc.net",
  "maven.fabricmc.net",
  "files.minecraftforge.net",
  "maven.minecraftforge.net",
  "maven.neoforged.net",
]);

function assertAllowedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EngineError(`Not a valid download URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new EngineError(`Downloads must use https: ${url}`);
  }
  if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new EngineError(`Download host not allowed: ${parsed.hostname}`);
  }
  return parsed;
}

/**
 * Fetch with manual redirect following (max 5 hops): every hop is
 * allowlisted, so a trusted host cannot bounce the panel onto an internal
 * address. Plain `fetch` follows redirects blindly.
 */
export async function guardedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: { timeoutMs: number },
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    assertAllowedUrl(current);
    const res = await fetchImpl(current, {
      signal: AbortSignal.timeout(init.timeoutMs),
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new EngineError(`Redirect without location: ${current}`);
      current = new URL(next, current).toString();
      continue;
    }
    return res;
  }
  throw new EngineError(`Too many redirects: ${url}`);
}

/**
 * Executes a blueprint's declarative install ops into the server directory.
 * Network-touching providers implemented: PaperMC Fill v3, Mojang
 * piston-meta, Purpur v2, Bedrock registry, PocketMine + PHP binaries,
 * Endstone via pip, Modrinth. `fabric`/`forge`/`neoforge`/`velocity`
 * fetchers are explicit 409s until wired — never silent no-ops.
 *
 * All file paths are confined to the server directory; downloads are size-
 * capped and always checksum-verified; destructive ops refuse the root itself.
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
        refuseRoot(ctx.dir, dest, op.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, substitute(op.contentTemplate, ctx.vars), "utf8");
        break;
      }
      case "move": {
        const from = confine(ctx.dir, sub(ctx.vars, op.from));
        const to = confine(ctx.dir, sub(ctx.vars, op.to));
        refuseRoot(ctx.dir, from, op.from);
        try {
          renameSync(from, to);
        } catch (err) {
          throw new EngineError(
            `Move failed (missing parent?): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      case "delete": {
        const dest = confine(ctx.dir, sub(ctx.vars, op.path));
        refuseRoot(ctx.dir, dest, op.path);
        rmSync(dest, { recursive: true, force: true });
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
        // Record the build we actually installed. "latest" cannot resolve
        // Modrinth addon files, and the version in use is the only one the
        // server is known to be compatible with. Only when this op was
        // templated from the variable: an imported blueprint may name its
        // version key differently, and persisting under `mcVersion` a value
        // the op never read would drive the Modrinth filter off a version
        // nothing is running.
        if (op.version === "{mcVersion}") ctx.vars["mcVersion"] = version;
        break;
      }
      case "fetch-vanilla": {
        const artifact = await resolveVanilla(fetchImpl, sub(ctx.vars, op.version));
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "server.jar"), {
          maxBytes: 512 * 1024 * 1024,
          sha1: artifact.sha1,
        });
        if (op.version === "{mcVersion}") ctx.vars["mcVersion"] = artifact.version;
        break;
      }
      case "fetch-purpur": {
        const artifact = await resolvePurpur(fetchImpl, sub(ctx.vars, op.version));
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "purpur.jar"), {
          maxBytes: 512 * 1024 * 1024,
          md5: artifact.md5,
        });
        if (op.version === "{mcVersion}") ctx.vars["mcVersion"] = artifact.version;
        break;
      }
      case "extract": {
        await extractArchive(
          confine(ctx.dir, sub(ctx.vars, op.src)),
          ctx.dir,
          sub(ctx.vars, op.dest),
          op.strip,
          op.safe,
          op.symlinks,
        );
        break;
      }
      case "chmod": {
        // Blueprints declare a POSIX mode so an extracted binary is runnable.
        // Windows has no permission bits; the op is a no-op there rather than
        // an install failure, which is what the BDS/PMMP providers do inline.
        if (process.platform !== "win32") {
          const dest = confine(ctx.dir, sub(ctx.vars, op.path));
          refuseRoot(ctx.dir, dest, op.path);
          chmodSync(dest, op.mode);
        }
        break;
      }
      case "template-render": {
        // `{VAR}` substitution into a file that already exists. Deliberately
        // not a read-modify-write of an arbitrary path: the source must be a
        // file this install produced, and the destination stays confined.
        const src = confine(ctx.dir, sub(ctx.vars, op.src));
        const dest = confine(ctx.dir, sub(ctx.vars, op.dest));
        refuseRoot(ctx.dir, dest, op.dest);
        if (!existsSync(src)) throw new EngineError(`template-render source is missing: ${op.src}`);
        const text = readFileSync(src, "utf8");
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, substitute(text, ctx.vars), "utf8");
        break;
      }
      case "fetch-fabric": {
        await installFabric(fetchImpl, ctx, sub(ctx.vars, op.mcVersion), op.loaderVersion);
        break;
      }
      case "fetch-forge": {
        await installForge(fetchImpl, ctx, sub(ctx.vars, op.mcVersion));
        break;
      }
      case "fetch-neoforge": {
        await installNeoForge(fetchImpl, ctx, sub(ctx.vars, op.mcVersion));
        break;
      }
      case "fetch-velocity": {
        const artifact = await resolveVelocity(fetchImpl, sub(ctx.vars, op.version));
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "velocity.jar"), {
          maxBytes: 256 * 1024 * 1024,
          sha256: artifact.sha256,
        });
        // Deliberately no mcVersion write-back: the proxy build number is
        // not a Minecraft version, and storing it there made every plugin
        // search filter on game_versions=<build> and return zero hits.
        break;
      }
      case "fetch-bds": {
        const artifact = await resolveBds(fetchImpl, sub(ctx.vars, op.version ?? ""), op.channel);
        await downloadFile(fetchImpl, artifact.url, join(ctx.dir, "bedrock-server.zip"), {
          maxBytes: 256 * 1024 * 1024,
          sha256: artifact.sha256,
        });
        await extractArchive(join(ctx.dir, "bedrock-server.zip"), ctx.dir, ".", 0, true);
        rmSync(join(ctx.dir, "bedrock-server.zip"), { force: true });
        // On Linux, the bedrock_server binary requires execute permissions
        const bdsBinary = confine(ctx.dir, "bedrock_server");
        if (existsSync(bdsBinary) && process.platform !== "win32") {
          chmodSync(bdsBinary, 0o755);
        }
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
        // The Linux tarball ships ~24 relative symlinks (libpng-config and
        // friends); the default policy refuses any link, so vendor archives
        // opt into materialization (see extractArchiveSafe).
        await extractArchive(
          join(ctx.dir, "php-runtime" + pmmp.phpExt),
          ctx.dir,
          ".",
          0,
          true,
          "materialize",
        );
        rmSync(join(ctx.dir, "php-runtime" + pmmp.phpExt), { force: true });
        // Layouts differ per OS (verified against the real artifacts):
        // Windows zip → bin/php/php.exe, Linux tarball → bin/php7/bin/php —
        // the path PMMP's own start.sh and the official Pterodactyl egg use.
        // The blueprint's run command is `{phpBinary}`, so persist it.
        const phpRel = process.platform === "win32" ? "bin/php/php" : "bin/php7/bin/php";
        // A zip carries no permission bits, so on Linux the interpreter would
        // extract non-executable and every start would fail with EACCES.
        // Windows archives ship php.exe — existsSync does not apply PATHEXT
        // to a path containing a directory separator, so probe the .exe.
        const phpProbe = process.platform === "win32" ? `${phpRel}.exe` : phpRel;
        const phpBinary = confine(ctx.dir, phpProbe);
        if (existsSync(phpBinary)) {
          if (process.platform !== "win32") chmodSync(phpBinary, 0o755);
        } else {
          throw new EngineError(
            `PocketMine PHP archive did not contain ${phpProbe} — refusing an install that cannot start`,
          );
        }
        ctx.vars["phpBinary"] = phpRel;
        break;
      }
      case "fetch-endstone": {
        // The engine derives the venv interpreter from the server directory,
        // so nothing absolute needs persisting here.
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

/** Destructive ops must name something inside the root, never the root itself. */
function refuseRoot(serverDir: string, resolved: string, rel: string): void {
  if (resolved === serverDir) {
    throw new EngineError(`Refusing to operate on the server root: ${rel}`);
  }
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  const res = await guardedFetch(fetchImpl, url, { timeoutMs: JSON_TIMEOUT_MS });
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
  const res = await guardedFetch(fetchImpl, url, { timeoutMs: FETCH_TIMEOUT_MS });
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
    ((await fetchJson(fetchImpl, `${base}/versions.json`)) as { release: { latest: string } })
      .release.latest;
  const group = channel === "preview" ? "preview" : "release";
  const meta = (await fetchJson(
    fetchImpl,
    `${base}/${group}/${encodeURIComponent(picked)}/metadata.json`,
  )) as {
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
): Promise<{
  pharUrl: string;
  pharSha256?: string;
  phpUrl: string;
  phpSha256?: string;
  phpExt: string;
}> {
  const want =
    version && version !== "" && version !== "latest"
      ? `/tags/${encodeURIComponent(version)}`
      : "/latest";
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
// --- mod loaders ---

/**
 * The JDK an installer and the server must share. An installer run under a
 * different major writes arguments the runtime cannot load, so both go through
 * the engine's own resolver. `mcVersion` drives auto-detection exactly as it
 * does at launch time.
 */
function javaFor(ctx: InstallContext): string {
  const java = resolveJavaExecutable(ctx.vars["javaVersion"], ctx.vars["mcVersion"]);
  if (!java) {
    throw new EngineError(
      `Java ${ctx.vars["javaVersion"] ?? "runtime"} is not installed on this host, so the mod loader cannot be installed`,
    );
  }
  return java;
}

/** Run java once, synchronously-reporting: installers are chatty on stdout. */
async function runJava(java: string, args: string[], cwd: string, label: string): Promise<void> {
  const execFileAsync = promisify(execFileCb);
  try {
    await execFileAsync(java, args, {
      cwd,
      timeout: 30 * 60_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    // execFile rejects with an Error carrying `stderr`; keep it, because the
    // installer's own message is the only useful part of the failure.
    let detail = "";
    if (err && typeof err === "object" && "stderr" in err) {
      detail = String(err.stderr ?? "").slice(-2000);
    }
    throw new EngineError(
      `${label} failed: ${err instanceof Error ? err.message : String(err)}${detail ? ` — ${detail}` : ""}`,
    );
  }
}

/** Read a maven `.sha1` sidecar. Any failure refuses instead of guessing. */
async function fetchSidecarSha1(fetchImpl: typeof fetch, url: string): Promise<string> {
  const res = await guardedFetch(fetchImpl, url, { timeoutMs: JSON_TIMEOUT_MS });
  if (!res.ok) throw new EngineError(`Checksum sidecar missing (${res.status}): ${url}`);
  const body = (await res.text()).trim();
  const hex = body.split(/\s+/)[0] ?? "";
  if (!/^[a-f0-9]{40}$/i.test(hex)) {
    throw new EngineError(`Checksum sidecar is not a sha1: ${url}`);
  }
  return hex.toLowerCase();
}

/**
 * Fabric, installed by Fabric's own installer rather than by copying a jar.
 *
 * `meta.fabricmc.net/v2/versions/loader/<mc>/<loader>/<installer>/server/jar`
 * looks tempting and is unusable here: it is a bootstrap that downloads the
 * vanilla jar and the loader libraries on FIRST START (its `install.properties`
 * only names the versions), and Fabric publishes no digest for it — probed
 * 2026-10-29: no `Digest`/`ETag` header and `/server/jar.sha1` 404s, so
 * `downloadFile`'s checksum rule cannot be satisfied.
 *
 * The installer jar is the verifiable path: maven.fabricmc.net publishes a
 * `.sha1` sidecar, and `server -downloadMinecraft` (verified on this host)
 * produces `fabric-server-launch.jar` + `libraries/` + `server.jar` with no
 * first-start network access.
 */
async function installFabric(
  fetchImpl: typeof fetch,
  ctx: InstallContext,
  mcVersion: string,
  loaderVersion?: string,
): Promise<void> {
  const mc = await resolveMinecraftVersion(fetchImpl, mcVersion);
  // Resolve "latest" to the concrete version BEFORE javaFor reads it, so the
  // installer JVM matches the runtime JVM the persisted version selects.
  ctx.vars["mcVersion"] = mc;
  const metaBase = "https://meta.fabricmc.net/v2/versions";
  // [0] is the newest stable loader for this game version.
  let loader = loaderVersion && loaderVersion !== "latest" ? loaderVersion : "";
  if (!loader) {
    const loaders = (await fetchJson(
      fetchImpl,
      `${metaBase}/loader/${encodeURIComponent(mc)}`,
    )) as Array<{ loader: { version: string; stable?: boolean } }>;
    const stable = loaders.find((l) => l.loader.stable !== false) ?? loaders[0];
    if (!stable) throw new EngineError(`Fabric has no loader for Minecraft ${mc}`);
    loader = stable.loader.version;
  }
  const installers = (await fetchJson(fetchImpl, `${metaBase}/installer`)) as Array<{
    version: string;
    url: string;
    stable?: boolean;
  }>;
  const installer = installers.find((i) => i.stable !== false) ?? installers[0];
  if (!installer) throw new EngineError("Fabric published no installer");

  const jarUrl = installer.url;
  const path = assertAllowedUrl(jarUrl).pathname;
  const jarDest = join(ctx.dir, ".renom", "fabric-installer.jar");
  await downloadFile(fetchImpl, jarUrl, jarDest, {
    maxBytes: 16 * 1024 * 1024,
    sha1: await fetchSidecarSha1(fetchImpl, `https://maven.fabricmc.net${path}.sha1`),
  });
  try {
    await runJava(
      javaFor(ctx),
      [
        "-jar",
        jarDest,
        "server",
        "-mcversion",
        mc,
        "-loader",
        loader,
        "-downloadMinecraft",
        "-dir",
        ctx.dir,
      ],
      ctx.dir,
      "Fabric installer",
    );
  } finally {
    rmSync(jarDest, { force: true });
  }
  const launchJar = join(ctx.dir, "fabric-server-launch.jar");
  if (!existsSync(launchJar)) {
    throw new EngineError("Fabric installer finished but produced no fabric-server-launch.jar");
  }
  ctx.vars["loaderVersion"] = loader;
}

/**
 * Forge, installed by `--installServer`.
 *
 * Two shapes here are load-bearing and were verified against the real
 * installer output on 2026-10-29:
 *
 *  - the module path is `libraries/net/minecraftforge/forge/<mc>-<loader>/`,
 *    carrying `unix_args.txt` and `win_args.txt` (NOT
 *    `<mc>-forge-args.txt`, which no Forge version ever writes), and
 *  - the generated `run.sh`/`run.bat` add `@user_jvm_args.txt`, so the panel
 *    must write that file or every launch fails on a missing argument file.
 *
 * `--installServer` also fetches the vanilla jar it patches, so no separate
 * vanilla download is needed.
 */
async function installForge(
  fetchImpl: typeof fetch,
  ctx: InstallContext,
  mcVersion: string,
): Promise<void> {
  const mc = await resolveMinecraftVersion(fetchImpl, mcVersion);
  // Concrete version before javaFor reads it — see installFabric.
  ctx.vars["mcVersion"] = mc;
  const promos = (await fetchJson(
    fetchImpl,
    "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
  )) as { promos?: Record<string, string> };
  const loader =
    promos.promos?.[`${mc}-latest`] ?? promos.promos?.[`${mc}-recommended`] ?? undefined;
  if (!loader) {
    throw new EngineError(
      `Forge publishes no ${mc} build (promotions_slim.json has no '${mc}-latest')`,
    );
  }
  const artifact = `forge-${mc}-${loader}-installer`;
  const base = `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(`${mc}-${loader}`)}/${artifact}`;
  const installerDest = join(ctx.dir, ".renom", "forge-installer.jar");
  await downloadFile(fetchImpl, `${base}.jar`, installerDest, {
    maxBytes: 64 * 1024 * 1024,
    sha1: await fetchSidecarSha1(fetchImpl, `${base}.jar.sha1`),
  });
  try {
    await runJava(
      javaFor(ctx),
      ["-jar", installerDest, "--installServer", ctx.dir],
      ctx.dir,
      "Forge installer",
    );
  } finally {
    rmSync(installerDest, { force: true });
  }
  writeForgeJvmArgs(ctx);
  const argsFile = forgeArgsFile(ctx.dir, mc, loader);
  if (!argsFile) {
    throw new EngineError(
      `Forge installer produced no args file under libraries/net/minecraftforge/forge/${mc}-${loader}`,
    );
  }
  // The run command is `@{forgeArgsFile}`; without this the substitution
  // leaves the literal token in argv and java dies on a missing argfile.
  ctx.vars["forgeArgsFile"] = argsFile;
  ctx.vars["loaderVersion"] = loader;
}

/** NeoForge: same installer protocol, its own maven and promotions feed. */
async function installNeoForge(
  fetchImpl: typeof fetch,
  ctx: InstallContext,
  mcVersion: string,
): Promise<void> {
  const mc = await resolveMinecraftVersion(fetchImpl, mcVersion);
  // Concrete version before javaFor reads it — see installFabric.
  ctx.vars["mcVersion"] = mc;
  const promos = (await fetchJson(
    fetchImpl,
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
  )) as { versions?: string[] };
  // NeoForge versions read "<mc minus leading 1.>.<build>" (21.1.80 for 1.21.1).
  // The list is ascending with -beta/-alpha entries first inside each series,
  // so a naive find() pins a prerelease whenever one exists; prefer the
  // newest stable build and only fall back to a prerelease when the series
  // has none yet.
  const parts = mc.split(".");
  const prefix = parts.length === 2 ? `${parts[1]}.0.` : `${parts[1]}.${parts[2]}.`;
  const stable = (promos.versions ?? []).filter((v) => v.startsWith(prefix) && !/[+-]/.test(v));
  const anySeries = (promos.versions ?? []).filter((v) => v.startsWith(prefix));
  const loader = stable.at(-1) ?? anySeries.at(-1);
  if (!loader) throw new EngineError(`NeoForge publishes no build for ${mc}`);
  const base = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(loader)}/neoforge-${loader}-installer`;
  const installerDest = join(ctx.dir, ".renom", "neoforge-installer.jar");
  await downloadFile(fetchImpl, `${base}.jar`, installerDest, {
    maxBytes: 64 * 1024 * 1024,
    sha1: await fetchSidecarSha1(fetchImpl, `${base}.jar.sha1`),
  });
  try {
    await runJava(
      javaFor(ctx),
      ["-jar", installerDest, "--installServer", ctx.dir],
      ctx.dir,
      "NeoForge installer",
    );
  } finally {
    rmSync(installerDest, { force: true });
  }
  writeForgeJvmArgs(ctx);
  ctx.vars["loaderVersion"] = loader;
}

/**
 * Forge's launcher scripts pass `@user_jvm_args.txt`. The installer ships the
 * file as a commented template; if it is missing, create it with the header
 * only. Flags deliberately stay OUT of it: the run command's own
 * `-Xms/-Xmx` come first and the @file expands in place after them, so flags
 * in the file would win and freeze the panel quota at whatever the first
 * install saw — memory changes on the plan would never apply.
 */
function writeForgeJvmArgs(ctx: InstallContext): void {
  const dest = join(ctx.dir, "user_jvm_args.txt");
  if (existsSync(dest)) return;
  writeFileSync(
    dest,
    "# Written by the Renom panel. RAM limits come from the run command,\n# not from this file.\n",
    "utf8",
  );
}

/** Relative Forge module-args path for this build, preferring the OS file. */
function forgeArgsFile(dir: string, mc: string, loader: string): string | null {
  const rel = `libraries/net/minecraftforge/forge/${mc}-${loader}`;
  const order =
    process.platform === "win32"
      ? [`${rel}/win_args.txt`, `${rel}/unix_args.txt`]
      : [`${rel}/unix_args.txt`, `${rel}/win_args.txt`];
  return order.find((candidate) => existsSync(join(dir, candidate))) ?? null;
}

/** Velocity, from PaperMC's Fill v3 (the API that actually serves it). */
async function resolveVelocity(
  fetchImpl: typeof fetch,
  version: string,
): Promise<{ url: string; sha256: string; version: string }> {
  const want = version.trim();
  let id = want;
  if (id === "" || id === "latest") {
    const list = (await fetchJson(
      fetchImpl,
      "https://fill.papermc.io/v3/projects/velocity/versions",
    )) as { versions: Array<{ version: { id: string } }> };
    // The list leads with the freshest (often -SNAPSHOT) build; a proxy on a
    // snapshot breaks every plugin's game_versions filter, so prefer the
    // newest stable tag.
    const stableList = (list.versions ?? []).filter(
      (v) => !/-(SNAPSHOT|pre|rc)/i.test(v.version.id),
    );
    const newest = (stableList[0] ?? list.versions?.[0])?.version?.id;
    if (!newest) throw new EngineError("PaperMC returned no Velocity versions");
    id = newest;
  }
  const builds = (await fetchJson(
    fetchImpl,
    `https://fill.papermc.io/v3/projects/velocity/versions/${encodeURIComponent(id)}/builds`,
  )) as Array<{
    channel: string;
    downloads: Record<string, { url: string; checksums: { sha256: string } }>;
  }>;
  const stable = builds.filter((b) => b.channel === "STABLE");
  const build = (stable.length > 0 ? stable : builds).at(-1);
  const dl = build?.downloads["server:default"];
  if (!dl) throw new EngineError(`No Velocity build found for ${id}`);
  return { url: dl.url, sha256: dl.checksums.sha256, version: id };
}

/**
 * Python package install, isolated per server.
 *
 * A bare `pip install` into the system interpreter fails on every current
 * Debian and Ubuntu (PEP 668 "externally-managed-environment"), which is why
 * Endstone reported `install_failed`. A virtualenv inside the server directory
 * is the blessed fix: it satisfies PEP 668, keeps each server independent, and
 * leaves the host interpreter untouched.
 *
 * Returns the venv's Python path so the blueprint can launch it instead of the
 * system one.
 */
async function pipInstall(
  fetchImpl: typeof fetch,
  serverDir: string,
  pkg: string,
  version?: string,
): Promise<string> {
  void fetchImpl;
  const execFileAsync = promisify(execFileCb);
  const venvDir = join(serverDir, ".renom", "venv");
  const isWindows = process.platform === "win32";
  const spec = version && version !== "" && version !== "latest" ? `${pkg}==${version}` : pkg;

  // A venv belongs to the interpreter that made it. If `python3` exists but
  // is too old for the package, its venv would be reused by the `python`
  // candidate and fail again, so each candidate builds its own venv.
  //
  // Windows order is deliberate. `python3` there is usually the Microsoft
  // Store execution alias: it exists on PATH, does nothing useful, and made
  // every Endstone install die with `spawn python ENOENT` style noise. The
  // `py` launcher is what the python.org installer registers system-wide, so
  // it goes first; the store alias goes last, best-effort.
  interface PyCandidate {
    exe: string;
    prefix?: string[];
    dir: string;
  }
  const candidates: PyCandidate[] = isWindows
    ? [
        { exe: "py", prefix: ["-3"], dir: join(venvDir, "py3") },
        { exe: "python", dir: join(venvDir, "py") },
        { exe: "python3", dir: join(venvDir, "py3") },
      ]
    : [
        { exe: "python3", dir: join(venvDir, "py3") },
        { exe: "python", dir: join(venvDir, "py") },
      ];
  const tried: string[] = [];
  for (const candidate of candidates) {
    // Endstone needs Python 3.10+; probe BEFORE building a venv so an old
    // system interpreter fails with a version message instead of a pip
    // resolver wall of text. `null` (probe itself failed) keeps the candidate.
    const versionArgs = ["-c", "import sys;print(sys.version_info.major, sys.version_info.minor)"];
    try {
      const { stdout } = await execFileAsync(
        candidate.exe,
        [...(candidate.prefix ?? []), ...versionArgs],
        {
          timeout: 15_000,
          windowsHide: true,
        },
      );
      const parts = String(stdout)
        .trim()
        .split(/\s+/)
        .map((p) => Number(p));
      const maj = parts[0] ?? NaN;
      const min = parts[1] ?? NaN;
      if (Number.isFinite(maj) && Number.isFinite(min)) {
        if (maj < 3 || (maj === 3 && min < 10)) {
          tried.push(`${candidate.exe}: Python ${maj}.${min} is too old (3.10+ needed)`);
          continue;
        }
      }
    } catch (err) {
      tried.push(`${candidate.exe} probe: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const interpreter = join(candidate.dir, isWindows ? "Scripts" : "bin", "python");
    if (!existsSync(interpreter)) {
      try {
        await execFileAsync(
          candidate.exe,
          [...(candidate.prefix ?? []), "-m", "venv", candidate.dir],
          {
            timeout: 5 * 60_000,
            windowsHide: true,
          },
        );
      } catch (err) {
        tried.push(`${candidate.exe} -m venv: ${err instanceof Error ? err.message : String(err)}`);
        // A half-made venv is worse than none: the engine picks the first
        // interpreter it finds, so leaving a broken one behind would make it
        // launch a venv that never got the package.
        rmSync(candidate.dir, { recursive: true, force: true });
        continue;
      }
    }
    try {
      await execFileAsync(
        interpreter,
        ["-m", "pip", "install", "--disable-pip-version-check", spec],
        { timeout: 15 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      );
      return interpreter;
    } catch (err) {
      tried.push(`${candidate.exe} (${spec}): ${err instanceof Error ? err.message : String(err)}`);
      // Drop the failed venv so the next candidate's success is what the
      // engine finds, and a retry starts from a clean state.
      rmSync(candidate.dir, { recursive: true, force: true });
    }
  }
  throw new EngineError(
    `Could not install ${spec} into a per-server virtualenv. Install Python 3.10+ (on Windows, the python.org build so the 'py' launcher is on PATH) and retry. Tried: ${tried.join(" | ")}`,
  );
}

/**
 * Archive extraction with real zip-slip protection: `.tar.gz`/`.tgz` via tar,
 * `.zip` via unzip → 7z → tar (bsdtar covers Windows/macOS). `safe` must be
 * true, every member is listed and validated BEFORE extraction, and anything
 * absolute or escaping `dest` aborts the whole op. When no tool can even list
 * members, extraction is refused rather than done blind.
 */
async function extractArchive(
  src: string,
  serverDir: string,
  dest: string,
  strip: number,
  safe: boolean,
  symlinks: "reject" | "materialize" = "reject",
): Promise<void> {
  try {
    await extractArchiveSafe(src, serverDir, dest, strip, safe, {
      allowSymlinks: symlinks === "materialize",
    });
  } catch (err) {
    if (err instanceof ArchiveError) {
      throw new EngineError(err.message);
    }
    throw err;
  }
}

let latestMcVersionCache: { version: string; expiresAt: number } | null = null;

export function clearResolvedMinecraftVersionCache(): void {
  latestMcVersionCache = null;
}

/**
 * Resolves a Minecraft version target. If the version is "latest" or empty,
 * it resolves the latest stable release from PaperMC (falling back to Vanilla manifest).
 * Results for "latest" are memoized for 30 minutes to reduce network roundtrips.
 */
export async function resolveMinecraftVersion(
  fetchImpl: typeof fetch,
  version?: string | null,
): Promise<string> {
  const v = version?.trim();
  if (v && v !== "" && v !== "latest") return v;
  const now = Date.now();
  if (latestMcVersionCache && latestMcVersionCache.expiresAt > now) {
    return latestMcVersionCache.version;
  }
  try {
    const resolved = await resolvePaperVersion(fetchImpl, "latest");
    latestMcVersionCache = { version: resolved, expiresAt: now + 30 * 60 * 1000 };
    return resolved;
  } catch {
    const vanilla = await resolveVanilla(fetchImpl, "latest");
    latestMcVersionCache = { version: vanilla.version, expiresAt: now + 30 * 60 * 1000 };
    return vanilla.version;
  }
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
  versionId?: string,
): Promise<{ downloaded: string[]; skipped: string[] }> {
  const slug = ctx.blueprintSlug ?? "";
  const platform = modrinthPlatform(slug);
  if (!platform) {
    throw new EngineError(`Modrinth addons are not supported on '${slug || "this blueprint"}'`);
  }
  let mcVersion = ctx.vars["mcVersion"];
  if (!mcVersion || mcVersion === "latest") {
    mcVersion = await resolveMinecraftVersion(fetchImpl, mcVersion);
    ctx.vars["mcVersion"] = mcVersion;
  }
  if (versionId && projects.length > 1) {
    throw new EngineError("Cannot specify versionId when installing multiple projects");
  }

  // Pre-validate all projects and versions before downloading to avoid partial installation
  const planned: Array<{
    id: string;
    file: {
      url: string;
      filename: string;
      hashes: { sha256?: string; sha512?: string };
    };
  }> = [];

  for (const project of projects) {
    const id = project.trim();
    // Modrinth project ids are case-sensitive base62 ('Vebnzrzj' is LuckPerms,
    // 'vebnzrzj' is nobody), so the id is used exactly as given. Lowercasing
    // it here 404'd every project whose id carries an uppercase letter.
    if (!/^[A-Za-z0-9][A-Za-z0-9-_]{1,63}$/.test(id)) {
      throw new EngineError(`Not a Modrinth project id: '${project}'`);
    }

    // A project is loaded only if it publishes a file for this server's
    // loader. Modrinth's `project_type` field cannot answer this: it reports
    // "mod" for every plugin (EssentialsX, LuckPerms, WorldEdit all say mod),
    // so an equality check against "plugin" rejected every real plugin. The
    // loader-filtered version list is the honest test — a Paper plugin has
    // paper/spigot builds, a Fabric mod does not.
    const versions = (await fetchJson(
      fetchImpl,
      `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version` +
        `?loaders=${encodeURIComponent(JSON.stringify(platform.loaders))}` +
        `&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`,
    )) as Array<{
      id: string;
      files: Array<{
        url: string;
        filename: string;
        hashes: { sha256?: string; sha512?: string };
        primary: boolean;
      }>;
    }>;
    if (versions.length === 0) {
      throw new EngineError(
        `Project '${id}' has no ${mcVersion} build for ${platform.loaders.join("/")}, ` +
          `so this ${platform.projectType === "plugin" ? "plugin server" : "mod loader"} cannot load it`,
      );
    }

    let chosenVersion: (typeof versions)[0] | undefined;
    if (versionId) {
      chosenVersion = versions.find((v) => v.id === versionId);
      if (!chosenVersion) {
        throw new EngineError(
          `Requested version '${versionId}' for '${id}' is not available for ${mcVersion}`,
        );
      }
    } else {
      chosenVersion = versions[0];
    }
    const file = chosenVersion?.files.find((f) => f.primary) ?? chosenVersion?.files[0];
    if (!file) throw new EngineError(`No ${mcVersion} file for '${id}' on Modrinth`);
    if (!/\.jar$/i.test(file.filename))
      throw new EngineError(`Refusing non-jar addon '${file.filename}'`);
    // The filename comes from the network: strip separators and confine it.
    // A mismatch with the advertised name aborts rather than writing blind.
    const safeName = file.filename.replace(/[\\/]/g, "");
    if (safeName !== file.filename || safeName.includes("..")) {
      throw new EngineError(`Unsafe addon filename '${file.filename}'`);
    }
    planned.push({
      id,
      file: { url: file.url, filename: safeName, hashes: file.hashes },
    });
  }

  const dir = join(ctx.dir, platform.dir);
  mkdirSync(dir, { recursive: true });

  const skipped: string[] = [];
  const downloaded: string[] = [];
  for (const item of planned) {
    const dest = confine(ctx.dir, `${platform.dir}/${item.file.filename}`);
    // Dedupe: re-installing something already present must not re-download
    // it (the reported duplicate-download bug). Same name + same hash means
    // the file is already in place; a hash mismatch means the installed copy
    // is a different build, and the fresh download replaces it. Modrinth
    // publishes sha512 + sha1 (never sha256), so sha512 is the real key.
    const wantHash = item.file.hashes.sha512 ?? item.file.hashes.sha256;
    if (wantHash && existsSync(dest)) {
      const algo = item.file.hashes.sha512 ? "sha512" : "sha256";
      const have = createHash(algo).update(readFileSync(dest)).digest("hex");
      if (have === wantHash.toLowerCase()) {
        skipped.push(item.file.filename);
        continue;
      }
    }
    await downloadFile(fetchImpl, item.file.url, dest, {
      maxBytes: 256 * 1024 * 1024,
      sha512: item.file.hashes.sha512,
      sha256: item.file.hashes.sha256,
    });
    downloaded.push(item.file.filename);
  }
  return { downloaded, skipped };
}

/** One search hit, narrowed to what the panel needs to render and install. */
export interface ModrinthHit {
  projectId: string;
  title: string;
  description: string;
  author: string;
  downloads: number;
  iconUrl?: string | null;
}

export interface ModrinthVersionInfo {
  id: string;
  name: string;
  versionNumber: string;
  versionType: string;
  datePublished: string;
  downloads: number;
  files: Array<{
    filename: string;
    url: string;
    size: number;
    primary: boolean;
  }>;
}

/**
 * Search Modrinth for projects this server can actually load.
 *
 * The `facets` parameter is Modrinth's filter language: each inner array is
 * OR'd, and separate arrays are AND'd. That is what hides projects the server
 * cannot run — a Fabric server never sees Paper plugins, and a server on
 * 1.20.1 never sees a 1.21-only mod. Checked against
 * https://docs.modrinth.com/api/operations/searchprojects/
 */
export async function searchModrinthProjects(
  fetchImpl: typeof fetch,
  platform: { loaders: string[]; projectType: "mod" | "plugin" },
  mcVersion: string,
  query: string,
  limit = 10,
  offset = 0,
): Promise<{ hits: ModrinthHit[]; totalHits: number }> {
  const resolvedVersion = await resolveMinecraftVersion(fetchImpl, mcVersion);
  const facets = [
    platform.loaders.map((loader) => `categories:${loader}`),
    [`versions:${resolvedVersion}`],
    [`project_type:${platform.projectType}`],
  ];
  const params = new URLSearchParams({
    query,
    facets: JSON.stringify(facets),
    index: "downloads",
    limit: String(Math.min(Math.max(limit, 1), 50)),
    offset: String(Math.max(offset, 0)),
  });
  const data = (await fetchJson(
    fetchImpl,
    `https://api.modrinth.com/v2/search?${params.toString()}`,
  )) as {
    total_hits?: number;
    hits: Array<{
      project_id: string;
      title: string;
      description: string;
      author: string;
      downloads: number;
      icon_url?: string | null;
    }>;
  };
  const hits = (data.hits ?? []).map((hit) => ({
    projectId: hit.project_id,
    title: hit.title,
    description: hit.description,
    author: hit.author,
    downloads: hit.downloads,
    iconUrl: hit.icon_url ?? null,
  }));
  return { hits, totalHits: data.total_hits ?? hits.length };
}

export async function fetchModrinthProjectVersions(
  fetchImpl: typeof fetch,
  platform: { loaders: string[]; projectType?: "mod" | "plugin" },
  mcVersion: string,
  projectId: string,
): Promise<ModrinthVersionInfo[]> {
  const id = projectId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-_]{1,63}$/.test(id)) {
    throw new EngineError(`Not a Modrinth project id: '${projectId}'`);
  }
  // No `project_type` check here either (see installModrinthProjects): that
  // field reads "mod" for plugins, so the loader-filtered list below is what
  // decides compatibility. An empty list means this server cannot load it.
  const resolvedVersion = await resolveMinecraftVersion(fetchImpl, mcVersion);
  const url =
    `https://api.modrinth.com/v2/project/${encodeURIComponent(id)}/version` +
    `?loaders=${encodeURIComponent(JSON.stringify(platform.loaders))}` +
    `&game_versions=${encodeURIComponent(JSON.stringify([resolvedVersion]))}`;
  const data = (await fetchJson(fetchImpl, url)) as Array<{
    id: string;
    name: string;
    version_number: string;
    version_type: string;
    date_published: string;
    downloads: number;
    files: Array<{
      filename: string;
      url: string;
      size: number;
      primary: boolean;
    }>;
  }>;
  return (data ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    versionType: v.version_type,
    datePublished: v.date_published,
    downloads: v.downloads,
    files: (v.files ?? []).map((f) => ({
      filename: f.filename,
      url: f.url,
      size: f.size,
      primary: f.primary,
    })),
  }));
}

/**
 * Loader set and target folder for a blueprint. `projectType` drives the
 * Modrinth search facet; `dir` is where the jar lands. Vanilla, Bedrock, and
 * the generic runtimes have no mod platform and return null so the UI can hide
 * the Addons tab entirely instead of offering something that cannot work.
 */
export function modrinthPlatform(
  slug: string,
): { loaders: string[]; dir: string; projectType: "mod" | "plugin" } | null {
  if (slug === "fabric") return { loaders: ["fabric"], dir: "mods", projectType: "mod" };
  if (slug === "forge") return { loaders: ["forge"], dir: "mods", projectType: "mod" };
  if (slug === "paper" || slug === "purpur")
    return {
      loaders: ["paper", "purpur", "spigot", "bukkit"],
      dir: "plugins",
      projectType: "plugin",
    };
  if (slug === "velocity") return { loaders: ["velocity"], dir: "plugins", projectType: "plugin" };
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
): Promise<{ url: string; sha1: string; version: string }> {
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
  return { url: detail.downloads.server.url, sha1: detail.downloads.server.sha1, version: id };
}

/**
 * Purpur, from the PurpurMC v2 API. Two details this API does not share with
 * Paper's Fill:
 *
 *  - the project key is `purpur`, not `paper` (`/v2/paper/<ver>` answers
 *    404 `{"error":"project not found"}`), and
 *  - `latest` is not a version path (`/v2/purpur/latest` 404s). The newest
 *    version is `metadata.current` on the project root, verified 2026-10-29
 *    against `/v2/purpur` → `metadata.current: "26.3"`.
 *
 * Build metadata (and the md5 this download is verified against) lives on the
 * per-build document, so the version document is only used for `builds.latest`.
 */
async function resolvePurpur(
  fetchImpl: typeof fetch,
  version: string,
): Promise<{ url: string; md5?: string; version: string }> {
  const base = "https://api.purpurmc.org/v2/purpur";
  let id = version.trim();
  if (id === "" || id === "latest") {
    const root = (await fetchJson(fetchImpl, base)) as {
      metadata?: { current?: string };
      versions?: string[];
    };
    const current = root.metadata?.current ?? root.versions?.at(-1);
    if (!current) throw new EngineError("Purpur returned no current version");
    id = current;
  }
  const info = (await fetchJson(fetchImpl, `${base}/${encodeURIComponent(id)}`)) as {
    version: string;
    builds: { latest: string };
  };
  const build = info.builds?.latest;
  if (!build) throw new EngineError(`Purpur has no builds for ${info.version}`);
  const detail = (await fetchJson(
    fetchImpl,
    `${base}/${encodeURIComponent(info.version)}/${encodeURIComponent(build)}`,
  )) as { md5?: string; result?: string };
  if (detail.result && detail.result !== "SUCCESS") {
    throw new EngineError(`Purpur build ${info.version}/${build} is ${detail.result}`);
  }
  return {
    url: `${base}/${encodeURIComponent(info.version)}/${encodeURIComponent(build)}/download`,
    md5: detail.md5,
    version: info.version,
  };
}
