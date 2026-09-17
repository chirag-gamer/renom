/* Manual real-boot probe (NOT part of the suite): downloads real Paper,
   installs, boots, prints console. Run: npx tsx src/server/cli/realboot.ts
   Set MC_VERSION to pick a version (default: latest stable). */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../index.js";
import { runInstallOps } from "../modules/runtime/install.js";
import { BlueprintRegistry } from "../modules/blueprints/registry.js";

const dir = mkdtempSync(join(tmpdir(), "renom-realboot-"));
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
const bp = registry.lookup("paper");
const doc = registry.getDoc("paper");
const mcVersion = process.env.MC_VERSION ?? "1.21.1";

const created = ctx.servers.create({
  name: "realpaper",
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
const vars: Record<string, string> = {
  mcVersion,
  MOTD: "Renom real boot",
  maxMemory: "1024",
  initMemory: "512",
};
vars["allocation.ip"] = alloc.ip;
vars["allocation.port"] = String(alloc.port);

console.log("installing paper", mcVersion, "...");
await runInstallOps(doc, { serverId: created.id, dir: serverDir, vars });
console.log("installed. starting...");
await ctx.engine.start(created.id);
const deadline = Date.now() + 180_000;
let booted = false;
while (Date.now() < deadline) {
  const lines = ctx.engine.history(created.id, 200);
  const done = lines.find((l) => l.text.includes("Done ("));
  if (done) {
    booted = true;
    console.log("BOOTED:", done.text);
    break;
  }
  const err = lines.find((l) => /error|exception|failed/i.test(l.text));
  if (err) console.log("log:", err.text);
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(booted ? "SUCCESS: server booted" : "TIMEOUT/FAILURE: no Done line");
for (const l of ctx.engine.history(created.id, 8)) console.log("tail:", l.text);
await ctx.engine.stop(created.id).catch(() => undefined);
await ctx.engine.kill(created.id).catch(() => undefined);
ctx.db.close();
process.exit(booted ? 0 : 1);
