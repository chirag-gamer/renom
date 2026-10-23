import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { confinePath } from "./confinement.js";

const execFileAsync = promisify(execFileCb);

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/** Remove N leading path segments (mirrors tar --strip-components for validation). */
export function stripLeading(member: string, n: number): string {
  const parts = member.replace(/^\.\//, "").split("/");
  return parts.slice(n).join("/");
}

/**
 * Safe archive extraction with zip-slip protection.
 * Supports .tar.gz, .tgz, .tar, .zip.
 */
export async function extractArchiveSafe(
  src: string,
  serverDir: string,
  dest: string,
  strip = 0,
  safe = true,
): Promise<void> {
  if (!safe) throw new ArchiveError("Refusing archive extraction without safe=true");
  const outDir = confinePath(serverDir, dest);
  mkdirSync(outDir, { recursive: true });
  const lower = src.toLowerCase();

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

  let members: string[] | null = null;
  let extract: ((archive: string, out: string) => Promise<boolean>) | null = null;

  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    const listing = await runOut("tar", ["-tzf", src]);
    if (listing !== null) {
      members = listing.split(/\r?\n/).filter((l) => l.length > 0);
      const stripArgs = strip > 0 ? [`--strip-components=${strip}`] : [];
      extract = (a, o) => runOk("tar", ["-xzf", a, "-C", o, ...stripArgs]);
    }
  } else if (lower.endsWith(".tar")) {
    const listing = await runOut("tar", ["-tf", src]);
    if (listing !== null) {
      members = listing.split(/\r?\n/).filter((l) => l.length > 0);
      const stripArgs = strip > 0 ? [`--strip-components=${strip}`] : [];
      extract = (a, o) => runOk("tar", ["-xf", a, "-C", o, ...stripArgs]);
    }
  } else if (lower.endsWith(".zip")) {
    if (strip > 0) {
      throw new ArchiveError("strip-components is not supported for zip archives");
    }
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
    throw new ArchiveError(`Unsupported archive format: ${src}`);
  }

  if (!members || !extract) {
    throw new ArchiveError(`Could not list archive members of ${src} (no suitable tool found)`);
  }

  for (const m of members) {
    const cleaned = strip > 0 ? stripLeading(m, strip) : m.replace(/^\.\//, "");
    if (cleaned === "" || cleaned === "." || cleaned.endsWith("/")) continue;
    const resolved = resolve(outDir, cleaned);
    if (resolved !== outDir && !resolved.startsWith(outDir + sep)) {
      throw new ArchiveError(`Archive member escapes destination: ${m}`);
    }
  }

  let staging = "";
  try {
    staging = mkdtempSync(join(tmpdir(), "renom-extract-"));
    if (!(await extract(src, staging))) {
      throw new ArchiveError(`Could not extract ${src} (extraction failed after validation)`);
    }

    const checkNoLinks = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          throw new ArchiveError(`Archive member is a symbolic link: ${entry.name}`);
        }
        if (st.isDirectory()) {
          checkNoLinks(full);
        }
      }
    };
    checkNoLinks(staging);

    confinePath(serverDir, dest);
    cpSync(staging, outDir, { recursive: true, verbatimSymlinks: false });
  } finally {
    if (staging) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  }
}

/**
 * Creates a .tar.gz archive of the specified files in baseRelDir.
 */
export async function createArchive(
  serverRoot: string,
  baseRelDir: string,
  files: string[],
  archiveRelName?: string,
): Promise<string> {
  if (files.length === 0) {
    throw new ArchiveError("No files specified for compression");
  }
  const baseDir = confinePath(serverRoot, baseRelDir);
  const cleanFiles: string[] = [];

  for (const f of files) {
    const raw = f.trim();
    if (!raw) continue;
    // Each target item must be confined inside baseDir
    const full = confinePath(baseDir, raw);
    // Relative name from baseDir for tar
    const rel = relative(baseDir, full).replace(/\\/g, "/");
    cleanFiles.push(rel);
  }

  if (cleanFiles.length === 0) {
    throw new ArchiveError("No valid files specified for compression");
  }

  const archiveName = archiveRelName?.trim()
    ? archiveRelName.trim().endsWith(".tar.gz")
      ? archiveRelName.trim()
      : `${archiveRelName.trim()}.tar.gz`
    : `archive-${Date.now()}.tar.gz`;

  const archivePath = confinePath(baseDir, archiveName);

  try {
    await execFileAsync("tar", ["-czf", archivePath, "-C", baseDir, "--", ...cleanFiles], {
      timeout: 5 * 60_000,
      windowsHide: true,
    });
  } catch (err) {
    throw new ArchiveError(
      `Compression failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Return relative path to serverRoot
  const normBase = baseRelDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normBase ? `${normBase}/${archiveName}` : archiveName;
}
