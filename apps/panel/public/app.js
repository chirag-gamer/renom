"use strict";
/* Renom web client — no build step. Talks to /api/v3 on the same origin. */
const API = "/api/v3";
const tokenKey = "renom.token";

const views = {
  setup: document.getElementById("view-setup"),
  login: document.getElementById("view-login"),
  home: document.getElementById("view-home"),
  server: document.getElementById("view-server"),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

function fail(el, message) {
  el.textContent = message;
  el.hidden = false;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body (204) */
  }
  return { status: res.status, data };
}

const store = {
  get token() {
    return sessionStorage.getItem(tokenKey);
  },
  set token(t) {
    if (t) sessionStorage.setItem(tokenKey, t);
    else sessionStorage.removeItem(tokenKey);
  },
};

let me = null;
let currentServer = null;
let socket = null;
let filesDir = "";

async function boot() {
  try {
    const { data } = await api("/setup/status");
    if (data && data.needsSetup) {
      document.getElementById("setup-token-wrap").hidden = !data.tokenRequired;
      show("setup");
      return;
    }
  } catch {
    /* setup endpoint unreachable — fall through to login */
  }
  if (store.token) {
    try {
      if (await loadHome()) return;
    } catch {
      // Stored session but unreachable panel (offline? restarted with a new
      // secret?): never leave a blank page — fall through to sign-in.
      store.token = null;
    }
  }
  show("login");
}

/* ---------- setup + login (unchanged behavior) ---------- */

document.getElementById("form-setup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("setup-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const { status, data } = await api("/setup/admin", {
      method: "POST",
      body: {
        username: fd.get("username"),
        password: fd.get("password"),
        email: fd.get("email") || undefined,
        setupToken: fd.get("setupToken") || undefined,
      },
    });
    if (status === 201) {
      e.target.reset();
      document.getElementById("login-error").hidden = true;
      show("login");
    } else if (status === 409) {
      fail(err, "Setup is already done — sign in instead.");
      show("login");
    } else {
      fail(err, describeProblem(status, data));
    }
  } catch {
    fail(err, "Couldn't reach the panel. Is it still starting up?");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("login-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const { status, data } = await api("/auth/login", {
      method: "POST",
      body: { username: fd.get("username"), password: fd.get("password") },
    });
    if (status === 200) {
      store.token = data.token;
      await loadHome();
    } else if (status === 429) {
      fail(err, "Too many tries — give it a minute, then try again.");
    } else {
      fail(err, "That didn't match. Check the username and password and try again.");
    }
  } catch {
    fail(err, "Couldn't reach the panel. Is it still starting up?");
  } finally {
    btn.disabled = false;
  }
});

/* ---------- home: servers + admin ---------- */

async function loadHome() {
  const { status, data } = await api("/auth/me", { token: store.token });
  if (status !== 200) {
    store.token = null;
    show("login");
    return false;
  }
  me = data.user;
  document.getElementById("home-greeting").textContent =
    `Welcome back, ${me.displayName || me.username}.`;
  await Promise.all([refreshServers(), refreshBlueprints()]);
  const adminPanel = document.getElementById("admin-panel");
  if (me.role === "owner" || me.role === "admin") {
    adminPanel.hidden = false;
    await refreshUsers();
  } else {
    adminPanel.hidden = true;
  }
  show("home");
  return true;
}

async function refreshServers() {
  const list = document.getElementById("server-list");
  const empty = document.getElementById("server-empty");
  const { status, data } = await api("/servers?limit=100", { token: store.token });
  list.innerHTML = "";
  if (status !== 200 || data.items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const s of data.items) {
    const li = document.createElement("li");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "linklike";
    link.textContent = s.name;
    link.addEventListener("click", () => openServer(s.id));
    const meta = document.createElement("span");
    meta.className = "role";
    const alloc = s.primaryAllocation
      ? ` · ${s.primaryAllocation.ip}:${s.primaryAllocation.port}`
      : "";
    meta.textContent = `${s.blueprintSlug} · ${s.status}${alloc}`;
    li.append(link, meta);
    list.append(li);
  }
}

async function refreshBlueprints() {
  const select = document.getElementById("blueprint-select");
  if (select.options.length > 0) return;
  const { status, data } = await api("/blueprints", { token: store.token });
  if (status !== 200) return;
  for (const b of data.items) {
    const opt = document.createElement("option");
    opt.value = b.slug;
    opt.textContent = `${b.name} (${b.slug})`;
    select.append(opt);
  }
}

document.getElementById("form-server").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("server-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const { status, data } = await api("/servers", {
    method: "POST",
    token: store.token,
    body: { name: fd.get("name"), blueprintSlug: fd.get("blueprint") },
  });
  if (status === 201) {
    e.target.reset();
    await refreshServers();
    openServer(data.server.id);
  } else {
    fail(err, describeProblem(status, data));
  }
});

async function refreshUsers() {
  const list = document.getElementById("user-list");
  list.innerHTML = "";
  // Follow every page: an admin list that silently drops accounts would be a lie.
  let cursor = null;
  for (;;) {
    const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const { status, data } = await api(`/users${qs}`, { token: store.token });
    if (status !== 200) return;
    for (const u of data.items) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = u.displayName || u.username;
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = u.role + (u.suspended ? " (suspended)" : "");
      li.append(name, role);
      list.append(li);
    }
    if (!data.nextCursor) return;
    cursor = data.nextCursor;
  }
}

document.getElementById("form-user").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("user-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  try {
    const { status, data } = await api("/users", {
      method: "POST",
      token: store.token,
      body: { username: fd.get("username"), password: fd.get("password"), role: fd.get("role") },
    });
    if (status === 201) {
      e.target.reset();
      await refreshUsers();
    } else {
      fail(err, describeProblem(status, data));
    }
  } catch {
    fail(err, "Couldn't reach the panel. Check it's running and try again.");
  }
});

document.getElementById("btn-signout").addEventListener("click", () => {
  store.token = null;
  me = null;
  show("login");
});

/* ---------- server detail ---------- */

document.getElementById("btn-back").addEventListener("click", async () => {
  leaveServer();
  await loadHome();
});

async function openServer(id) {
  const { status, data } = await api(`/servers/${id}`, { token: store.token });
  if (status !== 200) {
    await loadHome();
    return;
  }
  currentServer = data.server;
  filesDir = "";
  // Never carry another server's file into this one: a save after switching
  // servers must not write stale contents to the new server.
  document.getElementById("file-editing").textContent = "nothing open";
  document.getElementById("file-content").value = "";
  renderServerHeader();
  setTab("console");
  show("server");
  await Promise.all([
    refreshConsoleHistory(),
    refreshFiles(),
    refreshBackups(),
    refreshSchedules(),
  ]);
  joinConsoleSocket();
}

function leaveServer() {
  if (socket) {
    socket.close();
    socket = null;
  }
  currentServer = null;
}

function renderServerHeader() {
  const s = currentServer;
  document.getElementById("srv-name").textContent = s.name;
  const alloc = s.primaryAllocation
    ? `${s.primaryAllocation.ip}:${s.primaryAllocation.port}`
    : "no address yet";
  const runtime =
    s.runtimeState && s.runtimeState !== "offline" ? ` · running (${s.runtimeState})` : "";
  document.getElementById("srv-meta").textContent =
    `${s.blueprintSlug} · ${s.status}${runtime} · ${alloc}`;
}

document.querySelectorAll("#srv-power button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const err = document.getElementById("srv-error");
    err.hidden = true;
    const { status, data } = await api(`/servers/${currentServer.id}/power`, {
      method: "POST",
      token: store.token,
      body: { action: btn.dataset.power },
    });
    if (status !== 200) {
      fail(err, describeProblem(status, data));
      return;
    }
    const detail = await api(`/servers/${currentServer.id}`, { token: store.token });
    if (detail.status === 200) {
      currentServer = detail.data.server;
      renderServerHeader();
    }
  });
});

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

function setTab(name) {
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const t of ["console", "files", "backups", "schedules"]) {
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
}

/* ----- console ----- */

function appendLine(text) {
  const log = document.getElementById("console-log");
  log.textContent += (log.textContent ? "\n" : "") + text;
  const lines = log.textContent.split("\n");
  if (lines.length > 500) log.textContent = lines.slice(-500).join("\n");
  log.scrollTop = log.scrollHeight;
}

async function refreshConsoleHistory() {
  document.getElementById("console-log").textContent = "";
  const { status, data } = await api(`/servers/${currentServer.id}/console/history?limit=200`, {
    token: store.token,
  });
  if (status !== 200) {
    appendLine("(You don't have permission to see this server's console.)");
    return;
  }
  for (const l of data.lines) appendLine(l.text);
}

function joinConsoleSocket() {
  if (socket) socket.close();
  if (typeof window.io !== "function") {
    document.getElementById("console-note").textContent =
      "Live updates unavailable — refresh to see new output.";
    return;
  }
  socket = window.io({ path: "/socket.io/", auth: { token: store.token } });
  socket.on("console:line", (line) => appendLine(line.text));
  socket.emit("console:join", currentServer.id, (res) => {
    if (!res || !res.ok) {
      document.getElementById("console-note").textContent =
        res && res.reason === "suspended"
          ? "This server is suspended."
          : "Live updates unavailable.";
    }
  });
}

document.getElementById("form-console").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("console-input");
  const command = input.value.trim();
  if (!command) return;
  input.value = "";
  if (socket) {
    socket.emit("console:send", { serverId: currentServer.id, command });
    return;
  }
  await api(`/servers/${currentServer.id}/console/send`, {
    method: "POST",
    token: store.token,
    body: { command },
  });
});

/* ----- files ----- */

async function refreshFiles() {
  const list = document.getElementById("file-list");
  const err = document.getElementById("files-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(
    `/servers/${currentServer.id}/files?path=${encodeURIComponent(filesDir)}`,
    { token: store.token },
  );
  if (status !== 200) {
    fail(err, "You don't have permission to browse these files.");
    return;
  }
  document.getElementById("files-path").textContent = `/${filesDir}`;
  if (filesDir) {
    const up = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "linklike";
    btn.textContent = "← up";
    btn.addEventListener("click", () => {
      const parts = filesDir.split("/").filter(Boolean);
      parts.pop();
      filesDir = parts.join("/");
      refreshFiles();
    });
    up.append(btn);
    list.append(up);
  }
  for (const item of data.items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "linklike";
    btn.textContent = (item.isDir ? "📁 " : "") + item.name;
    btn.addEventListener("click", () => {
      const next = filesDir ? `${filesDir}/${item.name}` : item.name;
      if (item.isDir) {
        filesDir = next;
        refreshFiles();
      } else {
        openFile(next);
      }
    });
    const meta = document.createElement("span");
    meta.className = "role";
    meta.textContent = item.isDir ? "" : `${item.size} bytes`;
    li.append(btn, meta);
    list.append(li);
  }
}

async function openFile(path) {
  const err = document.getElementById("files-error");
  err.hidden = true;
  const { status, data } = await api(
    `/servers/${currentServer.id}/files/content?path=${encodeURIComponent(path)}`,
    { token: store.token },
  );
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  document.getElementById("file-editing").textContent = path;
  document.getElementById("file-content").value = data.content;
}

document.getElementById("form-file-read").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = new FormData(e.target).get("path");
  if (path) openFile(String(path));
});

document.getElementById("btn-file-save").addEventListener("click", async () => {
  const err = document.getElementById("files-error");
  err.hidden = true;
  const path = document.getElementById("file-editing").textContent;
  if (!path || path === "nothing open") {
    fail(err, "Open a file first, then save it.");
    return;
  }
  const content = document.getElementById("file-content").value;
  const { status, data } = await api(`/servers/${currentServer.id}/files/content`, {
    method: "PUT",
    token: store.token,
    body: { path, content },
  });
  if (status !== 204) fail(err, describeProblem(status, data));
  else {
    err.hidden = true;
    await refreshFiles();
  }
});

/* ----- backups ----- */

async function refreshBackups() {
  const list = document.getElementById("backup-list");
  const err = document.getElementById("backups-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/backups`, {
    token: store.token,
  });
  if (status !== 200) {
    fail(err, "You don't have permission to see backups.");
    return;
  }
  if (data.backups.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No backups yet. The first one is one click away.";
    list.append(li);
  }
  for (const b of data.backups) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const when = new Date(b.createdAt).toLocaleString();
    name.textContent = `${b.fileName} · ${Math.round(b.bytes / 1024)} KB · ${when}${b.locked ? " · locked" : ""}`;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "linklike";
    restore.textContent = "Restore";
    restore.addEventListener("click", async () => {
      if (
        !window.confirm(
          `Restore this backup? The server must be stopped, and current files will be replaced.`,
        )
      )
        return;
      const res = await api(`/servers/${currentServer.id}/backups/${b.id}/restore`, {
        method: "POST",
        token: store.token,
      });
      if (res.status !== 200) fail(err, describeProblem(res.status, res.data));
      else refreshBackups();
    });
    li.append(name, restore);
    list.append(li);
  }
}

document.getElementById("btn-backup").addEventListener("click", async () => {
  const err = document.getElementById("backups-error");
  err.hidden = true;
  const { status, data } = await api(`/servers/${currentServer.id}/backups`, {
    method: "POST",
    token: store.token,
    body: {},
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else refreshBackups();
});

/* ----- schedules ----- */

async function refreshSchedules() {
  const list = document.getElementById("schedule-list");
  const err = document.getElementById("schedules-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/schedules`, {
    token: store.token,
  });
  if (status !== 200) {
    fail(err, "You don't have permission to see schedules.");
    return;
  }
  if (data.schedules.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nothing scheduled. Nightly restarts and backups live here.";
    list.append(li);
  }
  for (const s of data.schedules) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "paused";
    name.textContent = `${s.name} · ${s.cronExpr} · next: ${next}`;
    const run = document.createElement("button");
    run.type = "button";
    run.className = "linklike";
    run.textContent = "Run now";
    run.addEventListener("click", async () => {
      const res = await api(`/servers/${currentServer.id}/schedules/${s.id}/run`, {
        method: "POST",
        token: store.token,
      });
      if (res.status !== 200) fail(err, describeProblem(res.status, res.data));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "linklike danger-text";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      const res = await api(`/servers/${currentServer.id}/schedules/${s.id}`, {
        method: "DELETE",
        token: store.token,
      });
      if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
      else refreshSchedules();
    });
    li.append(name, run, del);
    list.append(li);
  }
}

document.getElementById("form-schedule").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("schedules-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const action = fd.get("action");
  const tasks =
    action === "backup"
      ? [{ action: "backup", payload: {} }]
      : [{ action: "power", payload: { action } }];
  const { status, data } = await api(`/servers/${currentServer.id}/schedules`, {
    method: "POST",
    token: store.token,
    body: { name: fd.get("name"), cronExpr: fd.get("cron"), tasks },
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else {
    e.target.reset();
    refreshSchedules();
  }
});

function describeProblem(status, data) {
  const detail = data && data.error ? data.error.message : null;
  if (status === 400 || status === 422)
    return detail || "Something in the form needs fixing — check each field.";
  if (status === 403) return detail || "Your account isn't allowed to do that.";
  if (status === 404) return detail || "That doesn't exist (or you can't see it).";
  if (status === 409) return detail || "That conflicts with something that already exists.";
  return detail || "Something went wrong on our side. Try again.";
}

boot();
