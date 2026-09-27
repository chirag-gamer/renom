/* Manual Endstone boot probe (NOT part of the suite). Run: npx tsx src/server/cli/realboot-endstone.ts */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../index.js";
import { runInstallOps } from "../modules/runtime/install.js";
import { BlueprintRegistry } from "../modules/blueprints/registry.js";

const dir = mkdtempSync(join(tmpdir(), "renom-endstone-"));
console.log("data:", dir);
const panel = buildPanel({
  NODE_ENV: "test",
  DATA_DIR: dir,
  LOG_LEVEL: "error",
  BCRYPT_COST: "10",
} as NodeJS.ProcessEnv);
const { ctx } = panel;
const owner = ctx.users.create({ username: "root", password: "root-password-1", role: "owner" });
const registry = new BlueprintRegistry(ctx.db);
const bp = registry.lookup("endstone");
const doc = registry.getDoc("endstone");

const created = ctx.servers.create({
  name: "realendstone",
  description: "",
  ownerId: owner.id,
  blueprintId: bp.id,
  versionTag: doc.tag,
  imageRef: doc.image,
  memoryMb: 1024,
  diskQuotaMb: 5120,
});
const serverDir = join(dir, "servers", created.id);
const alloc = ctx.servers.primaryAllocation(created.id)!;
const vars: Record<string, string> = { MOTD: "Renom Endstone" };
vars["allocation.ip"] = alloc.ip;
vars["allocation.port"] = String(alloc.port);

console.log("installing endstone (pip)...");
await runInstallOps(doc, { serverId: created.id, dir: serverDir, vars, blueprintSlug: "endstone" });
ctx.servers.setStatus(created.id, "ready");
console.log("installed. starting...");
await ctx.engine.start(created.id);
const deadline = Date.now() + 240_000;
let booted = false;
while (Date.now() < deadline) {
  const lines = ctx.engine.history(created.id, 200);
  const ready = lines.find((l) =>
    /Server started|Done \(|Loading level|Starting server/i.test(l.text),
  );
  if (ready) {
    booted = true;
    console.log("BOOTED:", ready.text);
    break;
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(booted ? "SUCCESS: endstone booted" : "TIMEOUT/FAILURE");
for (const l of ctx.engine.history(created.id, 12)) console.log("tail:", l.text);
await ctx.engine.kill(created.id).catch(() => undefined);
ctx.db.close();
process.exit(booted ? 0 : 1);
