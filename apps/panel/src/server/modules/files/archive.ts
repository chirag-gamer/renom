import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { confinePath } from "./confinement.js";
import { tarBinary } from "../../shared/tar.js";

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
 * Options for {@link extractArchiveSafe}.
 *
 * `allowSymlinks` is a VENDOR-ONLY escape hatch. User-uploaded archives keep
 * the default refusal: SPEC FR-020.3 / SEC-008 make a symlink member an
 * outright error, because a link is how an archive escapes its directory.
 * Vendor runtimes are a different case — the PocketMine PHP tarball ships 24
 * links (e.g. `bin/php7/bin/libpng-config -> libpng16-config`, verified
 * 2026-10-29) and refusing them made every PocketMine install fail. When
 * enabled, a link is only honoured if it is relative and resolves to a
 * REGULAR FILE inside the staging tree; anything else is dropped. A link is
 * never written into `dest`, so nothing that survives can point outside it.
 */
export interface ExtractOptions {
  allowSymlinks?: boolean;
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
  options: ExtractOptions = {},
): Promise<void> {
  if (!safe) throw new ArchiveError("Refusing archive extraction without safe=true");
  const outDir = confinePath(serverDir, dest);
  mkdirSync(outDir, { recursive: true });
  const lower = src.toLowerCase();
  const allowSymlinks = options.allowSymlinks === true;

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
    const listing = await runOut(tarBinary(), ["-tzf", src]);
    if (listing !== null) {
      members = listing.split(/\r?\n/).filter((l) => l.length > 0);
      const stripArgs = strip > 0 ? [`--strip-components=${strip}`] : [];
      extract = (a, o) => runOk(tarBinary(), ["-xzf", a, "-C", o, ...stripArgs]);
    }
  } else if (lower.endsWith(".tar")) {
    const listing = await runOut(tarBinary(), ["-tf", src]);
    if (listing !== null) {
      members = listing.split(/\r?\n/).filter((l) => l.length > 0);
      const stripArgs = strip > 0 ? [`--strip-components=${strip}`] : [];
      extract = (a, o) => runOk(tarBinary(), ["-xf", a, "-C", o, ...stripArgs]);
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
        const tarList = await runOut(tarBinary(), ["-tf", src]);
        if (tarList !== null) {
          members = tarList.split(/\r?\n/).filter((l) => l.length > 0);
          extract = (a, o) => runOk(tarBinary(), ["-xf", a, "-C", o]);
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

    // A symlink is how an archive escapes its destination, so the default is
    // still refusal. Vendor runtimes legitimately ship links (the PocketMine
    // PHP tarball carries 24, including `bin/php7/bin/libpng-config`), and
    // refusing those broke every PocketMine install. Under the opt-in policy a
    // link is REPLACED BY THE FILE IT POINTS AT, in staging, and is never
    // written into `dest`; a link that does not resolve to a regular file
    // inside staging is dropped. Copying rather than linking means the
    // extracted tree holds no link at all, so nothing can point outside it.
    const materializeLinks = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          // resolve() does NOT dereference the final component, so a link
          // pointing at another link could pass the lexical check and then
          // statSync through to a host file. realpathSync dereferences fully;
          // containment is decided on the real path (and once the intermediate
          // link is removed, a second-hop copy would fail anyway).
          const target = resolve(dirname(full), readlinkSync(full));
          let real = "";
          try {
            real = realpathSync(target);
          } catch {
            real = "";
          }
          let realRoot = "";
          try {
            realRoot = realpathSync(staging);
          } catch {
            realRoot = staging;
          }
          const inside = real !== "" && (real === realRoot || real.startsWith(realRoot + sep));
          let resolvedIsFile = false;
          if (inside) {
            try {
              resolvedIsFile = statSync(real).isFile();
            } catch {
              resolvedIsFile = false;
            }
          }
          rmSync(full, { force: true });
          if (resolvedIsFile) copyFileSync(real, full);
          continue;
        }
        if (st.isDirectory()) materializeLinks(full);
      }
    };
    if (allowSymlinks) {
      materializeLinks(staging);
    } else {
      const checkNoLinks = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          const st = lstatSync(full);
          if (st.isSymbolicLink()) {
            throw new ArchiveError(`Archive member is a symbolic link: ${entry.name}`);
          }
          if (st.isDirectory()) checkNoLinks(full);
        }
      };
      checkNoLinks(staging);
    }

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
    await execFileAsync(tarBinary(), ["-czf", archivePath, "-C", baseDir, "--", ...cleanFiles], {
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
