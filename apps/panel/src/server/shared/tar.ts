import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The tar binary every archive operation uses (backups, file manager,
 * swapper pre-swap archives).
 *
 * On Windows the PATH order decides what bare `tar` resolves to: a Git-for-
 * Windows install ahead of System32 yields GNU tar, which reads `-czf
 * D:/path/out.tar.gz` as "connect to remote host D" and fails every archive
 * with a drive-letter destination. System32's bsdtar handles Windows paths
 * natively and ships with every Windows 10+ install, so it is pinned
 * explicitly when present; everywhere else PATH resolution stands.
 */
export function tarBinary(): string {
  if (process.platform === "win32") {
    const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(systemTar)) return systemTar;
  }
  return "tar";
}
