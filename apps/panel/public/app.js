"use strict";
/* Renom web client — no build step. Talks to /api/v3 on the same origin. */
const API = "/api/v3";
const tokenKey = "renom.token";

const views = {
  setup: document.getElementById("view-setup"),
  login: document.getElementById("view-login"),
  home: document.getElementById("view-home"),
  admin: document.getElementById("view-admin"),
  account: document.getElementById("view-account"),
  "server-create": document.getElementById("view-server-create"),
  "user-detail": document.getElementById("view-user-detail"),
  api: document.getElementById("view-api"),
  server: document.getElementById("view-server"),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  const topbar = document.getElementById("app-topbar");
  if (topbar) topbar.hidden = name === "setup" || name === "login";
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle(
      "active",
      link.dataset.route === name ||
        ((name === "server-create" || name === "user-detail") && link.dataset.route === "admin") ||
        (name === "server" && link.dataset.route === "home"),
    );
  });
}

function setView(name, detailId = "") {
  const adminOnly = name === "admin" || name === "server-create" || name === "user-detail";
  if (adminOnly && me?.role !== "owner" && me?.role !== "admin") return;
  show(name);
  if (name === "admin") {
    setAdminSection(window.location.pathname.split("/")[2] || "users");
    void refreshUsers();
    void refreshAdminServers();
  }
  if (name === "server-create") {
    void refreshBlueprints();
    void refreshUsers();
  }
  if (name === "user-detail") void refreshUserDetail(detailId);
  if (name === "api") void refreshApiKeys();
  if (name === "account") renderAccount();
}

function setAdminSection(section) {
  const target = section === "servers" ? "servers" : "users";
  document.getElementById("admin-users-section").hidden = target !== "users";
  document.getElementById("admin-servers-section").hidden = target !== "servers";
  document.querySelectorAll("[data-admin-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.adminSection === target);
  });
}

function routePath(name) {
  if (name === "account") return "/account";
  if (name === "api") return "/api-keys";
  if (name === "admin") return "/admin";
  return "/";
}

async function navigate(path) {
  if (window.location.pathname !== path) history.pushState({}, "", path);
  await routeFromPath();
}

async function routeFromPath() {
  const path = window.location.pathname;
  if (path === "/login") {
    show("login");
    return;
  }
  if (path === "/register") {
    show("login");
    return;
  }
  const serverMatch = path.match(/^\/servers\/([^/]+)(?:\/([^/]+))?/);
  if (serverMatch) {
    await openServer(serverMatch[1], serverMatch[2] || "console", false);
    return;
  }
  if (currentServer) leaveServer();
  if (path === "/admin/servers/new") {
    if (me?.role !== "owner" && me?.role !== "admin") {
      await navigate("/");
      return;
    }
    setView("server-create");
    return;
  }
  const userMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    if (me?.role !== "owner" && me?.role !== "admin") {
      await navigate("/");
      return;
    }
    setView("user-detail", userMatch[1]);
    return;
  }
  if (path.startsWith("/admin")) {
    if (me?.role !== "owner" && me?.role !== "admin") {
      await navigate("/");
      return;
    }
    setView("admin");
    return;
  }
  if (path === "/account") {
    setView("account");
    return;
  }
  if (path === "/api-keys") {
    setView("api");
    return;
  }
  setView("home");
}

function renderAccount() {
  const target = document.getElementById("account-summary");
  if (!target || !me) return;
  target.innerHTML = "";
  const row = document.createElement("div");
  row.className = "account-summary";
  const name = document.createElement("strong");
  name.textContent = me.displayName || me.username;
  const metadata = document.createElement("span");
  metadata.textContent = `${me.username} · ${me.role}`;
  row.append(name, metadata);
  target.append(row);
  document.getElementById("account-display-name").value = me.displayName || me.username;
  document.getElementById("account-email").value = me.email || "";
  document.getElementById("account-password").value = "";
}

function fail(el, message) {
  el.textContent = message;
  el.hidden = false;
}

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Unreachable panel (down, wrong origin): status 0, handled like errors.
    return { status: 0, data: { error: { message: "Couldn't reach the panel. Is it running?" } } };
  }
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
let editingUserId = "";
let userDetailWasSuspended = false;
let userDetailRequest = 0;
const serverPermissions = [
  "websocket.connect",
  "control.console",
  "control.start",
  "control.stop",
  "control.restart",
  "control.kill",
  "file.read",
  "file.read-content",
  "file.create",
  "file.update",
  "file.delete",
  "file.archive",
  "file.sftp",
  "backup.read",
  "backup.create",
  "backup.download",
  "backup.restore",
  "backup.delete",
  "allocation.read",
  "allocation.update",
  "startup.read",
  "startup.update",
  "schedule.read",
  "schedule.create",
  "schedule.update",
  "schedule.delete",
  "schedule.run",
  "user.read",
  "user.create",
  "user.update",
  "user.delete",
  "activity.read",
  "settings.rename",
  "settings.reinstall",
  "settings.resources",
  "settings.delete",
];

const serverTabPermissions = {
  console: "control.console",
  files: "file.read",
  backups: "backup.read",
  schedules: "schedule.read",
  addons: "startup.read",
  startup: "startup.read",
  network: "allocation.read",
  users: "user.read",
  settings: ["settings.rename", "settings.resources", "settings.reinstall", "settings.delete"],
};

const serverPowerPermissions = {
  start: "control.start",
  restart: "control.restart",
  stop: "control.stop",
  kill: "control.kill",
};

function renderPermissionOptions() {
  renderPermissionOptionsInto("permission-options", serverPermissions, "permission");
}

function renderApiPermissionOptions() {
  renderPermissionOptionsInto("api-permission-options", serverPermissions, "api-scope");
}

function renderPermissionOptionsInto(targetId, options, inputName) {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = "";
  for (const permission of options) {
    const label = document.createElement("label");
    label.className = "permission-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = inputName;
    input.value = permission;
    const text = document.createElement("span");
    text.textContent = permission;
    label.append(input, text);
    target.append(label);
  }
}

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
      const destination =
        window.location.pathname === "/login" || window.location.pathname === "/register"
          ? "/"
          : window.location.pathname;
      history.replaceState({}, "", destination);
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
  document.getElementById("topbar-user").textContent =
    `${me.displayName || me.username} · ${me.role}`;
  document.querySelectorAll("[data-admin-only]").forEach((link) => {
    link.hidden = me.role !== "owner" && me.role !== "admin";
  });
  await Promise.all([refreshServers(), refreshBlueprints()]);
  await routeFromPath();
  return true;
}

async function refreshServers() {
  const list = document.getElementById("server-list");
  const empty = document.getElementById("server-empty");
  const err = document.getElementById("server-list-error");
  empty.hidden = true;
  const { status, data } = await api("/servers?limit=100", { token: store.token });
  list.innerHTML = "";
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  err.hidden = true;
  if (data.items.length === 0) {
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

async function refreshAdminServers() {
  const list = document.getElementById("admin-server-list");
  const err = document.getElementById("admin-servers-error");
  if (!list || !err) return;
  err.hidden = true;
  list.innerHTML = "";
  let cursor = null;
  for (;;) {
    const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const { status, data } = await api(`/servers${qs}`, { token: store.token });
    if (status !== 200) {
      fail(err, describeProblem(status, data));
      return;
    }
    if (data.items.length === 0 && !cursor) {
      const empty = document.createElement("li");
      empty.textContent = "No servers exist on this panel.";
      list.append(empty);
    }
    for (const server of data.items) {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "linklike";
      open.textContent = server.name;
      open.addEventListener("click", () => openServer(server.id));
      const meta = document.createElement("span");
      meta.className = "role";
      const owner = server.ownerUsername ? ` · owner: ${server.ownerUsername}` : "";
      meta.textContent = `${server.blueprintSlug} · ${server.status}${owner}`;
      li.append(open, meta);
      list.append(li);
    }
    if (!data.nextCursor) return;
    cursor = data.nextCursor;
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
    opt.textContent =
      b.maturity === "experimental"
        ? `${b.name} (${b.slug}) [experimental]`
        : `${b.name} (${b.slug})`;
    select.append(opt);
  }
}

document.getElementById("btn-admin-create-server").addEventListener("click", () => {
  void navigate("/admin/servers/new");
});

document.getElementById("btn-server-create-back").addEventListener("click", () => {
  void navigate("/admin/servers");
});

document.getElementById("form-server").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("server-create-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const body = {
    name: fd.get("name"),
    description: fd.get("description") || "",
    blueprintSlug: fd.get("blueprint"),
    eulaAccepted: document.getElementById("eula-check").checked || undefined,
  };
  if (me?.role === "owner" || me?.role === "admin") {
    body.memoryMb = Number(fd.get("memoryMb")) || 1024;
    body.diskQuotaMb = Number(fd.get("diskQuotaMb")) || 5120;
    body.ownerUsername = fd.get("ownerUsername") || undefined;
  }
  const { status, data } = await api("/servers", {
    method: "POST",
    token: store.token,
    body,
  });
  if (status === 201) {
    e.target.reset();
    await refreshAdminServers();
    await navigate("/admin/servers");
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
    const ownerSelect = document.getElementById("owner-username");
    if (ownerSelect && cursor === null) ownerSelect.innerHTML = "";
    for (const u of data.items) {
      if (ownerSelect && !u.suspended) {
        const option = document.createElement("option");
        option.value = u.username;
        option.textContent = u.displayName || u.username;
        ownerSelect.append(option);
      }
      const li = document.createElement("li");
      const name = document.createElement("button");
      name.type = "button";
      name.className = "linklike";
      name.textContent = u.displayName || u.username;
      name.addEventListener("click", () => navigate(`/admin/users/${u.id}`));
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = `${u.role}${u.suspended ? " (suspended)" : ""}`;
      const canManage = u.role === "user" || me?.role === "owner";
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "linklike";
      reset.textContent = "Set password";
      reset.hidden = !canManage;
      reset.addEventListener("click", async () => {
        const password = window.prompt(`New password for ${u.username} (12+ characters):`);
        if (!password) return;
        const err = document.getElementById("user-error");
        const res = await api(`/users/${u.id}`, {
          method: "PATCH",
          token: store.token,
          body: { password },
        });
        if (res.status !== 200) fail(err, describeProblem(res.status, res.data));
      });
      const suspend = document.createElement("button");
      suspend.type = "button";
      suspend.className = "linklike";
      suspend.textContent = u.suspended ? "Resume" : "Suspend";
      suspend.hidden = !canManage || u.role === "owner";
      suspend.addEventListener("click", async () => {
        const err = document.getElementById("user-error");
        const res = await api(`/users/${u.id}`, {
          method: "PATCH",
          token: store.token,
          body: { suspended: !u.suspended },
        });
        if (res.status !== 200) fail(err, describeProblem(res.status, res.data));
        else refreshUsers();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "linklike danger-text";
      remove.textContent = "Delete";
      remove.hidden = !canManage || u.role === "owner";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Delete ${u.username}?`)) return;
        const err = document.getElementById("user-error");
        let res = await api(`/users/${u.id}`, { method: "DELETE", token: store.token });
        if (res.status === 409) {
          const transferTo = window.prompt(
            `Transfer ${u.username}'s servers to which username? Leave blank to cancel.`,
          );
          if (!transferTo) return;
          let target = null;
          let cursor = null;
          for (;;) {
            const qs = cursor
              ? `/users?limit=100&cursor=${encodeURIComponent(cursor)}`
              : "/users?limit=100";
            const users = await api(qs, { token: store.token });
            if (users.status !== 200) break;
            target = users.data.items.find(
              (candidate) => candidate.id !== u.id && candidate.username === transferTo,
            );
            if (target || !users.data.nextCursor) break;
            cursor = users.data.nextCursor;
          }
          if (!target) {
            fail(err, "That transfer account was not found or is suspended.");
            return;
          }
          res = await api(`/users/${u.id}?transferTo=${encodeURIComponent(target.id)}`, {
            method: "DELETE",
            token: store.token,
          });
        }
        if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
        else refreshUsers();
      });
      li.append(name, role, reset, suspend, remove);
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

async function refreshUserDetail(userId) {
  editingUserId = userId;
  const request = ++userDetailRequest;
  const err = document.getElementById("user-detail-error");
  const list = document.getElementById("user-owned-servers");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/users/${encodeURIComponent(userId)}`, {
    token: store.token,
  });
  if (request !== userDetailRequest) return;
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  const user = data.user;
  document.getElementById("user-detail-heading").textContent = user.displayName || user.username;
  document.getElementById("user-detail-meta").textContent = `${user.username} · ${user.role}`;
  document.getElementById("user-detail-username").value = user.username;
  document.getElementById("user-detail-display-name").value = user.displayName || user.username;
  document.getElementById("user-detail-email").value = user.email || "";
  document.getElementById("user-detail-role").value = user.role === "admin" ? "admin" : "user";
  document.getElementById("user-detail-status").value = user.suspended ? "suspended" : "active";
  userDetailWasSuspended = user.suspended;
  document.getElementById("user-detail-max-servers").value = user.quotas.maxServers;
  document.getElementById("user-detail-ram").value = user.quotas.ramMb;
  document.getElementById("user-detail-disk").value = user.quotas.diskMb;
  document.getElementById("user-detail-password").value = "";

  const canManage = user.role === "user" || me?.role === "owner";
  document.getElementById("user-detail-save").disabled = !canManage;
  document.getElementById("btn-user-detail-delete").disabled = !canManage || user.role === "owner";
  for (const id of [
    "user-detail-username",
    "user-detail-display-name",
    "user-detail-email",
    "user-detail-password",
    "user-detail-max-servers",
    "user-detail-ram",
    "user-detail-disk",
  ]) {
    document.getElementById(id).disabled = !canManage;
  }
  document.getElementById("user-detail-role").disabled =
    !canManage || me?.role !== "owner" || user.role === "owner";
  document.getElementById("user-detail-status").disabled = !canManage || user.role === "owner";

  if (data.servers.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "This user owns no servers.";
    list.append(empty);
  }
  for (const server of data.servers) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "linklike";
    open.textContent = server.name;
    open.addEventListener("click", () => navigate(`/servers/${server.id}/console`));
    const meta = document.createElement("span");
    meta.className = "role";
    meta.textContent = `${server.blueprintSlug} · ${server.status}`;
    li.append(open, meta);
    list.append(li);
  }
}

document
  .getElementById("btn-user-detail-back")
  .addEventListener("click", () => navigate("/admin/users"));

document.getElementById("btn-user-detail-delete").addEventListener("click", async () => {
  const err = document.getElementById("user-detail-error");
  const userId = editingUserId;
  err.hidden = true;
  if (!window.confirm("Delete this user?")) return;
  let res = await api(`/users/${userId}`, { method: "DELETE", token: store.token });
  if (res.status === 409) {
    const transferTo = window.prompt(
      "Transfer this user's servers to which username? Leave blank to cancel.",
    );
    if (!transferTo) return;
    let target = null;
    let cursor = null;
    for (;;) {
      const qs = cursor
        ? `/users?limit=100&cursor=${encodeURIComponent(cursor)}`
        : "/users?limit=100";
      const users = await api(qs, { token: store.token });
      if (users.status !== 200) break;
      target = users.data.items.find(
        (candidate) => candidate.id !== userId && candidate.username === transferTo,
      );
      if (target || !users.data.nextCursor) break;
      cursor = users.data.nextCursor;
    }
    if (!target) {
      fail(err, "That transfer account was not found or is suspended.");
      return;
    }
    res = await api(`/users/${userId}?transferTo=${encodeURIComponent(target.id)}`, {
      method: "DELETE",
      token: store.token,
    });
  }
  if (res.status !== 204) {
    fail(err, describeProblem(res.status, res.data));
    return;
  }
  if (editingUserId === userId) await navigate("/admin/users");
});

document.getElementById("form-user-detail").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("user-detail-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const body = {
    username: String(fd.get("username") || "").trim(),
    displayName: String(fd.get("displayName") || "").trim(),
    quotaMaxServers: Number(fd.get("quotaMaxServers")),
    quotaRamMb: Number(fd.get("quotaRamMb")),
    quotaDiskMb: Number(fd.get("quotaDiskMb")),
  };
  const suspended = fd.get("status") === "suspended";
  if (suspended !== userDetailWasSuspended) body.suspended = suspended;
  const email = String(fd.get("email") || "").trim();
  if (email) body.email = email;
  const password = String(fd.get("password") || "");
  if (password) body.password = password;
  const roleSelect = document.getElementById("user-detail-role");
  if (!roleSelect.disabled) body.role = roleSelect.value;
  const { status, data } = await api(`/users/${editingUserId}`, {
    method: "PATCH",
    token: store.token,
    body,
  });
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  if (password && editingUserId === me?.id) {
    store.token = null;
    me = null;
    history.replaceState({}, "", "/login");
    show("login");
    return;
  }
  await refreshUserDetail(editingUserId);
});

document.getElementById("form-account").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("account-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const body = { displayName: String(fd.get("displayName") || "").trim() };
  const email = String(fd.get("email") || "").trim();
  if (email) body.email = email;
  const password = String(fd.get("password") || "");
  if (password) body.password = password;
  const { status, data } = await api("/account", {
    method: "PATCH",
    token: store.token,
    body,
  });
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  if (data.passwordChanged) {
    store.token = null;
    me = null;
    history.replaceState({}, "", "/login");
    show("login");
    return;
  }
  me = { ...me, ...data.user };
  renderAccount();
});

function signOut() {
  leaveServer();
  store.token = null;
  me = null;
  history.replaceState({}, "", "/login");
  show("login");
}

document.getElementById("btn-signout").addEventListener("click", signOut);
document.getElementById("btn-topbar-signout").addEventListener("click", signOut);
document.querySelectorAll("[data-route]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    void navigate(link.getAttribute("href") || routePath(link.dataset.route));
  });
});
window.addEventListener("popstate", () => {
  if (store.token) void routeFromPath();
});

async function refreshApiKeys() {
  const list = document.getElementById("api-key-list");
  const err = document.getElementById("api-error");
  if (!list || !err) return;
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api("/api-keys", { token: store.token });
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  if (data.keys.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No API keys yet.";
    list.append(empty);
    return;
  }
  for (const key of data.keys) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${key.memo || "API key"} · ${key.scopes.join(", ")}`;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "linklike danger-text";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      if (!window.confirm("Revoke this API key?")) return;
      const res = await api(`/api-keys/${key.id}`, { method: "DELETE", token: store.token });
      if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
      else refreshApiKeys();
    });
    li.append(name, revoke);
    list.append(li);
  }
}

document.getElementById("form-api-key").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("api-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const { status, data } = await api("/api-keys", {
    method: "POST",
    token: store.token,
    body: { memo: fd.get("memo") || "", scopes: fd.getAll("api-scope").map(String) },
  });
  if (status !== 201) {
    fail(err, describeProblem(status, data));
    return;
  }
  window.prompt("Copy this API key now. It will not be shown again:", data.token);
  e.target.reset();
  refreshApiKeys();
});

/* ---------- server detail ---------- */

document.getElementById("btn-back").addEventListener("click", async () => {
  leaveServer();
  await navigate("/");
});

async function openServer(id, tab = "console", updateUrl = true) {
  const { status, data } = await api(`/servers/${id}`, { token: store.token });
  if (status !== 200) {
    await navigate("/");
    return;
  }
  currentServer = data.server;
  if (updateUrl) history.pushState({}, "", `/servers/${id}/${tab}`);
  filesDir = "";
  // Never carry another server's file into this one: a save after switching
  // servers must not write stale contents to the new server.
  document.getElementById("file-editing").textContent = "nothing open";
  document.getElementById("file-content").value = "";
  renderServerHeader();
  applyServerPermissions();
  setTab(tab, false);
  show("server");
  const tasks = [];
  if (canServer("control.console")) tasks.push(refreshConsoleHistory());
  if (canServer("file.read")) tasks.push(refreshFiles());
  if (canServer("backup.read")) tasks.push(refreshBackups());
  if (canServer("schedule.read")) tasks.push(refreshSchedules());
  if (canServer("startup.read")) tasks.push(refreshAddons(), refreshVariables());
  if (canServer("allocation.read")) tasks.push(refreshNetwork());
  if (canServer("user.read")) tasks.push(refreshSubusers());
  if (
    canServer("settings.rename") ||
    canServer("settings.reinstall") ||
    canServer("settings.delete")
  ) {
    tasks.push(Promise.resolve(fillSettings()));
  }
  await Promise.all(tasks);
  if (canServer("websocket.connect")) joinConsoleSocket();
}

function leaveServer() {
  if (socket) {
    socket.close();
    socket = null;
  }
  currentServer = null;
}

function canServerAny(required) {
  if (!currentServer) return false;
  const permissions = Array.isArray(currentServer.permissions) ? currentServer.permissions : [];
  const requiredList = Array.isArray(required) ? required : [required];
  return (
    permissions.includes("*") || requiredList.some((permission) => permissions.includes(permission))
  );
}

function canServer(permission) {
  return canServerAny(permission);
}

function isPanelAdmin() {
  return me?.role === "owner" || me?.role === "admin";
}

function applyServerPermissions() {
  const tabButtons = document.querySelectorAll("#server-tabs [data-tab]");
  for (const button of tabButtons) {
    button.hidden = !canServerAny(serverTabPermissions[button.dataset.tab]);
  }
  document.querySelectorAll("#srv-power [data-power]").forEach((button) => {
    button.hidden = !canServer(serverPowerPermissions[button.dataset.power]);
  });
  document.getElementById("form-console").hidden = !canServer("control.console");
  const consoleNote = document.getElementById("console-note");
  consoleNote.hidden = false;
  consoleNote.textContent = canServer("websocket.connect")
    ? "Live output appears here while the server runs."
    : "Live updates unavailable — refresh to see new output.";
  document.getElementById("form-file-read").hidden = !canServer("file.read");
  document.getElementById("btn-file-save").hidden = !canServer("file.update");
  document.getElementById("btn-file-dialog-save").hidden = !canServer("file.update");
  document.getElementById("btn-open-props").hidden = !canServer("file.read-content");
  document.getElementById("btn-backup").hidden = !canServer("backup.create");
  document.getElementById("form-schedule").hidden = !canServer("schedule.create");
  document.getElementById("form-addon").hidden = !canServer("startup.update");
  document.getElementById("form-variables").hidden = !canServer("startup.update");
  document.getElementById("form-tunnel").hidden = !canServer("allocation.update");
  document.getElementById("form-subuser").hidden = !canServer("user.create");
  document.getElementById("form-settings").hidden = !canServer("settings.rename");
  document.getElementById("btn-reinstall").hidden = !canServer("settings.reinstall");
  document.getElementById("btn-delete-server").hidden =
    !canServer("settings.delete") || !isPanelAdmin();
  const canEditResources = isPanelAdmin() && canServer("settings.resources");
  document.getElementById("settings-memory").closest("label").hidden = !canEditResources;
  document.getElementById("settings-disk").closest("label").hidden = !canEditResources;
}

function availableServerTabs() {
  return Object.keys(serverTabPermissions).filter((tab) => canServerAny(serverTabPermissions[tab]));
}

function fillSettings() {
  document.getElementById("settings-name").value = currentServer.name;
  document.getElementById("settings-desc").value = currentServer.description || "";
  document.getElementById("settings-memory").value = currentServer.memoryMb;
  document.getElementById("settings-disk").value = currentServer.diskQuotaMb;
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

function setTab(name, updateUrl = true) {
  const requestedName = name;
  const tabNames = [
    "console",
    "files",
    "backups",
    "schedules",
    "addons",
    "startup",
    "network",
    "users",
    "settings",
  ];
  const available = availableServerTabs();
  if (!tabNames.includes(name) || !available.includes(name)) name = available[0] || "console";
  if (currentServer && (updateUrl || name !== requestedName)) {
    const method = updateUrl ? "pushState" : "replaceState";
    history[method]({}, "", `/servers/${currentServer.id}/${name}`);
  }
  document
    .querySelectorAll(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  for (const t of tabNames) {
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
  socket.on("console:line", (msg) => appendLine(msg.line.text));
  socket.on("console:revoked", () => {
    document.getElementById("console-note").textContent =
      "Your access to this console changed — ask the owner if you need it back.";
  });
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
  const err = document.getElementById("srv-error");
  if (socket) {
    socket.emit("console:send", { serverId: currentServer.id, command }, (res) => {
      if (!res || !res.accepted) {
        fail(err, "Command not accepted — the server may be offline or input not allowed.");
      }
    });
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
    if (!item.isDir) btn.hidden = !canServer("file.read-content");
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
  document.getElementById("file-dialog-path").textContent = path;
  document.getElementById("file-dialog-content").value = data.content;
  const dialog = document.getElementById("file-editor");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

document.getElementById("btn-file-close").addEventListener("click", () => {
  const dialog = document.getElementById("file-editor");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
});

document.getElementById("btn-file-dialog-save").addEventListener("click", async () => {
  const err = document.getElementById("file-dialog-error");
  err.hidden = true;
  const path = document.getElementById("file-dialog-path").textContent;
  if (!path) return;
  const { status, data } = await api(`/servers/${currentServer.id}/files/content`, {
    method: "PUT",
    token: store.token,
    body: { path, content: document.getElementById("file-dialog-content").value },
  });
  if (status !== 204) fail(err, describeProblem(status, data));
  else {
    document.getElementById("file-editing").textContent = path;
    document.getElementById("file-content").value =
      document.getElementById("file-dialog-content").value;
    err.hidden = true;
  }
});

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
    restore.hidden = !canServer("backup.restore");
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
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "linklike danger-text";
    remove.textContent = b.locked ? "Unlock" : "Delete";
    remove.hidden = !canServer("backup.delete");
    remove.addEventListener("click", async () => {
      if (!b.locked && !window.confirm(`Delete backup ${b.fileName}? This cannot be undone.`))
        return;
      const res = await api(
        `/servers/${currentServer.id}/backups/${b.id}${b.locked ? "/unlock" : ""}`,
        { method: b.locked ? "POST" : "DELETE", token: store.token },
      );
      if (res.status !== 200 && res.status !== 204)
        fail(err, describeProblem(res.status, res.data));
      else refreshBackups();
    });
    li.append(name, restore, remove);
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
    run.hidden = !canServer("schedule.update");
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
    del.hidden = !canServer("schedule.delete");
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

/* ----- addons ----- */

async function refreshAddons() {
  const list = document.getElementById("addon-list");
  const err = document.getElementById("addons-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/addons`, { token: store.token });
  if (status !== 200) {
    fail(err, "You don't have permission to see addons.");
    return;
  }
  if (data.addons.length === 0) {
    const li = document.createElement("li");
    li.textContent =
      "No mods or plugins yet. Paper and Velocity servers use plugins/, Fabric and Forge use mods/.";
    list.append(li);
  }
  for (const a of data.addons) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${a.name} (${a.folder}, ${Math.round(a.bytes / 1024)} KB)`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "linklike danger-text";
    remove.textContent = "Remove";
    remove.hidden = !canServer("startup.update");
    remove.addEventListener("click", async () => {
      const res = await api(
        `/servers/${currentServer.id}/addons/${a.folder}/${encodeURIComponent(a.name)}`,
        {
          method: "DELETE",
          token: store.token,
        },
      );
      if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
      else refreshAddons();
    });
    li.append(name, remove);
    list.append(li);
  }
}

document.getElementById("form-addon").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("addons-error");
  err.hidden = true;
  const projects = String(new FormData(e.target).get("projects") || "")
    .split(/[\s,]+/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const { status, data } = await api(`/servers/${currentServer.id}/addons`, {
    method: "POST",
    token: store.token,
    body: { projects },
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else {
    e.target.reset();
    refreshAddons();
  }
});

/* ----- startup variables ----- */

async function refreshVariables() {
  const wrap = document.getElementById("variable-fields");
  const err = document.getElementById("startup-error");
  err.hidden = true;
  wrap.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/variables`, {
    token: store.token,
  });
  if (status !== 200) {
    fail(err, "You don't have permission to see startup settings.");
    return;
  }
  for (const v of data.variables) {
    if (v.key === "maxMemory") continue;
    const label = document.createElement("label");
    label.textContent = v.label;
    const input = document.createElement("input");
    input.name = v.key;
    input.value = v.value;
    input.disabled = !v.editable;
    if (!v.editable) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "managed by the panel";
      label.append(hint);
    }
    label.append(input);
    wrap.append(label);
  }
}

document.getElementById("form-variables").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("startup-error");
  err.hidden = true;
  const values = {};
  for (const input of e.target.querySelectorAll("input[name]")) {
    if (!input.disabled) values[input.name] = input.value;
  }
  const { status, data } = await api(`/servers/${currentServer.id}/variables`, {
    method: "PUT",
    token: store.token,
    body: { values },
  });
  if (status !== 200) fail(err, describeProblem(status, data));
  else refreshVariables();
});

/* ----- network: allocations + tunnel ----- */

async function refreshNetwork() {
  const list = document.getElementById("alloc-list");
  const err = document.getElementById("network-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/allocations`, {
    token: store.token,
  });
  if (status !== 200) {
    fail(err, "You don't have permission to see network settings.");
    return;
  }
  for (const a of data.allocations) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${a.ip}:${a.port}`;
    li.append(name);
    list.append(li);
  }
  const t = await api(`/servers/${currentServer.id}/tunnel`, { token: store.token });
  const info = document.getElementById("tunnel-info");
  if (t.status === 200 && t.data.endpoint) {
    info.textContent = t.data.address
      ? `Players join at ${t.data.address} (Minekube tunnel “${t.data.endpoint}”).`
      : `Tunnel “${t.data.endpoint}” is installed — start the server and the public address appears here.`;
  } else {
    info.textContent = "No tunnel. Players join you by your IP and port.";
  }
}

document.getElementById("form-tunnel").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("network-error");
  err.hidden = true;
  const endpoint = new FormData(e.target).get("endpoint");
  const { status, data } = await api(`/servers/${currentServer.id}/tunnel`, {
    method: "POST",
    token: store.token,
    body: { endpoint },
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else {
    e.target.reset();
    refreshNetwork();
  }
});

/* ----- users: collaborators ----- */

async function refreshSubusers() {
  const list = document.getElementById("subuser-list");
  const err = document.getElementById("subusers-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/users`, { token: store.token });
  if (status !== 200) {
    fail(err, "You don't have permission to see collaborators.");
    return;
  }
  if (data.users.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Only you. Invite someone below to share access.";
    list.append(li);
  }
  for (const u of data.users) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${u.username} — ${(u.permissions || []).join(", ") || "nothing"}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "linklike danger-text";
    remove.textContent = "Remove";
    remove.hidden = !canServer("user.delete");
    remove.addEventListener("click", async () => {
      const res = await api(`/servers/${currentServer.id}/users/${u.userId}`, {
        method: "DELETE",
        token: store.token,
      });
      if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
      else refreshSubusers();
    });
    li.append(name, remove);
    list.append(li);
  }
}

document.getElementById("form-subuser").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("subusers-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const permissions = fd.getAll("permission").map(String);
  const { status, data } = await api(`/servers/${currentServer.id}/users`, {
    method: "POST",
    token: store.token,
    body: { username: fd.get("username"), permissions },
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else {
    e.target.reset();
    refreshSubusers();
  }
});

/* ----- settings ----- */

document.getElementById("form-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("settings-error");
  err.hidden = true;
  const body = {
    name: document.getElementById("settings-name").value,
    description: document.getElementById("settings-desc").value,
  };
  if (isPanelAdmin() && canServer("settings.resources")) {
    body.memoryMb = Number(document.getElementById("settings-memory").value);
    body.diskQuotaMb = Number(document.getElementById("settings-disk").value);
  }
  const { status, data } = await api(`/servers/${currentServer.id}`, {
    method: "PATCH",
    token: store.token,
    body,
  });
  if (status !== 200) fail(err, describeProblem(status, data));
  else {
    currentServer = data.server;
    renderServerHeader();
  }
});

document.getElementById("btn-reinstall").addEventListener("click", async () => {
  const err = document.getElementById("settings-error");
  err.hidden = true;
  if (
    !window.confirm(
      "Reinstall? Server files are downloaded fresh. Your worlds stay, configs reset.",
    )
  )
    return;
  const { status, data } = await api(`/servers/${currentServer.id}/install`, {
    method: "POST",
    token: store.token,
  });
  if (status !== 200) fail(err, describeProblem(status, data));
});

document.getElementById("btn-delete-server").addEventListener("click", async () => {
  const err = document.getElementById("settings-error");
  err.hidden = true;
  const typed = window.prompt(`Type the server name (“${currentServer.name}”) to delete it.`);
  if (typed !== currentServer.name) return;
  const { status, data } = await api(`/servers/${currentServer.id}`, {
    method: "DELETE",
    token: store.token,
  });
  if (status !== 204) fail(err, describeProblem(status, data));
  else {
    leaveServer();
    history.replaceState({}, "", "/");
    await loadHome();
  }
});

document.getElementById("btn-open-props").addEventListener("click", () => {
  openFile("server.properties");
});

document.querySelectorAll("[data-admin-section]").forEach((button) => {
  button.addEventListener("click", () => {
    history.pushState({}, "", `/admin/${button.dataset.adminSection}`);
    setAdminSection(button.dataset.adminSection);
  });
});

renderPermissionOptions();
renderApiPermissionOptions();
boot();
