#!/usr/bin/env tsx
/**
 * create-owner — first-admin bootstrap for installs and recovery.
 *
 * Used by install.sh after it writes .env. Refuses to run when any user
 * already exists: after setup, accounts are created by admins, never here.
 *
 * `--reset-password` is the escape hatch for a lost owner password: it
 * re-credentials the account named by `--username` and bumps its password
 * version, so every live session for that account dies with the old password.
 *
 * Usage:
 *   npx tsx src/server/cli/create-owner.ts --username admin --password '...' [--email a@b.c]
 *   npx tsx src/server/cli/create-owner.ts --check   # prints "yes" (users exist) or "no"
 *   npx tsx src/server/cli/create-owner.ts --username admin --reset-password --password '...'
 */
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { openAndMigrate } from "../infra/db/index.js";
import { UsersRepo } from "../modules/users/repo.js";
import { AuditService } from "../modules/audit/service.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Expected bootstrap refusal (vs. unexpected crash): message + exit code, no stack. */
class BootstrapRefused extends Error {}

function main(): void {
  const username = arg("username") ?? process.env.RENOM_ADMIN_USER;
  const password = arg("password") ?? process.env.RENOM_ADMIN_PASSWORD;
  const email = arg("email") ?? process.env.RENOM_ADMIN_EMAIL;
  const dataDir = arg("data-dir") ?? process.env.DATA_DIR ?? "./data";

  // SQLite does not create parent directories: a fresh DATA_DIR must exist first.
  mkdirSync(resolve(dataDir), { recursive: true });
  const db = openAndMigrate(resolve(dataDir, "panel.db"));
  try {
    const users = new UsersRepo(db, 12);
    const existing = users.list({ limit: 1 }).length > 0;
    if (hasFlag("check")) {
      process.stdout.write(existing ? "yes\n" : "no\n");
      return;
    }
    const audit = new AuditService(db);

    // Password reset is a distinct, auditable action: it targets an existing
    // account and never creates one, so it stays available when bootstrap does not.
    if (hasFlag("reset-password")) {
      const target = username ? users.byUsername(username) : null;
      if (!target) {
        process.stderr.write(`error: no such account '${username || ""}'\n`);
        process.exit(2);
      }
      if (!password || password.length < 12) {
        process.stderr.write("error: --password is required (at least 12 characters)\n");
        process.exit(2);
      }
      db.transaction(() => {
        users.setPassword(target.id, password);
        // Invalidate every existing session for this account: the old password
        // must stop working everywhere, not just at the next sign-in.
        users.bumpPasswordVersion(target.id);
        audit.record({
          event: "setup.admin.password_reset",
          actorUserId: target.id,
          actorIp: "cli",
        });
      });
      process.stdout.write(`password_reset username=${target.username}\n`);
      return;
    }
    if (!username || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
      process.stderr.write("error: --username is required (3-32 chars: letters, digits, _ or -)\n");
      process.exit(2);
    }
    if (!password || password.length < 12) {
      process.stderr.write("error: --password is required (at least 12 characters)\n");
      process.exit(2);
    }
    // Atomic bootstrap: existence check, insert, and audit in one transaction
    // so two concurrent invocations cannot mint two owners.
    let owner;
    try {
      owner = db.transaction(() => {
        if (users.list({ limit: 1 }).length > 0) throw new BootstrapRefused("users already exist");
        if (users.byUsername(username)) throw new BootstrapRefused("username already taken");
        const created = users.create({ username, password, email, role: "owner" });
        audit.record({ event: "setup.admin.created", actorUserId: created.id, actorIp: "cli" });
        return created;
      });
    } catch (err) {
      if (err instanceof BootstrapRefused) {
        process.stderr.write(`error: ${err.message} — create further accounts as an admin\n`);
        process.exit(1);
      }
      throw err;
    }
    process.stdout.write(`owner_created username=${owner.username}\n`);
  } finally {
    db.close();
  }
}

main();
