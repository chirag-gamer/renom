import {
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { confinePath, PathEscapeError } from "./confinement.js";

export interface FileEntry {
  name: string;
  size: number;
  isDir: boolean;
  modifiedAt: number;
}

export class BinaryFileError extends Error {
  constructor(name: string) {
    super(`"${name}" appears to be binary and cannot be opened in the text editor`);
    this.name = "BinaryFileError";
  }
}

export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024; // FR-061: read(text <= 2MB)

/**
 * Fileservice — every operation goes through the confinement jail (FR-060).
 */
export class FilesService {
  list(serverRoot: string, relPath = ""): FileEntry[] {
    const dir = confinePath(serverRoot, relPath);
    const entries = readdirSync(dir, { withFileTypes: true });
    const out: FileEntry[] = [];
    for (const e of entries) {
      let size = 0;
      try {
        const st = statSync(join(dir, e.name));
        size = st.size;
      } catch {
        // broken link - report zeros
      }
      out.push({
        name: e.name,
        size: e.isFile() ? size : 0,
        isDir: e.isDirectory(),
        modifiedAt: safeMtime(join(dir, e.name)),
      });
    }
    return out.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
  }

  /** Read a UTF-8 text file with binary sniffing and hard byte cap (FR-061/064). */
  readText(serverRoot: string, relPath: string): { content: string; truncated: boolean } {
    const file = confinePath(serverRoot, relPath);
    const st = statSync(file);
    if (st.isDirectory()) throw new PathEscapeError("is a directory");
    const cap = MAX_TEXT_PREVIEW_BYTES;
    const fdBuf = readFileSync(file);
    if (looksBinary(fdBuf.subarray(0, Math.min(8192, fdBuf.length)))) {
      throw new BinaryFileError(basename(file));
    }
    if (fdBuf.length > cap) {
      return { content: fdBuf.subarray(0, cap).toString("utf8"), truncated: true };
    }
    return { content: fdBuf.toString("utf8"), truncated: false };
  }

  /** Write a text file atomically-ish (temp + rename within same dir). */
  writeText(serverRoot: string, relPath: string, content: string): void {
    const file = confinePath(serverRoot, relPath);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.renom-tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
  }

  createDirectory(serverRoot: string, relPath: string): void {
    const dir = confinePath(serverRoot, relPath);
    mkdirSync(dir, { recursive: true });
  }

  /** Rename/move within one server root (both endpoints confined). */
  rename(serverRoot: string, fromRel: string, toRel: string): void {
    const from = confinePath(serverRoot, fromRel);
    const to = confinePath(serverRoot, toRel);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
  }

  /** Delete a file or directory tree (confinement-checked). */
  remove(serverRoot: string, relPath: string): void {
    const target = confinePath(serverRoot, relPath);
    if (target === confinePath(serverRoot, "")) {
      throw new PathEscapeError("refusing to delete server root itself");
    }
    rmSync(target, { recursive: true });
  }

  resolve(serverRoot: string, relPath: string): string {
    return confinePath(serverRoot, relPath);
  }
}

function safeMtime(p: string): number {
  try {
    return Math.floor(statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

/** Heuristic: NUL bytes or >30% control chars in first 8KB => treat as binary (FR-064). */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let control = 0;
  for (const b of buf) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / buf.length > 0.3;
}
