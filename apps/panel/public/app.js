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
  "user-create": document.getElementById("view-user-create"),
  "server-create": document.getElementById("view-server-create"),
  "user-detail": document.getElementById("view-user-detail"),
  "admin-server": document.getElementById("view-admin-server"),
  api: document.getElementById("view-api"),
  server: document.getElementById("view-server"),
};

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  const sidebar = document.getElementById("app-sidebar");
  if (sidebar) sidebar.hidden = name === "setup" || name === "login";
  document.querySelectorAll("[data-route]").forEach((link) => {
    link.classList.toggle(
      "active",
      link.dataset.route === name ||
        ((name === "user-create" || name === "server-create" || name === "user-detail") &&
          link.dataset.route === "admin") ||
        (name === "admin-server" && link.dataset.route === "admin") ||
        (name === "server" && link.dataset.route === "home"),
    );
  });
}

function setView(name, detailId = "") {
  const adminOnly =
    name === "admin" ||
    name === "user-create" ||
    name === "server-create" ||
    name === "user-detail" ||
    name === "admin-server";
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
  if (name === "admin-server") void refreshAdminServer(detailId);
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
    // Leaving here skipped the leaveServer() below, so a direct jump from one
    // server to another kept the old socket streaming into the new view.
    if (currentServer && currentServer.id !== serverMatch[1]) leaveServer();
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
  if (path === "/admin/users/new") {
    if (me?.role !== "owner" && me?.role !== "admin") {
      await navigate("/");
      return;
    }
    setView("user-create");
    return;
  }
  // Admin server management is its own surface, mirroring the user one: the
  // name in the admin list opens this, not the server's console.
  const adminServerMatch = path.match(/^\/admin\/servers\/([^/]+)$/);
  if (adminServerMatch) {
    if (me?.role !== "owner" && me?.role !== "admin") {
      await navigate("/");
      return;
    }
    setView("admin-server", adminServerMatch[1]);
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
  await refreshServers();
  if (window.location.pathname !== path) return;
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
  await refreshBlueprints();
  await routeFromPath();
  return true;
}

function serverAccent(id) {
  const accents = ["#9a4022", "#006767", "#625d5a", "#ba5737", "#89726b", "#004f4f"];
  let value = 0;
  for (let index = 0; index < id.length; index += 1)
    value = (value * 31 + id.charCodeAt(index)) >>> 0;
  return accents[value % accents.length];
}

function readableStatus(server) {
  return (server.runtimeState || server.status || "offline").replaceAll("_", " ");
}

function setServerListStatus(state, label) {
  const dot = document.getElementById("server-list-status-dot");
  const text = document.getElementById("server-list-status-label");
  dot.classList.toggle("status-dot--online", state === "available");
  text.textContent = label;
}

async function refreshServers() {
  const list = document.getElementById("server-list");
  const empty = document.getElementById("server-empty");
  const err = document.getElementById("server-list-error");
  empty.hidden = true;
  setServerListStatus("loading", "Loading servers");
  const { status, data } = await api("/servers?limit=100", { token: store.token });
  list.innerHTML = "";
  if (status !== 200) {
    setServerListStatus("error", "Could not load servers");
    fail(err, describeProblem(status, data));
    return;
  }
  err.hidden = true;
  if (data.items.length === 0) {
    setServerListStatus("empty", "No servers shown");
    empty.hidden = false;
    return;
  }
  setServerListStatus(
    "available",
    `${data.items.length} server${data.items.length === 1 ? "" : "s"} shown`,
  );
  for (const server of data.items) {
    const item = document.createElement("li");
    item.className = "server-card";
    item.style.setProperty("--server-accent", serverAccent(server.id));

    const open = document.createElement("button");
    open.type = "button";
    open.className = "server-card-open";
    open.setAttribute("aria-label", `Open ${server.name}`);
    open.addEventListener("click", () => void navigate(`/servers/${server.id}/console`));

    const heading = document.createElement("div");
    heading.className = "server-card-heading";
    const identity = document.createElement("div");
    identity.className = "server-identity";
    const mark = document.createElement("span");
    mark.className = "server-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = server.name.slice(0, 1).toUpperCase();
    const title = document.createElement("strong");
    title.textContent = server.name;
    identity.append(mark, title);

    const state = document.createElement("span");
    const stateName = readableStatus(server);
    state.className = `server-state server-state--${stateName.replaceAll(" ", "-")}`;
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");
    const stateLabel = document.createElement("span");
    stateLabel.textContent = stateName;
    state.append(dot, stateLabel);
    heading.append(identity, state);

    if (server.description) {
      const description = document.createElement("p");
      description.className = "server-description";
      description.textContent = server.description;
      open.append(heading, description);
    } else {
      open.append(heading);
    }

    const details = document.createElement("dl");
    details.className = "server-details";
    const metadata = [
      ["Software", server.blueprintSlug],
      [
        "Address",
        server.primaryAllocation
          ? `${server.hostIp}:${server.primaryAllocation.port}`
          : "Not assigned",
      ],
      ["Memory", `${server.memoryMb} MB`],
      ["Disk", `${server.diskQuotaMb} MB`],
    ];
    for (const [label, value] of metadata) {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.textContent = value;
      group.append(term, definition);
      details.append(group);
    }
    const action = document.createElement("span");
    action.className = "server-card-action";
    action.textContent = "Open server →";
    open.append(details, action);
    item.append(open);
    list.append(item);
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
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = "linklike";
      manage.textContent = server.name;
      // Pterodactyl's admin list does the same: the name opens the admin
      // edit view, and a separate control is the way into the server.
      manage.addEventListener("click", () => void navigate(`/admin/servers/${server.id}`));
      const meta = document.createElement("span");
      meta.className = "role";
      const owner = server.ownerUsername ? ` · owner: ${server.ownerUsername}` : "";
      meta.textContent = `${server.blueprintSlug} · ${server.status}${owner}`;
      const consoleLink = document.createElement("button");
      consoleLink.type = "button";
      consoleLink.className = "linklike";
      consoleLink.textContent = "Console";
      consoleLink.addEventListener("click", () => void navigate(`/servers/${server.id}/console`));
      li.append(manage, meta, consoleLink);
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
    // CPU is a panel resource: the API ignores it for anyone but an admin,
    // so the value belongs with the other admin-only fields.
    body.cpuWeight = Math.max(0, Number(fd.get("cpuWeight")) || 0);
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

/* ---------- admin: manage one server ---------- */

let editingAdminServerId = "";
let adminServerRequest = 0;

async function refreshAdminServer(serverId) {
  editingAdminServerId = serverId;
  // A generation, not an id comparison: two visits to the same server would
  // otherwise let the first, slower response repaint the reopened form with
  // values the admin has already moved past.
  const request = ++adminServerRequest;
  const err = document.getElementById("admin-server-error");
  err.hidden = true;
  const { status, data } = await api(`/servers/${encodeURIComponent(serverId)}`, {
    token: store.token,
  });
  if (request !== adminServerRequest) return;
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  const server = data.server;
  document.getElementById("admin-server-heading").textContent = server.name;
  const alloc = server.primaryAllocation
    ? `${server.hostIp}:${server.primaryAllocation.port}`
    : "no address yet";
  document.getElementById("admin-server-meta").textContent =
    `${server.blueprintSlug} · ${server.status} · owner: ${server.ownerUsername} · ${alloc}`;
  document.getElementById("admin-server-name").value = server.name;
  document.getElementById("admin-server-description").value = server.description || "";
  document.getElementById("admin-server-cpu").value = server.cpuWeight;
  document.getElementById("admin-server-memory").value = server.memoryMb;
  document.getElementById("admin-server-disk").value = server.diskQuotaMb;
}

document.getElementById("btn-admin-server-back").addEventListener("click", () => {
  void navigate("/admin/servers");
});

document.getElementById("btn-admin-server-console").addEventListener("click", () => {
  void navigate(`/servers/${editingAdminServerId}/console`);
});

document.getElementById("form-admin-server").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("admin-server-error");
  err.hidden = true;
  const { status, data } = await api(`/servers/${editingAdminServerId}`, {
    method: "PATCH",
    token: store.token,
    body: {
      name: document.getElementById("admin-server-name").value,
      description: document.getElementById("admin-server-description").value,
      cpuWeight: Number(document.getElementById("admin-server-cpu").value),
      memoryMb: Number(document.getElementById("admin-server-memory").value),
      diskQuotaMb: Number(document.getElementById("admin-server-disk").value),
    },
  });
  if (status !== 200) {
    fail(err, describeProblem(status, data));
    return;
  }
  await refreshAdminServer(editingAdminServerId);
  await refreshAdminServers();
});

document.getElementById("btn-admin-create-user").addEventListener("click", () => {
  void navigate("/admin/users/new");
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

document.getElementById("btn-user-create-back").addEventListener("click", () => {
  void navigate("/admin/users");
});

document.getElementById("form-user-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("user-create-error");
  err.hidden = true;
  const fd = new FormData(e.target);
  const body = {
    username: String(fd.get("username") || "").trim(),
    password: String(fd.get("password") || ""),
    displayName: String(fd.get("displayName") || "").trim() || undefined,
    email: String(fd.get("email") || "").trim() || undefined,
    role: fd.get("role"),
  };
  try {
    const { status, data } = await api("/users", {
      method: "POST",
      token: store.token,
      body,
    });
    if (status === 201) {
      e.target.reset();
      await navigate("/admin/users");
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

// One sign-out, in the sidebar. The dashboard used to carry a second copy.
document.getElementById("btn-topbar-signout").addEventListener("click", signOut);
document.querySelectorAll("[data-server-tab]").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    setTab(link.dataset.serverTab);
  });
});
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

// The server's own menus live in the left rail above the global ones, so the
// rail stays put while the middle column swaps between them.
function renderServerNav() {
  const nav = document.getElementById("server-navigation");
  nav.hidden = !currentServer;
  if (currentServer) {
    document.getElementById("server-nav-title").textContent = currentServer.name;
  }
}

async function openServer(id, tab = "console", updateUrl = true) {
  // Claim the generation before awaiting: the newest navigation owns the view,
  // not whichever detail request happens to answer first.
  const generation = ++serverGeneration;
  const { status, data } = await api(`/servers/${id}`, { token: store.token });
  if (generation !== serverGeneration) return;
  if (status !== 200) {
    await navigate("/");
    return;
  }
  currentServer = data.server;
  if (updateUrl) history.pushState({}, "", `/servers/${id}/${tab}`);
  filesDir = "";
  // Never carry another server's file into this one: a save after switching
  // servers must not write stale contents to the new server.
  document.getElementById("file-dialog-path").textContent = "";
  document.getElementById("file-dialog-content").value = "";
  renderServerHeader();
  renderServerNav();
  resetStatSeries();
  applyServerPermissions();
  setTab(tab, false);
  show("server");
  const tasks = [];
  if (canServer("control.console")) tasks.push(refreshConsoleHistory(generation));
  if (canServer("file.read")) tasks.push(refreshFiles(generation));
  if (canServer("backup.read")) tasks.push(refreshBackups(generation));
  if (canServer("schedule.read")) tasks.push(refreshSchedules(generation));
  if (canServer("startup.read")) {
    tasks.push(refreshAddons(generation), refreshVariables(generation));
  }
  if (canServer("allocation.read")) tasks.push(refreshNetwork(generation));
  if (canServer("user.read")) tasks.push(refreshSubusers(generation));
  tasks.push(refreshAddonCapability(generation));
  if (
    canServer("settings.rename") ||
    canServer("settings.reinstall") ||
    canServer("settings.delete")
  ) {
    tasks.push(Promise.resolve(fillSettings()));
  }
  await Promise.all(tasks);
  if (generation !== serverGeneration) return;
  if (canServer("websocket.connect")) joinConsoleSocket();
}

// A superseded load must not paint. Every server-scoped fetch checks this the
// moment its response lands, before touching the DOM.
function isStaleLoad(generation) {
  return generation !== undefined && generation !== serverGeneration;
}

function leaveServer() {
  // Bump the generation so in-flight loads and socket callbacks for the server
  // being abandoned can recognize themselves as stale and do nothing.
  serverGeneration += 1;
  consoleSeq = 0;
  if (socket) {
    socket.close();
    socket = null;
  }
  currentServer = null;
  renderServerNav();
  resetStatSeries();
}

function canServerAny(required) {
  if (!currentServer) return false;
  const requiredList = Array.isArray(required) ? required : [required];
  if (Array.isArray(currentServer.permissions)) {
    const permissions = currentServer.permissions;
    return (
      permissions.includes("*") ||
      requiredList.some((permission) => permissions.includes(permission))
    );
  }
  return isPanelAdmin() || currentServer.ownerId === me?.id;
}

function canServer(permission) {
  return canServerAny(permission);
}

function isPanelAdmin() {
  return me?.role === "owner" || me?.role === "admin";
}

function applyServerPermissions() {
  for (const link of document.querySelectorAll("#server-navigation [data-server-tab]")) {
    link.hidden = !canServerAny(serverTabPermissions[link.dataset.serverTab]);
  }
  document.querySelectorAll("#srv-power [data-power]").forEach((button) => {
    button.hidden = !canServer(serverPowerPermissions[button.dataset.power]);
  });
  // The graphs are fed by the console socket. Without websocket.connect they
  // would sit at "—" forever, so they are hidden rather than faked; the power
  // buttons still work, because they go over REST.
  const live = canServer("websocket.connect");
  for (const block of statCharts.map((id) => document.getElementById(id)?.closest(".rail-block"))) {
    if (block) block.hidden = !live;
  }
  document.getElementById("form-console").hidden = !canServer("control.console");
  document.getElementById("form-file-read").hidden = !canServer("file.read");
  document.getElementById("btn-file-dialog-save").hidden = !canServer("file.update");
  document.getElementById("btn-file-mkdir").hidden = !canServer("file.create");
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
  document.getElementById("settings-cpu").closest("label").hidden = !canEditResources;
  document.getElementById("settings-memory").closest("label").hidden = !canEditResources;
  document.getElementById("settings-disk").closest("label").hidden = !canEditResources;
  document.getElementById("console-note").hidden = false;
  applyConsoleNote();
}

function availableServerTabs() {
  return Object.keys(serverTabPermissions).filter((tab) => canServerAny(serverTabPermissions[tab]));
}

function fillSettings() {
  document.getElementById("settings-name").value = currentServer.name;
  document.getElementById("settings-desc").value = currentServer.description || "";
  document.getElementById("settings-cpu").value = currentServer.cpuWeight;
  document.getElementById("settings-memory").value = currentServer.memoryMb;
  document.getElementById("settings-disk").value = currentServer.diskQuotaMb;
}

function renderServerHeader() {
  const s = currentServer;
  document.getElementById("srv-name").textContent = s.name;
  // 0.0.0.0 is the bind wildcard, not an address anyone can dial; the API
  // resolves the host's real outbound IP for players to use.
  const alloc = s.primaryAllocation ? `${s.hostIp}:${s.primaryAllocation.port}` : "no address yet";
  const runtime = s.runtimeState ? ` · ${readableStatus(s)}` : "";
  document.getElementById("srv-meta").textContent =
    `${s.blueprintSlug} · ${s.status}${runtime} · ${alloc}`;
  applyPowerState();
  applyConsoleNote();
}

// The note is state, not a one-time string: it must stop promising live output
// when the process is gone, and must admit when the stream is only history.
function applyConsoleNote() {
  const note = document.getElementById("console-note");
  if (!currentServer) return;
  if (!canServer("websocket.connect")) {
    note.textContent = "Live updates unavailable — refresh to see new output.";
    return;
  }
  if (currentServer.status === "suspended") {
    note.textContent = "This server is suspended.";
    return;
  }
  const state = currentServer.runtimeState || "offline";
  if (state === "offline") {
    note.textContent = "Server stopped — start it to stream live output.";
    return;
  }
  if (state === "running") {
    note.textContent = "Live output appears here while the server runs.";
    return;
  }
  note.textContent = `Server is ${state}…`;
}

// Pterodactyl pattern (PowerButtons.tsx): never offer an action the current
// state cannot honor. Offline servers cannot be stopped or killed; running
// ones cannot be started again.
function applyPowerState() {
  if (!currentServer) return;
  const state = currentServer.runtimeState || "offline";
  const notReady = currentServer.status !== "ready";
  const set = (action, disabled, label) => {
    const button = document.querySelector(`#srv-power [data-power="${action}"]`);
    if (!button) return;
    button.disabled = disabled;
    if (label) button.textContent = label;
  };
  set("start", state !== "offline" || notReady);
  set("stop", state === "offline");
  set("restart", state === "offline" || notReady);
  set("kill", state === "offline", state === "stopping" ? "Kill" : "Kill");
}

document.querySelectorAll("#srv-power button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const err = document.getElementById("srv-error");
    err.hidden = true;
    // Forcibly stopping a running process can corrupt server data.
    if (
      btn.dataset.power === "kill" &&
      !window.confirm("Force stop this process? Data may be lost.")
    ) {
      return;
    }
    btn.disabled = true;
    try {
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
      } else {
        // The action landed but state is unknown: say so rather than leaving a
        // dead button and a stale header.
        fail(err, "Action completed, but the server state could not be refreshed.");
      }
    } finally {
      applyPowerState();
    }
  });
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
  const activeLink = document.querySelector(`#server-navigation [data-server-tab="${name}"]`);
  document
    .querySelectorAll("#server-navigation [data-server-tab]")
    .forEach((link) => link.classList.toggle("active", link === activeLink));
  for (const t of tabNames) {
    document.getElementById(`tab-${t}`).hidden = t !== name;
  }
  // Power and the live graphs belong to the console: the console owns the
  // full width of the middle column, and the rail is empty anywhere else.
  document.getElementById("server-rail").hidden = name !== "console";
}

/* ----- console ----- */

// The REST history and the gateway's join replay overlap, and both carry the
// engine's monotonic `seq`. That counter is per server, so it is reset on every
// server switch (see leaveServer) and never compared across servers.
let consoleSeq = 0;
let serverGeneration = 0;

function appendLine(text) {
  const log = document.getElementById("console-log");
  log.textContent += (log.textContent ? "\n" : "") + text;
  const lines = log.textContent.split("\n");
  if (lines.length > 500) log.textContent = lines.slice(-500).join("\n");
  log.scrollTop = log.scrollHeight;
}

function appendConsoleLine(line, generation) {
  // Events from an abandoned socket or a superseded load are dropped entirely.
  if (generation !== undefined && generation !== serverGeneration) return;
  if (typeof line?.seq === "number") {
    if (line.seq <= consoleSeq) return;
    consoleSeq = line.seq;
  }
  appendLine(line?.text ?? String(line));
}

function resetConsoleHistory(lines) {
  document.getElementById("console-log").textContent = "";
  consoleSeq = 0;
  for (const line of lines) appendConsoleLine(line);
}

async function refreshConsoleHistory(generation) {
  const id = currentServer.id;
  const { status, data } = await api(`/servers/${id}/console/history?limit=200`, {
    token: store.token,
  });
  if (generation !== serverGeneration || currentServer?.id !== id) return;
  if (status !== 200) {
    resetConsoleHistory([]);
    appendLine("(You don't have permission to see this server's console.)");
    return;
  }
  resetConsoleHistory(data.lines);
}

function joinConsoleSocket() {
  if (socket) socket.close();
  const note = document.getElementById("console-note");
  if (typeof window.io !== "function") {
    note.textContent = "Live updates unavailable — refresh to see new output.";
    return;
  }
  const generation = serverGeneration;
  const serverId = currentServer.id;
  socket = window.io({ path: "/socket.io/", auth: { token: store.token } });
  // Re-join on every (re)connect, not just the first: a reconnect lands on a
  // brand new server-side socket that has never joined the room, so without
  // this the console and the graphs stay dead until a manual page refresh.
  const join = () => {
    if (generation !== serverGeneration) return;
    socket.emit("console:join", serverId, (res) => {
      if (generation !== serverGeneration) return;
      if (!res || !res.ok) {
        note.textContent =
          res && res.reason === "suspended"
            ? "This server is suspended."
            : "Live updates unavailable.";
      } else {
        applyConsoleNote();
      }
    });
  };
  socket.on("connect", join);
  socket.on("disconnect", () => {
    if (generation === serverGeneration) {
      note.textContent = "Live connection closed — refresh to see new output.";
    }
  });
  socket.on("connect_error", () => {
    if (generation === serverGeneration) {
      note.textContent = "Couldn't reach the live console — refresh to see new output.";
    }
  });
  // A join replay can still be the first thing we see (REST history denied, or
  // lines emitted between the REST read and the join); dedupe keeps it honest.
  socket.on("console:history", (msg) => {
    for (const line of msg?.lines ?? []) appendConsoleLine(line, generation);
  });
  socket.on("console:line", (msg) => appendConsoleLine(msg.line, generation));
  // A restart, a stop, or a kill is a new run: the engine drops the old
  // scrollback and says so, so the console starts from zero instead of
  // stacking every run the server has ever had. The seq counter is
  // deliberately left alone — it stays monotonic per server, which is what
  // keeps the dedupe above honest.
  socket.on("console:reset", () => {
    if (generation !== serverGeneration) return;
    document.getElementById("console-log").textContent = "";
    resetStatSeries();
  });
  socket.on("stats", (msg) => {
    if (generation !== serverGeneration || msg?.serverId !== serverId) return;
    pushStatSample(msg.stats);
  });

  socket.on("console:revoked", () => {
    if (generation === serverGeneration) {
      note.textContent = "Your access to this console changed — ask the owner if you need it back.";
    }
  });
}

/* ----- live resource graphs ----- */

// Pterodactyl's StatGraphs keeps a fixed ring buffer per chart and wipes it
// when the server leaves `running`. Same shape here: 60 samples at the
// engine's 2s cadence is two minutes of history.
const STAT_SAMPLES = 60;
const statSeries = { cpu: [], memory: [], rx: [], tx: [] };
const statCharts = ["chart-cpu", "chart-memory", "chart-network"];

function resetStatSeries() {
  for (const key of Object.keys(statSeries)) statSeries[key].length = 0;
  document.getElementById("stat-cpu-value").textContent = "—";
  document.getElementById("stat-memory-value").textContent = "—";
  document.getElementById("stat-network-value").textContent = "—";
  for (const id of statCharts) {
    for (const path of document.getElementById(id).querySelectorAll("path")) {
      path.setAttribute("d", "");
    }
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function cpuLimitLabel() {
  const weight = currentServer?.cpuWeight ?? 0;
  if (!weight) return "all cores";
  return weight === 100 ? "1 core" : `${Math.ceil(weight / 100)} cores`;
}

// `pair` picks which fill/line of a two-series chart to draw into: 0 for
// inbound (or a single-series chart), 1 for outbound.
function drawChart(chartId, series, ceiling, pair = 0) {
  const svg = document.getElementById(chartId);
  if (!svg) return;
  const paths = svg.querySelectorAll("path");
  const drawable = paths.length === 4 ? [paths[pair * 2], paths[pair * 2 + 1]] : paths;
  if (!drawable[0] || !drawable[1]) return;
  const known = series.filter((value) => value !== null);
  if (known.length < 2) return;
  const max = Math.max(ceiling || 0, ...known) * 1.1 || 1;
  const step = 100 / (series.length - 1);
  const points = series.map((value, index) => {
    const y = 32 - (Math.min(value ?? 0, max) / max) * 30;
    return `${(index * step).toFixed(2)},${y.toFixed(2)}`;
  });
  const line = `M${points.join(" L")}`;
  drawable[0].setAttribute("d", `${line} L100,32 L0,32 Z`);
  drawable[1].setAttribute("d", line);
}

function pushStatSample(sample) {
  if (!sample) return;
  const record = (key, value) => {
    statSeries[key].push(value);
    if (statSeries[key].length > STAT_SAMPLES) statSeries[key].shift();
  };
  record("cpu", sample.cpuPercent);
  record("memory", sample.memoryBytes === null ? null : sample.memoryBytes / (1024 * 1024));
  record("rx", sample.networkRxPerSec);
  record("tx", sample.networkTxPerSec);

  const running = sample.state === "running";
  document.getElementById("stat-cpu-value").textContent =
    running && sample.cpuPercent !== null
      ? `${sample.cpuPercent.toFixed(1)}% of ${cpuLimitLabel()}`
      : "—";
  document.getElementById("stat-memory-value").textContent = running
    ? `${formatBytes(sample.memoryBytes)} / ${currentServer?.memoryMb ?? 0} MB`
    : "—";
  document.getElementById("stat-network-value").textContent = running
    ? `↓ ${formatBytes(sample.networkRxPerSec)}/s  ↑ ${formatBytes(sample.networkTxPerSec)}/s`
    : "—";

  drawChart("chart-cpu", statSeries.cpu, 100);
  drawChart("chart-memory", statSeries.memory, currentServer?.memoryMb ?? 0);
  // Inbound and outbound share one scale so the two lines are comparable.
  const traffic = Math.max(
    ...statSeries.rx.filter((value) => value !== null),
    ...statSeries.tx.filter((value) => value !== null),
  );
  drawChart("chart-network", statSeries.rx, traffic, 0);
  drawChart("chart-network", statSeries.tx, traffic, 1);
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

async function refreshFiles(generation) {
  const list = document.getElementById("file-list");
  const err = document.getElementById("files-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(
    `/servers/${currentServer.id}/files?path=${encodeURIComponent(filesDir)}`,
    { token: store.token },
  );
  if (isStaleLoad(generation)) return;
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
    const actions = document.createElement("span");
    actions.className = "file-actions";
    const addAction = (label, permission, handler, danger) => {
      const action = document.createElement("button");
      action.type = "button";
      action.className = danger ? "linklike danger-text" : "linklike";
      action.textContent = label;
      action.hidden = !canServer(permission);
      action.addEventListener("click", handler);
      actions.append(action);
    };
    const relative = filesDir ? `${filesDir}/${item.name}` : item.name;
    if (canServer("file.update")) {
      addAction("Rename", "file.update", () => renameFileTo(relative, dirOf(relative)), false);
      addAction("Move", "file.update", () => moveFileTo(relative), false);
    }
    if (canServer("file.delete")) {
      addAction(
        "Delete",
        "file.delete",
        async () => {
          if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
          const res = await api(`/servers/${currentServer.id}/files/delete`, {
            method: "POST",
            token: store.token,
            body: { path: relative },
          });
          if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
          else refreshFiles();
        },
        true,
      );
    }
    li.append(btn, meta, actions);
    list.append(li);
  }
}

function basename(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function dirOf(path) {
  return path.split("/").filter(Boolean).slice(0, -1).join("/");
}

async function renameFileTo(path, currentDir) {
  const name = window.prompt("New name:", basename(path));
  if (!name || name === basename(path)) return;
  await applyMove(path, currentDir, name);
}

async function moveFileTo(path) {
  const destination = window.prompt("Move into which folder?", dirOf(path));
  if (destination === null) return;
  await applyMove(path, destination.replace(/^\/+|\/+$/g, ""), basename(path));
}

async function applyMove(from, toDir, name) {
  const err = document.getElementById("files-error");
  const to = toDir ? `${toDir}/${name}` : name;
  if (to === from) return;
  const res = await api(`/servers/${currentServer.id}/files/rename`, {
    method: "POST",
    token: store.token,
    body: { from, to },
  });
  if (res.status !== 204) {
    fail(err, describeProblem(res.status, res.data));
    return;
  }
  filesDir = toDir;
  refreshFiles();
}

document.getElementById("btn-file-mkdir")?.addEventListener("click", async () => {
  const err = document.getElementById("files-error");
  err.hidden = true;
  const name = window.prompt("New folder name:");
  if (!name) return;
  const path = filesDir ? `${filesDir}/${name}` : name;
  const res = await api(`/servers/${currentServer.id}/files/mkdir`, {
    method: "POST",
    token: store.token,
    body: { path },
  });
  if (res.status !== 204) fail(err, describeProblem(res.status, res.data));
  else refreshFiles();
});

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
    err.hidden = true;
  }
});

document.getElementById("form-file-read").addEventListener("submit", (e) => {
  e.preventDefault();
  const path = new FormData(e.target).get("path");
  if (path) openFile(String(path));
});

/* ----- backups ----- */

async function refreshBackups(generation) {
  const list = document.getElementById("backup-list");
  const err = document.getElementById("backups-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/backups`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
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

async function refreshSchedules(generation) {
  const list = document.getElementById("schedule-list");
  const err = document.getElementById("schedules-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/schedules`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
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

async function refreshAddons(generation) {
  const list = document.getElementById("addon-list");
  const err = document.getElementById("addons-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/addons`, { token: store.token });
  if (isStaleLoad(generation)) return;
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

// What this server can load at all. Vanilla, Bedrock, and the generic
// runtimes have no mod or plugin platform, so the Addons tab is hidden
// rather than offering something that cannot work.
async function refreshAddonCapability(generation) {
  const results = document.getElementById("addon-search-results");
  const note = document.getElementById("addon-search-note");
  const { status, data } = await api(`/servers/${currentServer.id}/addons/capability`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
  const navLink = document.getElementById("server-nav-addons");
  const supported = status === 200 && data.supported;
  const usable = supported && canServer("startup.read");
  if (navLink) navLink.hidden = !usable;
  if (!usable) {
    // setTab() already ran before this check, so a deep link to
    // /servers/:id/addons would leave the addons panel showing with no nav
    // entry left to leave it. Move to a tab this server actually has.
    if (!document.getElementById("tab-addons").hidden) {
      setTab(availableServerTabs()[0] || "console");
    }
    return;
  }
  const kind = data.projectType === "mod" ? "mods" : "plugins";
  document.getElementById("addon-kind").textContent = kind;
  document.getElementById("server-nav-addons-label").textContent =
    kind === "mods" ? "Mods" : "Plugins";
  results.innerHTML = "";
  if (data.mcVersion) {
    note.hidden = true;
  } else {
    // The installer now records the version it resolved, so this only shows
    // on a server that was created before that, or one still installing.
    note.hidden = false;
    note.textContent =
      'Set an exact Minecraft version on the Startup tab first — "latest" cannot resolve addon files.';
  }
}

document.getElementById("form-addon-search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("addons-error");
  const results = document.getElementById("addon-search-results");
  const note = document.getElementById("addon-search-note");
  err.hidden = true;
  results.innerHTML = "";
  const query = String(new FormData(e.target).get("q") || "").trim();
  if (!query) {
    note.hidden = false;
    note.textContent = "Type something to search Modrinth.";
    return;
  }
  // Pin the server this search is for. Without it a slow response can land
  // after the user moved to another server, rendering the wrong hits and
  // leaving Install buttons that would install into the new server.
  const serverId = currentServer.id;
  const generation = serverGeneration;
  const { status, data } = await api(
    `/servers/${serverId}/addons/search?q=${encodeURIComponent(query)}`,
    { token: store.token },
  );
  if (generation !== serverGeneration || currentServer?.id !== serverId) return;
  if (status !== 200) {
    note.hidden = false;
    note.textContent = describeProblem(status, data);
    return;
  }
  note.hidden = true;
  if (data.hits.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = `Nothing on Modrinth matches "${query}" for ${data.mcVersion}.`;
    results.append(empty);
    return;
  }
  for (const hit of data.hits) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${hit.title} — ${hit.description}`;
    const meta = document.createElement("span");
    meta.className = "role";
    meta.textContent = `${hit.author} · ${Math.round(hit.downloads / 1000)}k downloads`;
    const install = document.createElement("button");
    install.type = "button";
    install.className = "linklike";
    install.textContent = "Install";
    install.hidden = !canServer("startup.update");
    install.addEventListener("click", async () => {
      install.disabled = true;
      const res = await api(`/servers/${serverId}/addons`, {
        method: "POST",
        token: store.token,
        body: { projects: [hit.projectId] },
      });
      if (res.status !== 201) {
        fail(err, describeProblem(res.status, res.data));
        // Let the user retry this project without rerunning the search.
        install.disabled = false;
        return;
      }
      refreshAddons();
    });
    li.append(name, meta, install);
    results.append(li);
  }
});

document.getElementById("form-addon").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("addons-error");
  err.hidden = true;
  // Modrinth ids are case-sensitive; only the surrounding whitespace and
  // separators are ours to normalise.
  const projects = String(new FormData(e.target).get("projects") || "")
    .split(/[\s,]+/)
    .map((p) => p.trim())
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

async function refreshVariables(generation) {
  const wrap = document.getElementById("variable-fields");
  const err = document.getElementById("startup-error");
  err.hidden = true;
  wrap.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/variables`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
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

async function refreshNetwork(generation) {
  const list = document.getElementById("alloc-list");
  const err = document.getElementById("network-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/allocations`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
  if (status !== 200) {
    fail(err, "You don't have permission to see network settings.");
    return;
  }
  for (const a of data.allocations) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = `${currentServer.hostIp}:${a.port}`;
    li.append(name);
    list.append(li);
  }
  const t = await api(`/servers/${currentServer.id}/tunnel`, { token: store.token });
  if (isStaleLoad(generation)) return;
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
  const endpoint = String(new FormData(e.target).get("endpoint") || "").trim();
  const { status, data } = await api(`/servers/${currentServer.id}/tunnel`, {
    method: "POST",
    token: store.token,
    // Blank means "mint a random endpoint name" — see the server route.
    body: endpoint ? { endpoint } : {},
  });
  if (status !== 201) fail(err, describeProblem(status, data));
  else {
    e.target.reset();
    refreshNetwork();
  }
});

/* ----- users: collaborators ----- */

async function refreshSubusers(generation) {
  const list = document.getElementById("subuser-list");
  const err = document.getElementById("subusers-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/users`, { token: store.token });
  if (isStaleLoad(generation)) return;
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
    body.cpuWeight = Number(document.getElementById("settings-cpu").value);
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
