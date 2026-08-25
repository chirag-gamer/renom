import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { confinePath, PathEscapeError } from "../../src/server/modules/files/confinement.js";
import { FilesService, looksBinary } from "../../src/server/modules/files/service.js";

let root: string;
let service: FilesService;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "renom-jail-"));
  mkdirSync(join(root, "world"), { recursive: true });
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "hello.txt"), "hello renom", "utf8");
  const outside = mkdtempSync(join(tmpdir(), "renom-outside-"));
  (globalThis as { __outsideDir?: string }).__outsideDir = outside;
  writeFileSync(join(outside, "secret.txt"), "top secret", "utf8");
  try {
    symlinkSync(outside, join(root, "evil-link"), "junction");
  } catch {
    symlinkSync(outside, join(root, "evil-link"));
  }
  service = new FilesService();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  const out = (globalThis as { __outsideDir?: string }).__outsideDir;
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("path confinement (SEC-006 / FR-060)", () => {
  it("resolves normal relative paths inside the root", () => {
    const p = confinePath(root, "world");
    expect(p.toLowerCase()).toContain("world");
  });

  it("rejects parent traversal outright", () => {
    expect(() => confinePath(root, "../outside")).toThrow(PathEscapeError);
    expect(() => confinePath(root, "sub/../../etc")).toThrow(PathEscapeError);
    expect(() => confinePath(root, "..\\..\\windows")).toThrow(PathEscapeError);
  });

  it("re-anchors absolute and drive-letter inputs inside the root (chroot semantics)", () => {
    const posix = confinePath(root, "/etc/passwd");
    expect(posix.startsWith(root)).toBe(true);
    const win = confinePath(root, "C:\\Windows\\system32");
    expect(win.startsWith(root)).toBe(true); // anchored under the jail
  });

  it("rejects NUL byte injection", () => {
    expect(() => confinePath(root, "hello.txt\0.png")).toThrow(PathEscapeError);
  });

  it("refuses symlink segments that point outside the root", () => {
    expect(() => confinePath(root, "evil-link/secret.txt")).toThrow(/symlink/);
    expect(() => service.readText(root, "evil-link/secret.txt")).toThrow();
  });

  it("allows creation paths under nonexistent directories that stay inside", () => {
    const p = confinePath(root, "newdir/nested/file.txt");
    expect(p.startsWith(root)).toBe(true);
    expect(existsSync(p)).toBe(false); // not created yet - just resolved
  });

  it("fuzz: generated adversarial paths never resolve outside the root", () => {
    const segments = [
      "..",
      "...",
      ".",
      "",
      "sub",
      "%2e%2e",
      "%252e%252e",
      "....//",
      "....\\\\",
      "con",
      "nul",
      "a b",
      "üñî",
    ];
    let escapes = 0;
    for (let i = 0; i < 3000; i++) {
      const depth = 1 + ((i * 7919) % 5);
      let candidate = "";
      for (let d = 0; d < depth; d++) {
        const s = segments[(i * 31 + d * 17) % segments.length]!;
        candidate += (d > 0 ? "/" : "") + s;
      }
      try {
        const resolved = confinePath(root, candidate);
        const normRoot = root.replace(/\\/g, "/");
        const normRes = resolved.replace(/\\/g, "/");
        if (!normRes.startsWith(normRoot)) escapes++;
      } catch (err) {
        if (!(err instanceof PathEscapeError)) throw err; // only confinement rejections allowed
      }
    }
    expect(escapes).toBe(0);
  });
});

describe("files service", () => {
  it("lists entries sorted dirs-first", () => {
    const items = service.list(root, "");
    const names = items.map((i) => i.name);
    expect(names).toContain("hello.txt");
    expect(names.indexOf("sub")).toBeLessThan(names.indexOf("hello.txt"));
  });

  it("reads and writes text atomically", () => {
    service.writeText(root, "world/out.txt", "written via service");
    expect(service.readText(root, "world/out.txt").content).toBe("written via service");
    const names = service.list(root, "world").map((n) => n.name);
    expect(names.some((n) => n.includes(".renom-tmp-"))).toBe(false);
  });

  it("flags binary content instead of opening garbage in the editor (FR-064)", () => {
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]));
    expect(() => service.readText(root, "bin.dat")).toThrow(/binary/i);
    expect(looksBinary(Buffer.from([0x00, 0x01, 0x02]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text file"))).toBe(false);
  });

  it("rename stays confined on both endpoints", () => {
    service.writeText(root, "sub/a.txt", "A");
    service.rename(root, "sub/a.txt", "sub/b.txt");
    expect(service.readText(root, "sub/b.txt").content).toBe("A");
    expect(() => service.rename(root, "sub/b.txt", "../escape.txt")).toThrow();
  });

  it("delete refuses to remove the server root itself", () => {
    expect(() => service.remove(root, "")).toThrow(/root/);
    expect(existsSync(join(root, "hello.txt"))).toBe(true);
  });
});
