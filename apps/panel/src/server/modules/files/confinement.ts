import { realpathSync, lstatSync, Stats } from "node:fs";
import { join, resolve, dirname, parse, sep } from "node:path";

/** Thrown when any filesystem request would escape the server root (SEC-006). */
export class PathEscapeError extends Error {
  constructor(detail: string) {
    super(`path escapes server root: ${detail}`);
    this.name = "PathEscapeError";
  }
}

function withTrailingSep(p: string): string {
  return p.endsWith("/") || p.endsWith(sep) ? p : p + sep;
}

function isInside(rootReal: string, target: string): boolean {
  if (target === rootReal) return true;
  return target.startsWith(withTrailingSep(rootReal));
}

/**
 * THE single path-confinement utility (FR-060 / SEC-006).
 *
 * Every filesystem operation in the panel MUST resolve its user-supplied path through
 * this function. Guarantees:
 *  - absolute components and drive letters are stripped before joining (re-anchored);
 *  - `..` segments are rejected outright (no legitimate caller needs them);
 *  - each existing path segment is walked with lstat; symlinked segments are resolved
 *    via realpath and refused when the target leaves the REAL root (symlink escape).
 *
 * Returns an absolute, normalized path guaranteed to be within the server root's
 * realpath. Callers MUST use the return value, never their own join.
 */
export function confinePath(rootDir: string, requested: string): string {
  if (typeof requested !== "string") throw new PathEscapeError("non-string path");
  // NUL bytes are illegal on all supported filesystems and appear in injection payloads.
  if (requested.includes("\0")) throw new PathEscapeError("NUL byte");

  let rootReal: string;
  try {
    rootReal = realpathSync(rootDir);
  } catch {
    throw new PathEscapeError("root does not exist");
  }

  // Strip windows drive prefixes and leading separators so absolute inputs become relative.
  const parsed = parse(requested);
  let cleaned = requested;
  if (parsed.root) cleaned = requested.slice(parsed.root.length);

  const parts = cleaned.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new PathEscapeError(`parent segment in ${JSON.stringify(requested)}`);
  }

  let current = rootReal;
  for (const part of parts) {
    const next = join(current, part);
    let st: Stats | null = null;
    try {
      st = lstatSync(next);
    } catch {
      // does not exist yet - creation path; keep walking lexically
    }
    if (st && st.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(next);
      } catch {
        throw new PathEscapeError(`broken symlink at ${part}`);
      }
      if (!isInside(rootReal, real)) {
        throw new PathEscapeError(`symlink ${part} -> outside root`);
      }
      current = real;
    } else {
      current = next;
    }
  }

  const finalPath = resolve(current);
  // Deepest existing ancestor must be inside root.
  let probe = finalPath;
  while (!existsSafe(probe) && probe !== dirname(probe)) {
    probe = dirname(probe);
  }
  const probeReal = safeReal(probe);
  if (probeReal && !isInside(rootReal, probeReal)) {
    throw new PathEscapeError(`ancestor outside root`);
  }
  if (!isInside(rootReal, finalPath)) {
    throw new PathEscapeError(`result outside root`);
  }
  return finalPath;
}

function existsSafe(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function safeReal(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
