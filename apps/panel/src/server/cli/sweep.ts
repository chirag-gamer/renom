/* Endpoint sweep (manual, NOT part of the suite): boots a real panel and calls
   EVERY route, reporting PASS/FAIL per endpoint. Run: npx tsx src/server/cli/sweep.ts */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPanel } from "../index.js";

const dir = mkdtempSync(join(tmpdir(), "renom-sweep-"));
const panel = buildPanel({
  NODE_ENV: "test",
  DATA_DIR: dir,
  LOG_LEVEL: "error",
  BCRYPT_COST: "10",
} as NodeJS.ProcessEnv);
const { ctx, server } = panel;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v3`;
const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let pass = 0;
let fail = 0;
const results: string[] = [];
async function call(
  name: string,
  method: string,
  path: string,
  want: number[],
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    fail++;
    results.push(`FAIL ${name}: fetch threw ${String(err)}`);
    return null;
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (want.includes(res.status)) {
    pass++;
  } else {
    fail++;
    results.push(
      `FAIL ${name}: want ${want.join("/")} got ${res.status} ${JSON.stringify(data)?.slice(0, 160)}`,
    );
  }
  return data;
}

const anon = (n: string, m: string, p: string, w: number[], b?: unknown) =>
  call(n, m, p, w, { body: b });
let T = "";
const auth = () => ({ token: T });

// --- setup + auth ---
const s = (await anon("setup/status", "GET", "/setup/status", [200])) as { needsSetup: boolean };
if (!s?.needsSetup) {
  fail++;
  results.push("FAIL setup/status: needsSetup not true");
} else pass++;
await anon("setup weak reject", "POST", "/setup/admin", [400], { username: "a", password: "x" });
await anon("setup/admin", "POST", "/setup/admin", [201], {
  username: "admin",
  password: "admin-password-1long",
});
await anon("setup closed", "POST", "/setup/admin", [409], {
  username: "second",
  password: "b-password-1long",
});
const login = (await anon("login", "POST", "/auth/login", [200], {
  username: "admin",
  password: "admin-password-1long",
})) as { token: string };
T = login.token;
await call("auth/me", "GET", "/auth/me", [200], auth());
await call("logout", "POST", "/auth/logout", [204], auth());

// --- users (admin) ---
const u1 = (await call("users create", "POST", "/users", [201], {
  ...auth(),
  body: { username: "bob", password: "bob-password-1long" },
})) as { user: { id: string } };
await call("users list", "GET", "/users", [200], auth());
await call("users patch", "PATCH", `/users/${u1.user.id}`, [200], {
  ...auth(),
  body: { displayName: "Bob" },
});
await call("users patch bad", "PATCH", `/users/${u1.user.id}`, [400], {
  ...auth(),
  body: { quotaMaxServers: -1 },
});

// --- api keys ---
const k1 = (await call("keys create", "POST", "/api-keys", [201], {
  ...auth(),
  body: { memo: "sweep", scopes: ["file.read"] },
})) as { token: string; key: { id: string } };
await call("keys list", "GET", "/api-keys", [200], auth());
await call("keys bad scope", "POST", "/api-keys", [400], { ...auth(), body: { scopes: ["nope"] } });

// --- servers ---
await anon("servers unauth", "GET", "/servers", [401]);
const srv = (await call("servers create paper", "POST", "/servers", [201], {
  ...auth(),
  body: { name: "sweep", blueprintSlug: "paper", eulaAccepted: true },
})) as { server: { id: string }; install: { state: string } };
if (!srv?.install || typeof srv.install.state !== "string") {
  fail++;
  results.push("FAIL servers create: missing install.state");
} else pass++;
const sid = srv.server.id;
await call("servers create no-eula", "POST", "/servers", [400], {
  ...auth(),
  body: { name: "noeula", blueprintSlug: "paper" },
});
await call("servers list", "GET", "/servers", [200], auth());
await call("servers get", "GET", `/servers/${sid}`, [200], auth());
await call("servers get 404", "GET", "/servers/does-not-exist", [404], auth());
await call("servers patch", "PATCH", `/servers/${sid}`, [200], {
  ...auth(),
  body: { description: "sweep server" },
});
await call("servers variables get", "GET", `/servers/${sid}/variables`, [200], auth());
await call("servers variables bad key", "PUT", `/servers/${sid}/variables`, [400], {
  ...auth(),
  body: { values: { nope: "x" } },
});
await call("servers variables put", "PUT", `/servers/${sid}/variables`, [200], {
  ...auth(),
  body: { values: { MOTD: "sweep motd" } },
});

// --- subusers / allocations / tunnel / addons (need a user + perms) ---
await call("subusers grant", "POST", `/servers/${sid}/users`, [201], {
  ...auth(),
  body: { username: "bob", permissions: ["file.read"] },
});
await call("subusers grant bad perm", "POST", `/servers/${sid}/users`, [400], {
  ...auth(),
  body: { username: "bob", permissions: ["fly"] },
});
await call("subusers list", "GET", `/servers/${sid}/users`, [200], auth());
await call("allocs list", "GET", `/servers/${sid}/allocations`, [200], auth());
const alloc = (await call("allocs add", "POST", `/servers/${sid}/allocations`, [201], {
  ...auth(),
  body: { ip: "127.0.0.1", port: 25570 },
})) as { allocation: { id: string } };
await call("allocs clash", "POST", `/servers/${sid}/allocations`, [409], {
  ...auth(),
  body: { ip: "127.0.0.1", port: 25570 },
});
await call("tunnel get empty", "GET", `/servers/${sid}/tunnel`, [200], auth());
await call("addons list", "GET", `/servers/${sid}/addons`, [200], auth());

// --- files ---
await call("files list", "GET", `/servers/${sid}/files`, [200], auth());
await call("files mkdir", "POST", `/servers/${sid}/files/mkdir`, [204], {
  ...auth(),
  body: { path: "data" },
});
await call("files write", "PUT", `/servers/${sid}/files/content`, [204], {
  ...auth(),
  body: { path: "data/note.txt", content: "hello" },
});
await call(
  "files read",
  "GET",
  `/servers/${sid}/files/content?path=${encodeURIComponent("data/note.txt")}`,
  [200],
  auth(),
);
await call("files rename", "POST", `/servers/${sid}/files/rename`, [204], {
  ...auth(),
  body: { from: "data/note.txt", to: "data/renamed.txt" },
});
await call("files delete", "POST", `/servers/${sid}/files/delete`, [204], {
  ...auth(),
  body: { path: "data/renamed.txt" },
});
await call(
  "files traversal",
  "GET",
  `/servers/${sid}/files/content?path=${encodeURIComponent("../../x")}`,
  [400, 404],
  auth(),
);

// --- backups + schedules ---
const bk = (await call("backups create", "POST", `/servers/${sid}/backups`, [201], {
  ...auth(),
  body: {},
})) as { backup: { id: string } };
await call("backups list", "GET", `/servers/${sid}/backups`, [200], auth());
await call(
  "backups restore",
  "POST",
  `/servers/${sid}/backups/${bk.backup.id}/restore`,
  [200],
  auth(),
);
const sch = (await call("schedules create", "POST", `/servers/${sid}/schedules`, [201], {
  ...auth(),
  body: { name: "s", cronExpr: "0 4 * * *", tasks: [{ action: "backup", payload: {} }] },
})) as { schedule: { id: string } };
await call("schedules list", "GET", `/servers/${sid}/schedules`, [200], auth());
await call("schedules bad cron", "POST", `/servers/${sid}/schedules`, [400], {
  ...auth(),
  body: { name: "bad", cronExpr: "x", tasks: [{ action: "backup", payload: {} }] },
});
await call(
  "schedules run",
  "POST",
  `/servers/${sid}/schedules/${sch.schedule.id}/run`,
  [200],
  auth(),
);

// --- blueprints ---
await call("blueprints list", "GET", "/blueprints", [200], auth());
await call("blueprints get", "GET", "/blueprints/paper", [200], auth());
await call("blueprints versions", "GET", "/blueprints/paper/versions", [200], auth());
await call("blueprints import unauth", "POST", "/blueprints/import", [401], { body: {} });

// --- power (paper jar missing here: start must fail honestly, stop idempotent) ---
await call("power start missing-jar", "POST", `/servers/${sid}/power`, [409], {
  ...auth(),
  body: { action: "start" },
});
await call("power stop offline", "POST", `/servers/${sid}/power`, [200], {
  ...auth(),
  body: { action: "stop" },
});
await call("power bad action", "POST", `/servers/${sid}/power`, [400], {
  ...auth(),
  body: { action: "launch" },
});
await call("console send offline", "POST", `/servers/${sid}/console/send`, [200], {
  ...auth(),
  body: { command: "hi" },
});
await call("console history", "GET", `/servers/${sid}/console/history`, [200], auth());

// --- suspend / unsuspend / delete lifecycle ---
await call("suspend", "POST", `/servers/${sid}/suspend`, [204], auth());
await call("suspended write blocked", "PUT", `/servers/${sid}/files/content`, [403], {
  ...auth(),
  body: { path: "x.txt", content: "y" },
});
await call("unsuspend", "POST", `/servers/${sid}/unsuspend`, [204], auth());
await call("subusers remove", "DELETE", `/servers/${sid}/users/${u1.user.id}`, [204], auth());
await call(
  "allocs release",
  "DELETE",
  `/servers/${sid}/allocations/${alloc.allocation.id}`,
  [204],
  auth(),
);
await call("backups delete", "DELETE", `/servers/${sid}/backups/${bk.backup.id}`, [204], auth());
await call(
  "schedules delete",
  "DELETE",
  `/servers/${sid}/schedules/${sch.schedule.id}`,
  [204],
  auth(),
);
await call("servers delete", "DELETE", `/servers/${sid}`, [204], auth());
await call("servers gone", "GET", `/servers/${sid}`, [404], auth());

// --- keys revoke + user suspend/delete + unknown route ---
await call("keys revoke", "DELETE", `/api-keys/${k1.key.id}`, [204], auth());
await call("users suspend", "PATCH", `/users/${u1.user.id}`, [200], {
  ...auth(),
  body: { suspended: true },
});
await call("users delete needs transfer?", "DELETE", `/users/${u1.user.id}`, [204], auth());
await call("unknown api 404", "GET", "/nope", [404], auth());
const healthz = await fetch(`${root}/healthz`);
if (healthz.status === 200) pass++;
else {
  fail++;
  results.push(`FAIL healthz: got ${healthz.status}`);
}

console.log(`\nSWEEP: ${pass} passed, ${fail} failed`);
for (const r of results) console.log(r);
server.close();
ctx.db.close();
process.exit(fail === 0 ? 0 : 1);
