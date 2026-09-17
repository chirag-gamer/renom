#!/usr/bin/env tsx
/**
 * create-owner — first-admin bootstrap for installs and recovery.
 *
 * Used by install.sh after it writes .env. Refuses to run when any user
 * already exists: after setup, accounts are created by admins, never here.
 *
 * Usage:
 *   npx tsx src/server/cli/create-owner.ts --username admin --password '...' [--email a@b.c]
 */
import { resolve } from "node:path";
import { openAndMigrate } from "../infra/db/index.js";
import { UsersRepo } from "../modules/users/repo.js";
import { AuditService } from "../modules/audit/service.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const username = arg("username") ?? process.env.RENOM_ADMIN_USER;
  const password = arg("password") ?? process.env.RENOM_ADMIN_PASSWORD;
  const email = arg("email") ?? process.env.RENOM_ADMIN_EMAIL;
  const dataDir = arg("data-dir") ?? process.env.DATA_DIR ?? "./data";

  if (!username || !/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
    process.stderr.write("error: --username is required (3-32 chars: letters, digits, _ or -)\n");
    process.exit(2);
  }
  if (!password || password.length < 12) {
    process.stderr.write("error: --password is required (at least 12 characters)\n");
    process.exit(2);
  }

  const db = openAndMigrate(resolve(dataDir, "panel.db"));
  try {
    const users = new UsersRepo(db, 12);
    const audit = new AuditService(db);
    if (users.list({ limit: 1 }).length > 0) {
      process.stderr.write("error: users already exist — create further accounts as an admin\n");
      process.exit(1);
    }
    if (users.byUsername(username)) {
      process.stderr.write("error: username already taken\n");
      process.exit(1);
    }
    const owner = users.create({ username, password, email, role: "owner" });
    audit.record({ event: "setup.admin.created", actorUserId: owner.id, actorIp: "cli" });
    process.stdout.write(`owner_created username=${owner.username}\n`);
  } finally {
    db.close();
  }
}

main();
