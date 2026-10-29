"use strict";
/* Renom web client — no build step. Talks to /api/v3 on the same origin. */

/* ----- action notifications (toasts) ----- */

function showToast(message, type = "success", duration = 3500) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = "toast-item toast-" + type;
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = type === "error" ? "⚠" : type === "info" ? "ℹ" : "✓";
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "toast-close";
  closeBtn.textContent = "×";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.addEventListener("click", () => {
    toast.classList.add("toast-exit");
    setTimeout(() => toast.remove(), 250);
  });
  toast.append(icon, text, closeBtn);
  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentElement) {
      toast.classList.add("toast-exit");
      setTimeout(() => toast.remove(), 250);
    }
  }, duration);
}

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
    await openServer(serverMatch[1], serverMatch[2] || "overview", false);
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
  // null = every collaborator who can see this server at all. Overview shows
  // only facts the server read already returns, and it is the landing page, so
  // gating it on control.console hid the whole server from a files- or
  // backups-scoped collaborator.
  overview: null,
  console: "control.console",
  activity: "activity.read",
  files: "file.read",
  properties: "file.read-content",
  addons: "startup.read",
  backups: "backup.read",
  schedules: "schedule.read",
  network: "allocation.read",
  users: "user.read",
  startup: "startup.read",
  software: "startup.read",
  egg: "startup.read",
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
  // Follow nextCursor instead of trusting a single page: the listing caps at
  // 100 rows, and the owned-only switch claims to reveal every accessible
  // server, so a one-shot fetch would silently hide the tail of a big account.
  const servers = [];
  let cursor = null;
  for (;;) {
    const qs = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const { status, data } = await api(`/servers${qs}`, { token: store.token });
    if (status !== 200) {
      setServerListStatus("error", "Could not load servers");
      fail(err, describeProblem(status, data));
      return;
    }
    servers.push(...data.items);
    cursor = data.nextCursor;
    if (!cursor) break;
  }
  const data = { items: servers };
  list.innerHTML = "";
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
    open.addEventListener("click", () => void navigate(`/servers/${server.id}/overview`));

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
    // Ownership decides the default view: the dashboard opens on servers you
    // own, and the switch reveals the rest without another request.
    item.dataset.owned = server.ownerId && me?.id === server.ownerId ? "1" : "0";
    list.append(item);
  }
  applyOwnedOnlyFilter();
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
    const port = Number(fd.get("port"));
    body.port = Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : undefined;
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
    open.addEventListener("click", () => navigate(`/servers/${server.id}/overview`));
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

async function openServer(id, tab = "overview", updateUrl = true) {
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
  // A different server has a different address; the header must not keep the
  // previous server's tunnel while this one's network read is in flight.
  tunnelAddress = "";
  if (updateUrl) history.pushState({}, "", `/servers/${id}/${tab}`);
  filesDir = "";
  addonSearchQuery = "";
  addonSearchPage = 1;
  const addonInput = document.getElementById("addon-search-input");
  if (addonInput) addonInput.value = "";
  const addonContainer = document.getElementById("addon-cards-container");
  if (addonContainer) addonContainer.innerHTML = "";
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
  renderOverview();
  if (canServer("control.console")) tasks.push(refreshConsoleHistory(generation));
  if (canServer("activity.read")) tasks.push(refreshActivity(true, generation));
  if (canServer("file.read")) tasks.push(refreshFiles(generation));
  if (canServer("backup.read")) tasks.push(refreshBackups(generation));
  if (canServer("schedule.read")) tasks.push(refreshSchedules(generation));
  if (canServer("startup.read")) {
    // Software/Startup do not depend on the capability kind — start them
    // immediately. Capability decides the addons folder filter; awaiting it
    // keeps a Fabric server's first paint from filtering to /plugins, and
    // the hook itself refreshes the installed list when the kind is decided
    // (its registry probe can be slow, so it must not gate the other tabs).
    tasks.push(refreshSoftware(generation), refreshVariables(generation));
    await refreshAddonCapability(generation);
  }
  if (canServer("allocation.read")) tasks.push(refreshNetwork(generation));
  if (canServer("user.read")) tasks.push(refreshSubusers(generation));
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
  tunnelAddress = "";
  addonSearchQuery = "";
  addonSearchPage = 1;
  // The next server's capability decides the folder filter again.
  addonCapabilityKind = null;
  const addonInput = document.getElementById("addon-search-input");
  if (addonInput) addonInput.value = "";
  const addonContainer = document.getElementById("addon-cards-container");
  if (addonContainer) addonContainer.innerHTML = "";
  renderServerNav();
  resetStatSeries();
  // A different server is a different run namespace.
  consoleRun = null;
}

function canServerAny(required) {
  if (!currentServer) return false;
  // null/undefined means "no permission needed beyond access to this server":
  // currentServer only exists for servers the principal may reach at all.
  if (required === null || required === undefined) return true;
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
    // Two gates: permission (subuser scope) and blueprint (server.properties
    // exists only for Minecraft Java). Without the second, a Bedrock server
    // shows a Properties link that silently bounces on click.
    const tab = link.dataset.serverTab;
    link.hidden = !canServerAny(serverTabPermissions[tab]) || !tabAvailableForBlueprint(tab);
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
  // The tab opens with file.read-content, but writing the file needs
  // file.update; without this a read-only collaborator gets a Save button whose
  // only outcome is a 403.
  document.getElementById("btn-properties-save").hidden = !canServer("file.update");
  document.getElementById("btn-backup").hidden = !canServer("backup.create");
  document.getElementById("form-schedule").hidden = !canServer("schedule.create");
  document.getElementById("form-variables").hidden = !canServer("startup.update");
  document.getElementById("form-tunnel").hidden = !canServer("allocation.update");
  document.getElementById("form-subuser").hidden = !canServer("user.create");
  document.getElementById("form-settings").hidden = !canServer("settings.rename");
  document.getElementById("btn-reinstall").hidden = !canServer("settings.reinstall");
  document.getElementById("btn-delete-server").hidden =
    !canServer("settings.delete") || !isPanelAdmin();
  const canEditResources = isPanelAdmin() && canServer("settings.resources");
  for (const id of ["settings-cpu", "settings-memory", "settings-disk"]) {
    const el = document.getElementById(id);
    // Read-only, not hidden: a server owner still sees the quota they were
    // given, but the API refuses edits from anyone but a panel admin, so the
    // form must say the same thing instead of inviting a 403.
    el.readOnly = !canEditResources;
    el.closest("label").classList.toggle("field-locked", !canEditResources);
  }
  const note = document.getElementById("settings-resources-note");
  if (note) note.hidden = canEditResources;
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

// The Minekube tunnel prints the address players actually dial into the
// console. Until the panel has it, the header falls back to the host address.
let tunnelAddress = "";

function renderServerHeader() {
  const s = currentServer;
  document.getElementById("srv-name").textContent = s.name;
  const mark = document.getElementById("srv-mark");
  if (mark) mark.textContent = s.name.slice(0, 1).toUpperCase();
  // 0.0.0.0 is the bind wildcard, not an address anyone can dial; the API
  // resolves the host's real outbound IP for players to use, and an active
  // tunnel supersedes both with the public Minekube address.
  const join =
    tunnelAddress ||
    (s.primaryAllocation ? `${s.hostIp}:${s.primaryAllocation.port}` : "no address yet");
  const meta = document.getElementById("srv-meta");
  if (meta) {
    meta.replaceChildren();
    const pair = (label, value) => {
      const chip = document.createElement("span");
      chip.className = "srv-card-meta-pair";
      const name = document.createElement("span");
      name.className = "srv-card-meta-label";
      name.textContent = label;
      chip.append(name, document.createTextNode(value));
      meta.append(chip);
    };
    pair("Software", softwareLabel(s));
    if (s.primaryAllocation) pair("Port", String(s.primaryAllocation.port));
    // The dialable address as one copyable chip: a player needs the host, not
    // the pieces it is assembled from.
    pair("Address", join);
  }
  renderStateChip(s);
  applyPowerState();
  applyConsoleNote();
}

/** Blueprint slug as a human label: 'bedrock-bds' reads badly next to a name. */
function softwareLabel(server) {
  const labels = {
    vanilla: "Vanilla",
    paper: "Paper",
    purpur: "Purpur",
    fabric: "Fabric",
    forge: "Forge",
    velocity: "Velocity",
    "bedrock-bds": "Bedrock BDS",
    "pocketmine-mp": "PocketMine-MP",
    endstone: "Endstone",
    "generic-nodejs": "Node.js",
    "generic-python": "Python",
  };
  return labels[server.blueprintSlug] ?? server.blueprintSlug;
}

// The chip answers two questions at once: which software is installed, and
// whether it is up. A suspended server says so instead of pretending to be
// offline — those mean different things to an owner.
function renderStateChip(server) {
  const chip = document.getElementById("srv-state");
  const label = document.getElementById("srv-state-label");
  if (!chip || !label) return;
  const state =
    server.status === "suspended" ? "suspended" : server.runtimeState || server.status || "offline";
  label.textContent = `${softwareLabel(server)} · ${state.replaceAll("_", " ")}`;
  chip.className = "srv-card-state srv-card-state--" + state.replaceAll("_", "-");
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

// Tabs gated by the blueprint rather than a permission: server.properties
// only exists for Minecraft Java, so offering it for Bedrock or a generic
// runtime would be a dead end.
function tabAvailableForBlueprint(tab) {
  if (!currentServer) return true;
  if (tab === "properties") return currentServer.blueprintCategory === "minecraft-java";
  return true;
}

function setTab(name, updateUrl = true) {
  const requestedName = name;
  const tabNames = [
    "overview",
    "console",
    "activity",
    "files",
    "properties",
    "addons",
    "backups",
    "schedules",
    "network",
    "users",
    "startup",
    "software",
    "egg",
    "settings",
  ];
  const available = availableServerTabs();
  if (!tabNames.includes(name) || !available.includes(name) || !tabAvailableForBlueprint(name)) {
    // The fallback must satisfy the same two gates as the request: a
    // permission-only pick can land on Properties for a Bedrock server.
    name = available.find((tab) => tabAvailableForBlueprint(tab)) || "console";
  }
  if (currentServer && (updateUrl || name !== requestedName)) {
    const method = updateUrl ? "pushState" : "replaceState";
    history[method]({}, "", `/servers/${currentServer.id}/${name}`);
  }
  const activeLink = document.querySelector(`#server-navigation [data-server-tab="${name}"]`);
  document
    .querySelectorAll("#server-navigation [data-server-tab]")
    .forEach((link) => link.classList.toggle("active", link === activeLink));
  for (const t of tabNames) {
    const panel = document.getElementById(`tab-${t}`);
    if (!panel) continue;
    const showing = t === name;
    panel.hidden = !showing;
    // Tabs swap by unhiding, which no transition can animate, so the entering
    // panel animates itself. The class must leave the node and be re-added
    // after a forced reflow, or the second visit to a tab won't animate.
    panel.classList.remove("panel-enter");
    if (showing) {
      void panel.offsetWidth;
      panel.classList.add("panel-enter");
    }
  }
  // The rail holds the live graphs, which belong to the console socket alone.
  // They stay visible on Overview too, so the landing page answers "how is
  // this server doing?" without opening the log.
  document.getElementById("server-rail").hidden = name !== "console" && name !== "overview";
  if (updateUrl && name === "files" && currentServer && canServer("file.read")) {
    // Opening Files is a fresh browse: root, every time. Remembering the last
    // folder across tab switches stranded users inside /plugins/connect/
    // with no visible breadcrumb context.
    filesDir = "";
    void refreshFiles(serverGeneration);
  }
  if (name === "activity" && currentServer && canServer("activity.read")) {
    void refreshActivity(true);
  }
  if (name === "properties" && currentServer && canServer("file.read-content")) {
    void refreshProperties();
  }
  if (name === "egg" && currentServer) void refreshEgg();
}

/* ----- console ----- */

// The REST history and the gateway's join replay overlap, and both carry the
// engine's monotonic `seq`. That counter is per server, so it is reset on every
// server switch (see leaveServer) and never compared across servers.
let consoleSeq = 0;
let serverGeneration = 0;

// Minecraft writes ANSI SGR codes into its console. A browser shows them as
// literal text ("[38;2;255;170;0m"), so each line is converted to spans here.
// The palette is Pterodactyl's, so a coloured line reads the same in both
// panels. Only SGR matters for a console: every other escape sequence (cursor
// moves, screen clears) is dropped rather than printed.
const ANSI_BASE_COLORS = [
  "#000000",
  "#E54B4B",
  "#9ECE58",
  "#FAED70",
  "#396FE2",
  "#BB80B3",
  "#2DDAFD",
  "#d0d0d0",
];
const ANSI_BRIGHT_COLORS = [
  "#555555",
  "#FF5370",
  "#C3E88D",
  "#FFCB6B",
  "#82AAFF",
  "#C792EA",
  "#89DDFF",
  "#ffffff",
];

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The xterm 256-colour cube, so `38;5;n` lands on the same shade a terminal
// would pick.
function ansi256Color(n) {
  if (n < 8) return ANSI_BASE_COLORS[n];
  if (n < 16) return ANSI_BRIGHT_COLORS[n - 8];
  if (n < 232) {
    const cube = n - 16;
    const step = (value) => (value === 0 ? 0 : 55 + value * 40);
    return `rgb(${step(Math.floor(cube / 36))},${step(Math.floor((cube % 36) / 6))},${step(cube % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
}

function ansiStyleText(style) {
  const parts = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.background) parts.push(`background:${style.background}`);
  if (style.bold) parts.push("font-weight:600");
  if (style.dim) parts.push("opacity:.7");
  if (style.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function applySgr(style, params) {
  const codes = (params === "" ? "0" : params).split(";").map(Number);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      style.color = null;
      style.background = null;
      style.bold = false;
      style.dim = false;
      style.underline = false;
    } else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 4) style.underline = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 24) style.underline = false;
    else if (code === 39) style.color = null;
    else if (code === 49) style.background = null;
    else if (code >= 30 && code <= 37) style.color = ANSI_BASE_COLORS[code - 30];
    else if (code >= 90 && code <= 97) style.color = ANSI_BRIGHT_COLORS[code - 90];
    else if (code >= 40 && code <= 47) style.background = ANSI_BASE_COLORS[code - 40];
    else if (code >= 100 && code <= 107) style.background = ANSI_BRIGHT_COLORS[code - 100];
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "color" : "background";
      const mode = codes[i + 1];
      if (mode === 5 && Number.isFinite(codes[i + 2])) {
        style[target] = ansi256Color(codes[i + 2]);
        i += 2;
      } else if (mode === 2 && [codes[i + 2], codes[i + 3], codes[i + 4]].every(Number.isFinite)) {
        style[target] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      } else {
        i += 1;
      }
    }
  }
}

// An ordinary log line keeps its text as-is and pays no span, because nothing
// is emitted for it. Style is not carried across lines: Minecraft re-emits its
// prefix on every line, and a bleed would colour everything after a truncated
// escape.
function ansiToHtml(text) {
  const style = { color: null, background: null, bold: false, dim: false, underline: false };
  let html = "";
  let plain = "";
  const flush = () => {
    if (!plain) return;
    const css = ansiStyleText(style);
    html += css ? `<span style="${css}">${escapeHtml(plain)}</span>` : escapeHtml(plain);
    plain = "";
  };
  // One complete sequence at a time: a CSI (ESC [ params intermediates final),
  // an OSC (ESC ] … BEL or ST), or a bare two-character escape. Only an SGR
  // CSI (final byte "m") styles the text; every other sequence is removed from
  // the output rather than printed. A private cursor-mode code such as
  // ESC[?25l has no letter final after digits, so the older digit-only matcher
  // walked past it and leaked its bytes as visible text.
  const escape =
    /\u001b\[([0-9;:<=>?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\|$)|\u001b[@-Z\\^_0-9<=>?a-z{|}~]/g;
  let last = 0;
  let match;
  while ((match = escape.exec(text)) !== null) {
    plain += text.slice(last, match.index);
    last = escape.lastIndex;
    // Flush with the style that was active for the text before this code.
    if (match[2] === "m") {
      flush();
      applySgr(style, match[1]);
    }
  }
  plain += text.slice(last);
  flush();
  return html;
}

// One element per line: ANSI can style it, and the oldest line can be dropped
// without re-rendering the whole buffer.
const CONSOLE_MAX_LINES = 500;

function appendLine(text) {
  const log = document.getElementById("console-log");
  // Only follow the tail when the view is already at the bottom, so scrolling
  // back through history is not yanked away by the next streamed line.
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const line = document.createElement("div");
  line.className = "console-line";
  line.innerHTML = ansiToHtml(text);
  log.append(line);
  while (log.childElementCount > CONSOLE_MAX_LINES) log.firstElementChild.remove();
  if (pinned) log.scrollTop = log.scrollHeight;
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

// Which process the on-screen console belongs to. A restart that happens
// while the client is offline emits a reset event nobody hears, so the join
// replay carries the server's run id instead: a different id means everything
// on screen came from a process that is gone.
let consoleRun = null;

function adoptRun(run) {
  if (typeof run !== "number") return;
  // First sight: the REST history already painted the current run, so this
  // only records which run it was. Clearing here would throw away the 200
  // lines the REST read fetched in favour of the socket's 100.
  if (consoleRun === null) {
    consoleRun = run;
    return;
  }
  if (run === consoleRun) return;
  consoleRun = run;
  // Deliberately NOT rewinding consoleSeq here. The engine's counter is
  // monotonic across runs, so the new run's lines are always above the
  // watermark and the replay that may follow passes on its own. Rewinding
  // would instead let a straggler from the dying process — one that raced
  // ahead of the reset — land in the console just cleared.
  document.getElementById("console-log").textContent = "";
  resetStatSeries();
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
  // Adopt the run before the socket join arrives: if the server restarts
  // between this read and that replay, the replay names a different run and
  // the view has to start over. Without it the first replay would always be a
  // "first sight" and would be appended to whatever is already on screen.
  adoptRun(data.run);
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
    adoptRun(msg?.run);
    for (const line of msg?.lines ?? []) appendConsoleLine(line, generation);
  });
  socket.on("console:line", (msg) => appendConsoleLine(msg.line, generation));
  // A restart is a new run: the engine drops the old scrollback and says so,
  // so the console starts from zero instead of stacking every run the server
  // has ever had. No replay follows a live reset, so the seq watermark is
  // left where it is — see adoptRun for why rewinding it would be wrong here.
  socket.on("console:reset", (msg) => {
    if (generation !== serverGeneration) return;
    adoptRun(msg?.run);
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

// Back/forward cache restores the page without refiring scripts, but kills
// the underlying TCP connection: the socket client still reports connected
// while nothing flows ("The WebSocket connection ... was interrupted" is the
// visible symptom). Restore the live view the way a fresh visit would:
// rebuild the socket and replay the console history, dedupe handles overlap.
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  if (!currentServer || !canServer("websocket.connect")) return;
  joinConsoleSocket();
  void refreshConsoleHistory(serverGeneration);
});

// 60 samples at the engine's 2s cadence is two minutes of history. The ring
// is the client's own — the server pushes samples and keeps none, so there is
// nothing to replay and nothing to re-add for symmetry. It is cleared when the
// run changes or the view is left. Samples taken while the server is not
// running are recorded as null and draw at the baseline with the label
// reading "—", so a missing reading is never shown as a measurement of zero.
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

const selectedFiles = new Set();
let currentDirItems = [];

function updateBulkBar() {
  const bar = document.getElementById("files-bulk-bar");
  const countEl = document.getElementById("files-selected-count");
  const selectAll = document.getElementById("file-select-all");
  const count = selectedFiles.size;
  if (!bar || !countEl) return;
  countEl.textContent = `${count} item${count === 1 ? "" : "s"} selected`;
  bar.hidden = count === 0;

  const btnDownload = document.getElementById("btn-bulk-download");
  const btnArchive = document.getElementById("btn-bulk-compress");
  const btnExtract = document.getElementById("btn-bulk-decompress");
  const btnDelete = document.getElementById("btn-bulk-delete");

  if (btnDownload) btnDownload.hidden = !canServer("file.read-content");
  if (btnArchive) btnArchive.hidden = !canServer("file.archive");
  if (btnExtract) btnExtract.hidden = !canServer("file.archive");
  if (btnDelete) btnDelete.hidden = !canServer("file.delete");

  if (selectAll) {
    selectAll.checked = currentDirItems.length > 0 && count === currentDirItems.length;
    selectAll.indeterminate = count > 0 && count < currentDirItems.length;
  }
}

async function refreshFiles(generation) {
  const list = document.getElementById("file-list");
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  list.innerHTML = "";
  selectedFiles.clear();
  currentDirItems = [];
  updateBulkBar();

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
  currentDirItems = data.items;
  updateBulkBar();

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
    li.className = "file-row";
    const relativePath = filesDir ? `${filesDir}/${item.name}` : item.name;
    li.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      showFileContextMenu(event, item, relativePath);
    });
    // The keyboard equivalent: menu key, or Shift+F10 on layouts without one.
    li.addEventListener("keydown", (event) => {
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      showFileContextMenu(event, item, relativePath);
    });

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "file-item-check";
    check.checked = selectedFiles.has(item.name);
    check.setAttribute("aria-label", `Select ${item.name}`);
    check.addEventListener("change", (e) => {
      e.stopPropagation();
      if (check.checked) {
        selectedFiles.add(item.name);
      } else {
        selectedFiles.delete(item.name);
      }
      updateBulkBar();
    });

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
    if (!item.isDir && canServer("file.read-content")) {
      addAction("Download", "file.read-content", () => downloadFile(relative), false);
    }
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
    li.append(check, btn, meta, actions);
    list.append(li);
  }
}

async function downloadFile(path) {
  const err = document.getElementById("files-error");
  if (err) err.hidden = true;
  try {
    const res = await fetch(
      `${API}/servers/${currentServer.id}/files/download?path=${encodeURIComponent(path)}`,
      {
        headers: { Authorization: `Bearer ${store.token}` },
      },
    );
    if (!res.ok) {
      fail(err, `Download failed: HTTP ${res.status}`);
      return;
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = basename(path);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch {
    fail(err, "Network error downloading file.");
  }
}

document.getElementById("file-select-all")?.addEventListener("change", (e) => {
  const checked = e.target.checked;
  selectedFiles.clear();
  if (checked) {
    for (const item of currentDirItems) {
      selectedFiles.add(item.name);
    }
  }
  document.querySelectorAll(".file-item-check").forEach((cb) => {
    cb.checked = checked;
  });
  updateBulkBar();
});

document.getElementById("btn-bulk-clear")?.addEventListener("click", () => {
  selectedFiles.clear();
  document.querySelectorAll(".file-item-check").forEach((cb) => {
    cb.checked = false;
  });
  updateBulkBar();
});

document.getElementById("btn-bulk-delete")?.addEventListener("click", async () => {
  if (selectedFiles.size === 0) return;
  if (
    !window.confirm(
      `Delete ${selectedFiles.size} selected item${selectedFiles.size === 1 ? "" : "s"}? This cannot be undone.`,
    )
  )
    return;
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const paths = Array.from(selectedFiles).map((name) => (filesDir ? `${filesDir}/${name}` : name));
  const res = await api(`/servers/${currentServer.id}/files/delete`, {
    method: "POST",
    token: store.token,
    body: { paths },
  });
  if (res.status !== 204) {
    fail(err, describeProblem(res.status, res.data));
  } else {
    selectedFiles.clear();
    if (success) {
      success.textContent = `Deleted ${paths.length} item${paths.length === 1 ? "" : "s"}.`;
      success.hidden = false;
    }
    refreshFiles();
  }
});

document.getElementById("btn-bulk-compress")?.addEventListener("click", async () => {
  if (selectedFiles.size === 0) return;
  const name = window.prompt("Archive name (e.g. backup.tar.gz):", "archive.tar.gz");
  if (!name) return;
  const archiveBasename = basename(name);
  if (!archiveBasename) return;
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const filesList = Array.from(selectedFiles);
  const paths = filesList.map((n) => (filesDir ? `${filesDir}/${n}` : n));
  const res = await api(`/servers/${currentServer.id}/files/compress`, {
    method: "POST",
    token: store.token,
    body: { root: filesDir, files: filesList, paths, archiveName: archiveBasename },
  });
  if (res.status !== 200) {
    fail(err, describeProblem(res.status, res.data));
  } else {
    selectedFiles.clear();
    if (success) {
      success.textContent = `Archive "${archiveBasename}" created successfully.`;
      success.hidden = false;
    }
    refreshFiles();
  }
});

document.getElementById("btn-bulk-decompress")?.addEventListener("click", async () => {
  if (selectedFiles.size === 0) return;
  const archiveItem = Array.from(selectedFiles).find((name) =>
    /\.(tar\.gz|tgz|zip|tar)$/i.test(name),
  );
  if (!archiveItem) {
    window.alert("Please select an archive file (.tar.gz, .tgz, .zip, .tar) to extract.");
    return;
  }
  const relative = filesDir ? `${filesDir}/${archiveItem}` : archiveItem;
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const res = await api(`/servers/${currentServer.id}/files/decompress`, {
    method: "POST",
    token: store.token,
    body: { path: relative },
  });
  if (res.status !== 200 && res.status !== 204) {
    fail(err, describeProblem(res.status, res.data));
  } else {
    selectedFiles.clear();
    if (success) {
      success.textContent = `Extracted "${archiveItem}" successfully.`;
      success.hidden = false;
    }
    refreshFiles();
  }
});

document.getElementById("btn-bulk-download")?.addEventListener("click", async () => {
  if (selectedFiles.size === 0) return;
  const items = Array.from(selectedFiles);
  if (items.length === 1) {
    const single = currentDirItems.find((i) => i.name === items[0]);
    if (single && !single.isDir) {
      const path = filesDir ? `${filesDir}/${single.name}` : single.name;
      await downloadFile(path);
      return;
    }
  }
  const archiveBasename = `download-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`;
  const paths = items.map((name) => (filesDir ? `${filesDir}/${name}` : name));
  const res = await api(`/servers/${currentServer.id}/files/compress`, {
    method: "POST",
    token: store.token,
    body: { root: filesDir, files: items, paths, archiveName: archiveBasename },
  });
  if (res.status === 200) {
    const downloadPath =
      res.data?.archive || (filesDir ? `${filesDir}/${archiveBasename}` : archiveBasename);
    await downloadFile(downloadPath);
    await api(`/servers/${currentServer.id}/files/delete`, {
      method: "POST",
      token: store.token,
      body: { path: downloadPath },
    });
    refreshFiles();
  } else {
    fail(document.getElementById("files-error"), describeProblem(res.status, res.data));
  }
});

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
  if (status !== 204) {
    fail(err, describeProblem(status, data));
    showToast(describeProblem(status, data), "error");
  } else {
    err.hidden = true;
    showToast("File saved successfully.", "success");
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

/* ----- plugins (addons) ----- */

let addonSearchQuery = "";
let addonSearchPage = 1;
const addonSearchLimit = 10;
let addonSearchTotalPages = 1;

let addonInstalledPage = 1;
const addonInstalledPageSize = 6;
// "plugin" | "mod" | "bedrock" | null — mirrors the capability endpoint so
// the installed list filters the right folder between capability refreshes.
let addonCapabilityKind = null;

async function refreshAddons(generation) {
  const list = document.getElementById("addon-list");
  const err = document.getElementById("addons-error");
  const pager = document.getElementById("addons-installed-pagination");
  const title = document.getElementById("addon-installed-title");
  if (err) err.hidden = true;
  if (!list) return;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${currentServer.id}/addons`, { token: store.token });
  if (isStaleLoad(generation)) return;
  if (status !== 200) {
    fail(err, "You don't have permission to see plugins.");
    return;
  }
  // The tab lists the folder the capability serves: mods on mod loaders,
  // plugins everywhere else — the server-side list returns both folders.
  const folder = addonCapabilityKind === "mod" ? "mods" : "plugins";
  const noun = folder === "mods" ? "mods" : "plugins";
  const lede = document.getElementById("addon-installed-lede");
  if (lede) {
    lede.textContent = `${noun === "mods" ? "Mods" : "Plugins"} in your /${folder} folder. Changes apply after a restart.`;
  }
  const installed = (data.addons || []).filter((a) => a.folder === folder);
  if (title) title.textContent = `Installed (${installed.length})`;
  if (installed.length === 0) {
    if (pager) pager.hidden = true;
    const li = document.createElement("li");
    li.className = "empty-state";
    li.textContent = `No ${noun} installed yet. Search Modrinth below to install ${noun}.`;
    list.append(li);
    return;
  }
  const totalPages = Math.max(1, Math.ceil(installed.length / addonInstalledPageSize));
  addonInstalledPage = Math.min(addonInstalledPage, totalPages);
  const start = (addonInstalledPage - 1) * addonInstalledPageSize;
  const visible = installed.slice(start, start + addonInstalledPageSize);
  if (pager) {
    pager.hidden = installed.length <= addonInstalledPageSize;
    const prev = document.getElementById("btn-installed-prev");
    const next = document.getElementById("btn-installed-next");
    const indicator = document.getElementById("installed-page-indicator");
    if (prev) prev.disabled = addonInstalledPage <= 1;
    if (next) next.disabled = addonInstalledPage >= totalPages;
    if (indicator) indicator.textContent = `${addonInstalledPage} of ${totalPages}`;
  }
  for (const a of visible) {
    const li = document.createElement("li");
    li.className = "addon-installed";
    // Jar files carry no icon of their own; the plugin's initial stands in,
    // which is enough to tell rows apart while scanning a long list.
    const icon = document.createElement("span");
    icon.className = "addon-installed-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = a.name.slice(0, 1).toUpperCase();
    const body = document.createElement("span");
    body.className = "addon-installed-body";
    const displayName = document.createElement("span");
    displayName.className = "addon-installed-name";
    displayName.textContent = a.name.replace(/\.jar$/i, "");
    displayName.title = a.name;
    const meta = document.createElement("span");
    meta.className = "addon-installed-meta";
    meta.textContent = `${a.name} · ${formatFileSize(a.bytes)}`;
    body.append(displayName, meta);
    const actions = document.createElement("span");
    actions.className = "file-actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "linklike danger-text";
    remove.textContent = "Remove";
    remove.hidden = !canServer("startup.update");
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Remove ${noun === "mods" ? "mod" : "plugin"} "${a.name}"?`)) return;
      const res = await api(
        `/servers/${currentServer.id}/addons/${a.folder}/${encodeURIComponent(a.name)}`,
        { method: "DELETE", token: store.token },
      );
      if (res.status !== 204) {
        fail(err, describeProblem(res.status, res.data));
      } else {
        const success = document.getElementById("addons-alert-success");
        if (success) {
          success.textContent = `Removed ${noun === "mods" ? "mod" : "plugin"} "${a.name}".`;
          success.hidden = false;
        }
        refreshAddons();
      }
    });
    actions.append(remove);
    li.append(icon, body, actions);
    list.append(li);
  }
}

document.getElementById("btn-installed-prev")?.addEventListener("click", () => {
  if (addonInstalledPage > 1) {
    addonInstalledPage -= 1;
    void refreshAddons();
  }
});

document.getElementById("btn-installed-next")?.addEventListener("click", () => {
  addonInstalledPage += 1;
  void refreshAddons();
});

/**
 * BDS packs: list what is installed under behavior_packs/ and
 * resource_packs/ and let owners remove a pack. There is no search here on
 * purpose — no public Bedrock addon registry exists that the panel can call
 * (Modrinth has zero bedrock loaders; CurseForge requires an API key), so
 * packs arrive through the Files tab.
 */
async function refreshBedrockPacks() {
  const section = document.getElementById("bedrock-packs-section");
  const list = document.getElementById("bedrock-packs-list");
  if (!section || !list) return;
  // Revalidate after the await: switching servers while the pack listing is
  // in flight must not paint the previous server's packs here.
  const serverId = currentServer?.id;
  const generation = serverGeneration;
  const { status, data } = await api(`/servers/${serverId}/addons/bedrock`, {
    token: store.token,
  });
  if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
  list.replaceChildren();
  if (status !== 200) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const packs = data.packs ?? [];
  if (packs.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = "No packs installed yet.";
    list.append(empty);
    return;
  }
  for (const pack of packs) {
    const li = document.createElement("li");
    li.className = "file-row";
    const name = document.createElement("span");
    name.className = "addon-name";
    name.textContent = pack.name + (pack.version ? ` · ${pack.version}` : "");
    const kind = document.createElement("span");
    kind.className = "chip";
    kind.textContent = pack.type === "behavior_packs" ? "behavior" : "resource";
    li.append(name, kind);
    if (canServer("startup.update")) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "secondary";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        if (!window.confirm(`Remove pack "${pack.name}"?`)) return;
        const del = await api(
          `/servers/${currentServer.id}/addons/bedrock/${pack.type}/${encodeURIComponent(pack.folder)}`,
          { method: "DELETE", token: store.token },
        );
        if (del.status === 204) {
          showToast(`Removed ${pack.name}.`, "success");
        } else {
          showToast(describeProblem(del.status, del.data), "error");
        }
        void refreshBedrockPacks();
      });
      li.append(removeBtn);
    }
    list.append(li);
  }
}

async function refreshAddonCapability(generation) {
  const note = document.getElementById("addon-search-note");
  const { status, data } = await api(`/servers/${currentServer.id}/addons/capability`, {
    token: store.token,
  });
  if (isStaleLoad(generation)) return;
  const navLink = document.getElementById("server-nav-addons");
  const kind = status === 200 ? data.kind : null;
  const supported = status === 200 && data.supported;
  const usable = supported && canServer("startup.read");
  const kindChanged = addonCapabilityKind !== (usable ? kind : null);
  addonCapabilityKind = usable ? kind : null;
  if (navLink) navLink.hidden = !usable;
  // The installed list may have painted before the kind was known or with a
  // stale kind (openServer now awaits this, but swaps fire it fire-and-forget);
  // re-derive the list only when the folder decision actually changed.
  if (usable && kindChanged) void refreshAddons(generation);
  if (!usable) {
    if (!document.getElementById("tab-addons").hidden) {
      setTab(availableServerTabs()[0] || "console");
    }
    return;
  }
  const navLabel = document.getElementById("server-nav-addons-label");
  if (navLabel)
    navLabel.textContent = kind === "bedrock" ? "Addons" : kind === "mod" ? "Mods" : "Plugins";
  const isBedrock = kind === "bedrock";
  // The jar "Installed" list, the Modrinth browse form and their ledes are
  // plugin/mod furniture; BDS gets its pack list instead. The pack section
  // must also re-hide when a Bedrock server swaps to non-Bedrock software.
  for (const id of [
    "addon-list",
    "addons-installed-pagination",
    "addon-browse-title",
    "addon-browse-lede",
    "addon-installed-lede",
  ]) {
    const el = document.getElementById(id);
    if (el) el.hidden = isBedrock;
  }
  if (!isBedrock) {
    const packs = document.getElementById("bedrock-packs-section");
    if (packs) packs.hidden = true;
  }
  const browseBar = document.getElementById("form-addon-search");
  if (browseBar) browseBar.hidden = isBedrock;
  const cards = document.getElementById("addon-cards-container");
  if (cards) cards.hidden = isBedrock;
  const searchPagination = document.getElementById("addons-pagination");
  if (searchPagination) searchPagination.hidden = true;
  if (isBedrock) {
    // BDS has no search backend (Modrinth ships zero bedrock loaders), so
    // the tab shows installed packs instead of a search form.
    if (note) {
      note.hidden = false;
      note.textContent =
        "Bedrock addons install from the Files tab: upload a .mcpack/.mcaddon and extract it into behavior_packs/ or resource_packs/. Installed packs appear below.";
    }
    void refreshBedrockPacks();
    return;
  }
  if (note) note.hidden = true;
  if (!addonSearchQuery) {
    void executeAddonSearch("", 1);
  }
}

async function executeAddonSearch(query, page = 1) {
  addonSearchQuery = query;
  addonSearchPage = page;
  const serverId = currentServer?.id;
  const generation = serverGeneration;
  const container = document.getElementById("addon-cards-container");
  const note = document.getElementById("addon-search-note");
  const err = document.getElementById("addons-alert-error");
  const pagination = document.getElementById("addons-pagination");
  const prevBtn = document.getElementById("btn-addons-prev");
  const nextBtn = document.getElementById("btn-addons-next");
  const pageIndicator = document.getElementById("addons-page-indicator");

  if (err) err.hidden = true;
  if (!container) return;
  container.innerHTML = "";

  const qs = `?q=${encodeURIComponent(query)}&page=${page}&limit=${addonSearchLimit}`;
  const { status, data } = await api(`/servers/${serverId}/addons/search${qs}`, {
    token: store.token,
  });

  if (generation !== serverGeneration || currentServer?.id !== serverId) return;
  if (status !== 200) {
    if (note) {
      note.hidden = false;
      note.textContent = describeProblem(status, data);
    }
    if (pagination) pagination.hidden = true;
    return;
  }
  if (note) note.hidden = true;
  // The filter chips restate the two constraints the server enforces: the
  // loader results must match and the exact Minecraft version. Showing them
  // here saves a user wondering why a 1.20-only plugin is missing.
  const loaderLabel = document.getElementById("addon-loader-label");
  if (loaderLabel && currentServer) loaderLabel.textContent = softwareLabel(currentServer);
  const versionLabel = document.getElementById("addon-version-label");
  if (versionLabel && data.mcVersion) versionLabel.textContent = data.mcVersion;

  if (!data.hits || data.hits.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = `No plugins found${query ? ` matching "${query}"` : ""}.`;
    container.replaceChildren(p);
    if (pagination) pagination.hidden = true;
    return;
  }

  addonSearchTotalPages = data.totalPages || 1;
  if (pagination) {
    pagination.hidden = false;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= addonSearchTotalPages;
    if (pageIndicator) {
      pageIndicator.textContent = `Page ${page} of ${addonSearchTotalPages} (${data.totalHits} plugins)`;
    }
  }

  for (const hit of data.hits) {
    const card = document.createElement("div");
    card.className = "addon-card";

    const header = document.createElement("div");
    header.className = "addon-card-header";

    // The icon box is always a div of fixed size; the <img> fills it. A plain
    // <img> with the box's own class rendered at the image's intrinsic size,
    // and a failed load left an empty gap where the project mark should be.
    const iconBox = document.createElement("div");
    iconBox.className = "addon-card-icon";
    if (hit.iconUrl) {
      const icon = document.createElement("img");
      icon.src = hit.iconUrl;
      icon.alt = "";
      icon.loading = "lazy";
      // The box is a fixed 46×46; declaring the intrinsic size lets the
      // browser reserve the slot before the bytes arrive (kills the
      // "width/height to reduce layout shift" Lighthouse hint) instead of
      // measuring the placeholder as 0×0.
      icon.width = 46;
      icon.height = 46;
      // A blocked or dead icon must not leave a hole where the mark was.
      icon.addEventListener("error", () => {
        iconBox.textContent = "✦";
      });
      iconBox.append(icon);
    } else {
      iconBox.textContent = "✦";
    }
    header.append(iconBox);

    const titleGroup = document.createElement("div");
    titleGroup.className = "addon-card-title-group";
    const title = document.createElement("h4");
    title.className = "addon-card-title";
    title.textContent = hit.title;
    const author = document.createElement("span");
    author.className = "addon-card-author";
    author.textContent = `by ${hit.author}`;
    titleGroup.append(title, author);
    header.append(titleGroup);

    const desc = document.createElement("p");
    desc.className = "addon-card-desc";
    desc.textContent = hit.description || "No description provided.";

    const footer = document.createElement("div");
    footer.className = "addon-card-footer";
    const meta = document.createElement("span");
    meta.className = "addon-card-meta";
    meta.textContent = formatDownloads(hit.downloads);

    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "secondary addon-install-btn";
    installBtn.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 2.4v7.2M5 6.8L8 9.8l3-3M3 12.6h10"/></svg>';
    installBtn.append(document.createTextNode("Install"));
    installBtn.hidden = !canServer("startup.update");

    installBtn.addEventListener("click", () => void handleInstallAddon(hit, installBtn));

    footer.append(meta, installBtn);
    card.append(header, desc, footer);
    container.append(card);
  }
}

/** Modrinth counts are large; '103.6M' reads faster than '103600000'. */
function formatDownloads(count) {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/** Jar sizes are quoted in MiB — the unit a plugin folder is described in. */
function formatFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function handleInstallAddon(hit, installBtn) {
  const serverId = currentServer.id;
  const successAlert = document.getElementById("addons-alert-success");
  const errorAlert = document.getElementById("addons-alert-error");
  if (successAlert) successAlert.hidden = true;
  if (errorAlert) errorAlert.hidden = true;

  installBtn.disabled = true;
  installBtn.textContent = "Checking...";

  const { status, data } = await api(`/servers/${serverId}/addons/versions/${hit.projectId}`, {
    token: store.token,
  });

  if (status !== 200) {
    installBtn.disabled = false;
    installBtn.textContent = "Install";
    if (errorAlert) fail(errorAlert, describeProblem(status, data));
    return;
  }

  if (!data.versions || data.versions.length === 0) {
    installBtn.disabled = false;
    installBtn.textContent = "Install";
    if (errorAlert) fail(errorAlert, "No compatible versions found for this server.");
    return;
  }

  if (data.versions.length > 1) {
    installBtn.disabled = false;
    installBtn.textContent = "Install";
    openAddonVersionDialog(hit, data.versions);
    return;
  }

  const versionId = data.versions[0]?.id;
  installBtn.textContent = "Installing...";
  const res = await api(`/servers/${serverId}/addons`, {
    method: "POST",
    token: store.token,
    body: { projects: [hit.projectId], versionId },
  });

  installBtn.disabled = false;
  installBtn.textContent = "Install";

  if (res.status !== 201 && res.status !== 200) {
    if (errorAlert) fail(errorAlert, describeProblem(res.status, res.data));
    showToast(
      `Failed to install "${hit.title}": ${describeProblem(res.status, res.data)}`,
      "error",
    );
  } else if (res.status === 200) {
    // 200 = every requested file was already installed (nothing downloaded).
    if (successAlert) {
      successAlert.textContent = `"${hit.title}" is already installed — nothing to download.`;
      successAlert.hidden = false;
    }
    showToast(`"${hit.title}" is already installed.`, "success");
    refreshAddons();
  } else {
    if (successAlert) {
      successAlert.textContent = `Plugin "${hit.title}" installed successfully! It will activate on the next server start.`;
      successAlert.hidden = false;
    }
    showToast(`Plugin "${hit.title}" installed successfully!`, "success");
    refreshAddons();
  }
}

function openAddonVersionDialog(hit, versions) {
  const dialog = document.getElementById("addon-version-dialog");
  const title = document.getElementById("version-dialog-title");
  const subtitle = document.getElementById("version-dialog-subtitle");
  const list = document.getElementById("version-list-container");
  const err = document.getElementById("version-dialog-error");
  if (!dialog || !list) return;

  if (err) err.hidden = true;
  if (title) title.textContent = `Install ${hit.title}`;
  if (subtitle) subtitle.textContent = `Select a version for your server:`;
  list.innerHTML = "";

  for (const v of versions) {
    const item = document.createElement("div");
    item.className = "version-item";

    const info = document.createElement("div");
    info.className = "version-info";
    const vName = document.createElement("span");
    vName.className = "version-name";
    vName.textContent = v.name || v.versionNumber;

    const vMeta = document.createElement("div");
    vMeta.className = "version-meta";
    const typeChip = document.createElement("span");
    typeChip.className = "chip";
    typeChip.textContent = v.versionType || "release";
    const gv = document.createElement("span");
    gv.textContent = `MC ${v.gameVersions?.join(", ") || ""}`;
    vMeta.append(typeChip, gv);
    info.append(vName, vMeta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Install";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Installing...";
      const res = await api(`/servers/${currentServer.id}/addons`, {
        method: "POST",
        token: store.token,
        body: { projects: [hit.projectId], versionId: v.id },
      });
      btn.disabled = false;
      btn.textContent = "Install";
      if (res.status !== 201 && res.status !== 200) {
        if (err) fail(err, describeProblem(res.status, res.data));
        showToast(
          `Failed to install "${hit.title}": ${describeProblem(res.status, res.data)}`,
          "error",
        );
      } else if (res.status === 200) {
        // 200 = every requested file was already installed (nothing new).
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
        showToast(`"${hit.title}" is already installed.`, "success");
      } else {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
        const successAlert = document.getElementById("addons-alert-success");
        if (successAlert) {
          successAlert.textContent = `Plugin "${hit.title}" (${v.versionNumber}) installed successfully! It will activate on the next server start.`;
          successAlert.hidden = false;
        }
        showToast(`Plugin "${hit.title}" installed successfully!`, "success");
        refreshAddons();
      }
    });

    item.append(info, btn);
    list.append(item);
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

document.getElementById("btn-addon-version-close")?.addEventListener("click", () => {
  const dialog = document.getElementById("addon-version-dialog");
  if (dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
});

document.getElementById("btn-addons-prev")?.addEventListener("click", () => {
  if (addonSearchPage > 1) {
    void executeAddonSearch(addonSearchQuery, addonSearchPage - 1);
  }
});

document.getElementById("btn-addons-next")?.addEventListener("click", () => {
  if (addonSearchPage < addonSearchTotalPages) {
    void executeAddonSearch(addonSearchQuery, addonSearchPage + 1);
  }
});

document.getElementById("form-addon-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const query = String(new FormData(e.target).get("q") || "").trim();
  void executeAddonSearch(query, 1);
});

/* ----- server software & game swapper ----- */

let softwarePage = 1;
const softwareLimit = 10;
let softwareTotalPages = 1;
let pendingSwapSoftware = null;

async function refreshSoftware(generation) {
  if (!currentServer) return;
  const container = document.getElementById("software-cards-container");
  const curName = document.getElementById("current-software-name");
  const curDesc = document.getElementById("current-software-desc");
  const curBadge = document.getElementById("current-software-runtime-badge");
  const err = document.getElementById("software-alert-error");
  const pagination = document.getElementById("software-pagination");
  const prevBtn = document.getElementById("btn-software-prev");
  const nextBtn = document.getElementById("btn-software-next");
  const pageIndicator = document.getElementById("software-page-indicator");

  if (err) err.hidden = true;
  if (!container) return;
  container.innerHTML = "";

  const serverId = currentServer.id;
  const qs = `?scope=software&page=${softwarePage}&limit=${softwareLimit}`;
  const { status, data } = await api(`/servers/${serverId}/software${qs}`, {
    token: store.token,
  });

  // Same reasoning as refreshEgg: callers without a generation would otherwise
  // render the previous server's software list into this one's tab.
  if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
  if (status !== 200) {
    if (err) fail(err, describeProblem(status, data));
    return;
  }

  if (curName) curName.textContent = `${data.current.name} (${data.current.slug})`;
  if (curDesc) curDesc.textContent = data.current.description || "";
  if (curBadge) {
    const state = currentServer.runtimeState || "offline";
    if (state === "offline") {
      curBadge.textContent = "Offline — Safe to switch software";
      curBadge.style.color = "var(--ok)";
    } else {
      curBadge.textContent = `${state} — Stop server to switch software`;
      curBadge.style.color = "var(--accent)";
    }
  }

  softwareTotalPages = data.totalPages || 1;
  if (pagination) {
    pagination.hidden = data.total <= softwareLimit;
    if (prevBtn) prevBtn.disabled = softwarePage <= 1;
    if (nextBtn) nextBtn.disabled = softwarePage >= softwareTotalPages;
    if (pageIndicator) {
      pageIndicator.textContent = `Page ${softwarePage} of ${softwareTotalPages} (${data.total} software options)`;
    }
  }

  if (data.items.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No other software in this game's ecosystem is installed on this panel.";
    container.append(p);
    return;
  }

  const activeSlug = data.current.blueprintSlug || data.current.slug;
  const items = data.items || data.software || [];
  for (const s of items) {
    const isCurrent = s.slug === activeSlug || s.blueprintSlug === activeSlug;
    const card = document.createElement("div");
    card.className = "software-card" + (isCurrent ? " current" : "");

    const body = document.createElement("div");
    body.className = "software-card-body";
    const category = document.createElement("span");
    category.className = "eyebrow";
    category.textContent = s.category;
    const title = document.createElement("h4");
    title.textContent = s.name;
    const desc = document.createElement("p");
    desc.className = "software-card-desc";
    desc.textContent = s.description || "";
    body.append(category, title, desc);

    const footer = document.createElement("div");
    footer.className = "software-card-footer";
    if (isCurrent) {
      const activeChip = document.createElement("span");
      activeChip.className = "chip";
      activeChip.textContent = "Running now";
      footer.append(activeChip);
    } else {
      const switchBtn = document.createElement("button");
      switchBtn.type = "button";
      switchBtn.className = "secondary";
      switchBtn.textContent = `Switch to ${s.name}`;
      switchBtn.hidden = !canServer("settings.reinstall");
      switchBtn.addEventListener("click", () => openSoftwareSwapDialog(s, data.current));
      footer.append(switchBtn);
    }

    card.append(body, footer);
    container.append(card);
  }
}

function openSoftwareSwapDialog(targetSoftware, currentSoftware) {
  const dialog = document.getElementById("software-swap-dialog");
  const targetNameEl = document.getElementById("swap-target-software-name");
  const descEl = document.getElementById("swap-dialog-desc");
  const backupCheckbox = document.getElementById("swap-backup-checkbox");
  const eulaContainer = document.getElementById("swap-eula-container");
  const eulaCheckbox = document.getElementById("swap-eula-checkbox");
  const err = document.getElementById("swap-dialog-error");
  const confirmBtn = document.getElementById("btn-software-swap-confirm");

  if (!dialog) return;
  pendingSwapSoftware = targetSoftware;

  if (err) err.hidden = true;
  if (targetNameEl) targetNameEl.textContent = targetSoftware.name;
  if (descEl) {
    descEl.textContent = `You are about to swap from ${currentSoftware.name} to ${targetSoftware.name} (${targetSoftware.category}).`;
  }
  if (backupCheckbox) backupCheckbox.checked = true;

  if (eulaContainer && eulaCheckbox) {
    const needsEula = targetSoftware.category === "minecraft-java";
    eulaContainer.hidden = !needsEula;
    eulaCheckbox.checked = false;
  }

  const isRunning = currentServer.runtimeState && currentServer.runtimeState !== "offline";
  if (isRunning) {
    if (err) {
      fail(
        err,
        "The server is currently running. Please stop the server before switching software or swapping games.",
      );
    }
    if (confirmBtn) confirmBtn.disabled = true;
  } else {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = `Switch to ${targetSoftware.name}`;
    }
  }

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

document.getElementById("btn-software-swap-close")?.addEventListener("click", () => {
  const dialog = document.getElementById("software-swap-dialog");
  if (dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
});

document.getElementById("btn-software-swap-cancel")?.addEventListener("click", () => {
  const dialog = document.getElementById("software-swap-dialog");
  if (dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }
});

document.getElementById("btn-software-swap-confirm")?.addEventListener("click", async () => {
  if (!pendingSwapSoftware || !currentServer) return;
  const dialog = document.getElementById("software-swap-dialog");
  const confirmBtn = document.getElementById("btn-software-swap-confirm");
  const backupCheckbox = document.getElementById("swap-backup-checkbox");
  const eulaCheckbox = document.getElementById("swap-eula-checkbox");
  const err = document.getElementById("swap-dialog-error");
  const successAlert = document.getElementById("software-alert-success");

  const needsEula = pendingSwapSoftware.category === "minecraft-java";
  if (needsEula && eulaCheckbox && !eulaCheckbox.checked) {
    if (err) fail(err, "You must accept the Minecraft EULA to switch to Minecraft software.");
    return;
  }

  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Switching & Installing...";
  }

  const createBackup = backupCheckbox ? backupCheckbox.checked : true;
  const res = await api(`/servers/${currentServer.id}/software`, {
    method: "PUT",
    token: store.token,
    body: {
      blueprintSlug: pendingSwapSoftware.slug,
      backupBeforeSwap: createBackup,
      createBackup,
      eulaAccepted: eulaCheckbox ? eulaCheckbox.checked : undefined,
    },
  });

  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = `Switch to ${pendingSwapSoftware.name}`;
  }

  if (res.status === 202) {
    // The install runs in the background now; the API returns before the
    // downloads finish, so a multi-minute Fabric/Forge swap no longer dies
    // as a proxy 502.
    if (dialog) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    if (successAlert) {
      successAlert.textContent = `Swapping to ${pendingSwapSoftware.name} — the install is running in the background. This page updates when it finishes.`;
      successAlert.hidden = false;
    }
    showToast(`Installing ${pendingSwapSoftware.name}…`, "success");
    const settled = await awaitServerInstall(currentServer.id);
    if (settled && settled.status === "ready") {
      showToast(`Swapped to ${pendingSwapSoftware.name}.`, "success");
    } else if (settled && settled.status === "install_failed") {
      if (successAlert) successAlert.hidden = true;
      if (err)
        fail(
          err,
          "The software install failed. Check the server overview for details, then try the swap again.",
        );
      showToast("The software install failed.", "error");
    }
    await refreshAfterSwap();
    return;
  }

  if (res.status !== 200 && res.status !== 202) {
    if (err) fail(err, describeProblem(res.status, res.data));
    return;
  }

  if (dialog) {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  if (successAlert) {
    const backupNotice = createBackup
      ? " A complete backup of your previous files was created."
      : "";
    successAlert.textContent = `Successfully swapped to ${pendingSwapSoftware.name}!${backupNotice} You can now review your startup settings and start your server.`;
    successAlert.hidden = false;
    showToast(`Swapped to ${pendingSwapSoftware.name}.`, "success");
  }

  await refreshAfterSwap();
});

/**
 * Everything that is a function of the server's blueprint must be refreshed
 * after a swap: the tab set (applyServerPermissions), the Plugins/Mods/Addons
 * tab label and visibility (refreshAddonCapability), software + variables.
 * Without this a Paper→BDS swap left the jar list and search visible, and
 * Java↔Bedrock swaps left a stale Properties link until a full page reload.
 */
async function refreshAfterSwap() {
  const srv = await api(`/servers/${currentServer.id}`, { token: store.token });
  if (srv.status === 200) {
    currentServer = srv.data.server;
    renderServerHeader();
    renderServerNav();
    applyServerPermissions();
  }
  void refreshAddonCapability(serverGeneration);
  // A swap can change the folder contents even when the capability kind stays
  // the same (paper → purpur), so always re-read the installed list; the
  // capability hook skips its own refresh when the kind did not change.
  void refreshAddons(serverGeneration);
  refreshSoftware();
  refreshVariables();
}

document.getElementById("btn-software-prev")?.addEventListener("click", () => {
  if (softwarePage > 1) {
    softwarePage -= 1;
    refreshSoftware();
  }
});

document.getElementById("btn-software-next")?.addEventListener("click", () => {
  if (softwarePage < softwareTotalPages) {
    softwarePage += 1;
    refreshSoftware();
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
  // The address the header shows belongs to one server: pin the id, because a
  // response that lands after navigation must not paint another server's
  // tunnel onto the header. The tunnel submit path calls this without a
  // generation, so the id check is the guard that always applies.
  const serverId = currentServer.id;
  const list = document.getElementById("alloc-list");
  const err = document.getElementById("network-error");
  err.hidden = true;
  list.innerHTML = "";
  const { status, data } = await api(`/servers/${serverId}/allocations`, {
    token: store.token,
  });
  if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
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
  const t = await api(`/servers/${serverId}/tunnel`, { token: store.token });
  if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
  const info = document.getElementById("tunnel-info");
  if (t.status === 200 && t.data.endpoint) {
    info.textContent = t.data.address
      ? `Players join at ${t.data.address} (Minekube tunnel “${t.data.endpoint}”).`
      : `Tunnel “${t.data.endpoint}” is installed — start the server and the public address appears here.`;
  } else {
    info.textContent = "No tunnel. Players join you by your IP and port.";
  }
  // The server header shows the same join address as the Network tab: once the
  // tunnel reports the address it printed to the console, that is what players
  // dial, and the host's internal address is no longer the answer.
  const join = t.status === 200 ? (t.data.address ?? "") : "";
  if (join !== tunnelAddress) {
    tunnelAddress = join;
    renderServerHeader();
    // Overview reads tunnelAddress too; without this it keeps the fallback
    // address from the first paint until a full reload.
    renderOverview();
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
    refreshNetwork(serverGeneration);
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
    showToast("Settings saved.", "success");
  }
});

/**
 * Waits for a backgrounded install (reinstall, software swap) to settle.
 * The 202 responses return before the install runs, so the caller polls the
 * server row: `installing` until runInstallOps resolves, then `ready` or
 * `install_failed`. Returns the settled server row, or null when the poll
 * ended without a verdict (navigation away, poll error, 15-minute deadline).
 */
async function awaitServerInstall(serverId) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (serverId !== currentServer?.id) return null;
    const { status, data } = await api(`/servers/${serverId}`, { token: store.token });
    if (status !== 200) return null;
    const srv = data.server;
    if (srv) {
      currentServer = srv;
      renderServerHeader();
      if (srv.status !== "installing") return srv;
    }
  }
  return null;
}

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
  if (status === 202) {
    showToast("Reinstall started — files download in the background.", "success");
    const settled = await awaitServerInstall(currentServer.id);
    if (settled && settled.status === "install_failed") {
      fail(err, "Reinstall failed. Check the server status and try again.");
    } else if (settled && settled.status === "ready") {
      showToast("Reinstall finished.", "success");
    }
    return;
  }
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

/* ---------- overview ---------- */

// The landing page. Everything here already arrived with GET /servers/:id or
// with the activity preload, so opening a server costs no extra round trip.
function renderOverview() {
  const s = currentServer;
  const grid = document.getElementById("overview-grid");
  if (!s || !grid) return;
  // A collaborator without activity.read gets no half-empty feed: the block is
  // the first thing the eye lands on, so hiding it beats an error banner.
  const recent = document.getElementById("overview-activity");
  if (recent) recent.hidden = !canServer("activity.read");
  grid.innerHTML = "";
  const tiles = [
    ["Software", softwareLabel(s)],
    ["State", s.status === "suspended" ? "suspended" : s.runtimeState || s.status || "offline"],
    ["Memory limit", `${s.memoryMb} MB`],
    ["Disk quota", `${s.diskQuotaMb} MB`],
    ["CPU", s.cpuWeight > 0 ? `${s.cpuWeight}% of a core` : "Unlimited"],
    ["Owner", s.ownerUsername || "—"],
  ];
  for (const [label, value] of tiles) {
    const tile = document.createElement("dl");
    tile.className = "overview-tile";
    const term = document.createElement("dt");
    term.textContent = label;
    const definition = document.createElement("dd");
    definition.textContent = String(value);
    tile.append(term, definition);
    grid.append(tile);
  }
  const join =
    tunnelAddress ||
    (s.primaryAllocation ? `${s.hostIp}:${s.primaryAllocation.port}` : "No address assigned yet");
  const address = document.getElementById("overview-address");
  if (address) address.textContent = join;
  const hint = document.getElementById("overview-hint");
  if (hint) {
    if (tunnelAddress) {
      hint.textContent = "Public tunnel address — works for anyone, no port forwarding.";
    } else if (s.primaryAllocation) {
      hint.textContent =
        "Players connect with this address on your network. Enable a tunnel on the Network tab to reach the internet.";
    } else {
      hint.textContent = "No port assigned yet. Assign one on the Network tab.";
    }
  }
}

/* ---------- activity ---------- */

let activityCursor = null;
/** Server id whose activity request is in flight (see refreshActivity). */
let activityLoadingServerId = null;

/** Turn `file.write` + target into a sentence a person can scan. */
function describeActivityEvent(item) {
  const target = item.target || {};
  const path = typeof target.path === "string" ? target.path : "";
  const paths = Array.isArray(target.paths) ? target.paths : [];
  const phrases = {
    "file.read": path ? `Viewed the contents of ${path}` : "Viewed a file",
    "file.write": path ? `Edited ${path}` : "Edited a file",
    "file.create": path ? `Created ${path}` : "Created a file or folder",
    "file.rename":
      typeof target.from === "string" ? `Renamed ${target.from} to ${target.to}` : "Renamed a file",
    "file.download": path ? `Downloaded ${path}` : "Downloaded a file",
    "file.delete": paths.length
      ? `Deleted ${paths.length} item${paths.length === 1 ? "" : "s"}`
      : path
        ? `Deleted ${path}`
        : "Deleted a file",
    "file.compress":
      typeof target.archive === "string"
        ? `Created archive ${target.archive}`
        : "Created an archive",
    "file.decompress": path ? `Extracted ${path}` : "Extracted an archive",
    "server.properties.update": "Changed server.properties",
    "server.power.start": "Started the server",
    "server.power.stop": "Stopped the server",
    "server.power.restart": "Restarted the server",
    "server.power.kill": "Force-stopped the server",
    "server.create": "Created this server",
    "server.delete": "Deleted this server",
    "server.update": "Updated server settings",
    "server.variables.update": "Changed startup variables",
    "server.software.swap":
      typeof target.to === "string"
        ? `Switched software from ${target.from} to ${target.to}`
        : "Switched server software",
    "server.install.done": "Install finished",
    "server.install.failed": "Install failed",
    "server.install.start": "Install started",
    "server.addons.install": "Installed a plugin",
    "server.addons.remove": "Removed a plugin",
    "server.tunnel.enable": "Enabled the public tunnel",
    "server.tunnel.disable": "Disabled the public tunnel",
    "backup.create": "Created a backup",
    "backup.restore": "Restored a backup",
    "backup.delete": "Deleted a backup",
    "schedule.create": "Created a schedule",
    "schedule.update": "Updated a schedule",
    "schedule.delete": "Deleted a schedule",
    "schedule.run.manual": "Ran a schedule",
    "schedule.run": "A schedule ran",
    "schedule.run.failed": "A schedule failed",
    "server.subuser.add": "Added a collaborator",
    "server.subuser.remove": "Removed a collaborator",
  };
  return phrases[item.event] ?? item.event;
}

function activityActor(item) {
  // Audit rows written by the panel itself carry actorUserId null; render the
  // capitalized name rather than the raw actor_ip sentinel "system".
  return item.actorUsername || "System";
}

/** One <li> for the feed; shared by Activity and the Overview summary. */
function buildActivityItem(item) {
  const li = document.createElement("li");
  li.className = "activity-item";
  const avatar = document.createElement("span");
  avatar.className = "activity-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = activityActor(item).slice(0, 1);
  const body = document.createElement("div");
  body.className = "activity-body";
  const summary = document.createElement("p");
  summary.className = "activity-summary";
  const who = document.createElement("strong");
  who.textContent = activityActor(item);
  const what = document.createElement("span");
  what.textContent = ` ${describeActivityEvent(item)}`;
  const event = document.createElement("span");
  event.className = "activity-event";
  event.textContent = item.event;
  summary.append(who, what, event);
  const meta = document.createElement("p");
  meta.className = "activity-meta";
  meta.textContent = new Date(item.ts).toLocaleString();
  body.append(summary, meta);
  li.append(avatar, body);
  return li;
}

function renderActivityItems(items, append) {
  const list = document.getElementById("activity-list");
  if (!list) return;
  if (!append) list.innerHTML = "";
  for (const item of items) list.append(buildActivityItem(item));
}

function renderOverviewActivity(items) {
  const list = document.getElementById("overview-activity");
  if (!list) return;
  list.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "activity-meta";
    li.textContent = "Nothing recorded yet.";
    list.append(li);
    return;
  }
  for (const item of items) list.append(buildActivityItem(item));
}

async function refreshActivity(reset = true, generation) {
  const list = document.getElementById("activity-list");
  const err = document.getElementById("activity-error");
  const empty = document.getElementById("activity-empty");
  const pagination = document.getElementById("activity-pagination");
  if (!list || !currentServer) return;
  const serverId = currentServer.id;
  // Keyed by server, not a plain boolean: with a boolean, switching servers
  // mid-request made the new server's preload return early (the old request
  // still held the latch), leaving its feed blank until something else fired.
  if (activityLoadingServerId === serverId) return;
  activityLoadingServerId = serverId;
  if (reset) activityCursor = null;
  if (err) err.hidden = true;
  const cursor = reset ? null : activityCursor;
  try {
    const qs = cursor ? `?before=${encodeURIComponent(cursor)}` : "";
    const { status, data } = await api(`/servers/${serverId}/activity${qs}`, {
      token: store.token,
    });
    if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
    if (status !== 200) {
      if (err) fail(err, describeProblem(status, data));
      return;
    }
    const items = data.items || [];
    renderActivityItems(items, !reset);
    activityCursor = data.nextCursor || null;
    if (empty) empty.hidden = list.children.length > 0;
    if (pagination) pagination.hidden = !activityCursor;
    // The overview shows the same feed, capped: a summary, not a reader. Only
    // refreshed from the first page, so "load older" cannot shrink it.
    if (reset) renderOverviewActivity(items.slice(0, 5));
  } finally {
    if (activityLoadingServerId === serverId) activityLoadingServerId = null;
  }
}

document.getElementById("btn-activity-more")?.addEventListener("click", () => {
  void refreshActivity(false);
});

/* ---------- server.properties manager ---------- */

let propertyInputs = new Map();

function renderPropertyField(prop) {
  const field = document.createElement("div");
  field.className = "property-field";
  const label = document.createElement("label");
  label.textContent = prop.label;
  const id = `prop-${prop.key}`;
  let input;
  if (prop.kind === "boolean") {
    // A checkbox row matches the switch language used elsewhere in the panel.
    field.classList.add("property-toggle");
    input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = prop.value === "true";
    label.setAttribute("for", id);
    field.append(label, input);
  } else if (prop.kind === "enum") {
    input = document.createElement("select");
    input.id = id;
    for (const option of prop.options || []) {
      const opt = document.createElement("option");
      opt.value = option;
      opt.textContent = option;
      if (option === prop.value) opt.selected = true;
      input.append(opt);
    }
    label.append(input);
    field.append(label);
  } else {
    input = document.createElement("input");
    input.type = prop.kind === "number" ? "number" : "text";
    input.id = id;
    input.value = prop.value;
    if (prop.readonly === true) {
      // The panel owns this value (allocation/port assignment); editing it
      // here would desync the port the engine, allocation table and tunnel
      // all agree on. Redirect the owner to the Network tab instead.
      input.readOnly = true;
      field.classList.add("property-readonly");
    }
    if (prop.min !== null && prop.min !== undefined) input.min = String(prop.min);
    if (prop.max !== null && prop.max !== undefined) input.max = String(prop.max);
    label.append(input);
    field.append(label);
  }
  if (prop.help) {
    const help = document.createElement("p");
    help.className = "property-help";
    help.textContent = prop.help;
    field.append(help);
  }
  propertyInputs.set(prop.key, {
    input,
    kind: prop.kind,
    /** Value as loaded; Save diffs against this so untouched keys are not sent. */
    initial: prop.value,
    readonly: prop.readonly === true,
  });
  return field;
}

async function refreshProperties() {
  const wrap = document.getElementById("properties-groups");
  const err = document.getElementById("properties-error");
  const success = document.getElementById("properties-success");
  if (!wrap || !currentServer) return;
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  wrap.innerHTML = "";
  propertyInputs = new Map();
  const serverId = currentServer.id;
  const { status, data } = await api(`/servers/${serverId}/properties`, { token: store.token });
  if (currentServer?.id !== serverId) return;
  if (status !== 200) {
    if (err) fail(err, describeProblem(status, data));
    return;
  }
  const groups = new Map();
  for (const prop of data.properties || []) {
    if (!groups.has(prop.group)) groups.set(prop.group, []);
    groups.get(prop.group).push(prop);
  }
  if (groups.size === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "No server.properties found. Start the server once to generate it.";
    wrap.append(p);
    return;
  }
  for (const [group, props] of groups) {
    const section = document.createElement("section");
    section.className = "properties-group";
    const title = document.createElement("h3");
    title.className = "properties-group-title";
    title.textContent = group;
    const grid = document.createElement("div");
    grid.className = "properties-grid";
    for (const prop of props) grid.append(renderPropertyField(prop));
    section.append(title, grid);
    wrap.append(section);
  }
}

document.getElementById("btn-properties-reload")?.addEventListener("click", () => {
  void refreshProperties();
});

document.getElementById("btn-properties-save")?.addEventListener("click", async () => {
  const err = document.getElementById("properties-error");
  const success = document.getElementById("properties-success");
  if (!currentServer) return;
  // Capture the server: the save is async, and rebaselining after the user
  // navigated would overwrite the NEW server's snapshot, making a real edit
  // there look like "No changes to save".
  const savedServerId = currentServer.id;
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const values = {};
  for (const [key, { input, kind, initial }] of propertyInputs) {
    const current = kind === "boolean" ? (input.checked ? "true" : "false") : input.value;
    // Only changed keys travel: the audit row then names what was actually
    // touched, and a pre-existing out-of-range value the owner never edited
    // cannot block saving the keys they did change.
    if (current !== initial) values[key] = current;
  }
  if (Object.keys(values).length === 0) {
    if (success) {
      success.textContent = "No changes to save.";
      success.hidden = false;
    }
    return;
  }
  const { status, data } = await api(`/servers/${savedServerId}/properties`, {
    method: "PUT",
    token: store.token,
    body: { values },
  });
  if (status !== 204) {
    if (err) fail(err, describeProblem(status, data));
    showToast(describeProblem(status, data), "error");
    return;
  }
  if (success) {
    success.textContent = "Saved. Changes apply the next time the server starts.";
    success.hidden = false;
  }
  // Re-baseline the snapshot: without this, a second click re-sends the same
  // keys (which the server rewrites and re-audits), and editing a field back to
  // its pre-save value is misreported as "No changes to save".
  if (currentServer?.id === savedServerId) {
    for (const [key, value] of Object.entries(values)) {
      const field = propertyInputs.get(key);
      if (field) field.initial = value;
    }
  }
  showToast("server.properties saved.", "success");
});

/* ---------- egg swapper ---------- */

let eggPage = 1;
const eggLimit = 10;
let eggTotalPages = 1;

async function refreshEgg(generation) {
  if (!currentServer) return;
  const serverId = currentServer.id;
  const container = document.getElementById("egg-cards-container");
  const curName = document.getElementById("current-egg-name");
  const curDesc = document.getElementById("current-egg-desc");
  const curBadge = document.getElementById("current-egg-runtime-badge");
  const err = document.getElementById("egg-alert-error");
  const pagination = document.getElementById("egg-pagination");
  if (err) err.hidden = true;
  if (!container) return;
  container.innerHTML = "";
  const qs = `?scope=egg&page=${eggPage}&limit=${eggLimit}`;
  const { status, data } = await api(`/servers/${serverId}/software${qs}`, {
    token: store.token,
  });
  // generation alone is inert for callers that pass none (the tab switch and
  // the swap handler do), so the id check is what stops another server's egg
  // presets from rendering here.
  if (isStaleLoad(generation) || currentServer?.id !== serverId) return;
  if (status !== 200) {
    if (err) fail(err, describeProblem(status, data));
    return;
  }
  if (curName) curName.textContent = `${data.current.name} (${data.current.category})`;
  if (curDesc) curDesc.textContent = data.current.description || "";
  if (curBadge) {
    const state = currentServer.runtimeState || "offline";
    curBadge.textContent =
      state === "offline" ? "Offline — safe to swap" : `${state} — stop the server to swap`;
  }
  eggTotalPages = data.totalPages || 1;
  if (pagination) {
    pagination.hidden = data.total <= eggLimit;
    const prev = document.getElementById("btn-egg-prev");
    const next = document.getElementById("btn-egg-next");
    const indicator = document.getElementById("egg-page-indicator");
    if (prev) prev.disabled = eggPage <= 1;
    if (next) next.disabled = eggPage >= eggTotalPages;
    if (indicator) indicator.textContent = `Page ${eggPage} of ${eggTotalPages}`;
  }
  const items = data.items || [];
  if (items.length === 0) {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = "This is the only environment installed on this panel.";
    container.append(p);
    return;
  }
  for (const env of items) {
    const card = document.createElement("div");
    card.className = "software-card";
    const body = document.createElement("div");
    body.className = "software-card-body";
    const category = document.createElement("span");
    category.className = "eyebrow";
    category.textContent = env.category;
    const title = document.createElement("h4");
    title.textContent = env.name;
    const desc = document.createElement("p");
    desc.className = "software-card-desc";
    desc.textContent = env.description || "";
    body.append(category, title, desc);
    const footer = document.createElement("div");
    footer.className = "software-card-footer";
    const swapBtn = document.createElement("button");
    swapBtn.type = "button";
    swapBtn.className = "secondary";
    swapBtn.textContent = `Swap to ${env.name}`;
    swapBtn.hidden = !canServer("settings.reinstall");
    swapBtn.addEventListener("click", () => openSoftwareSwapDialog(env, data.current));
    footer.append(swapBtn);
    card.append(body, footer);
    container.append(card);
  }
}

document.getElementById("btn-egg-prev")?.addEventListener("click", () => {
  if (eggPage > 1) {
    eggPage -= 1;
    void refreshEgg();
  }
});

document.getElementById("btn-egg-next")?.addEventListener("click", () => {
  if (eggPage < eggTotalPages) {
    eggPage += 1;
    void refreshEgg();
  }
});

/* ---------- file manager: context menu ---------- */

let openContextMenu = null;

function closeContextMenu() {
  if (!openContextMenu) return;
  openContextMenu.remove();
  openContextMenu = null;
}

/**
 * One menu for every row, also reachable from the keyboard (`ContextMenu`
 * key). Items are declared with the permission that gates them, so a
 * collaborator with only file.read sees no entry instead of a disabled one
 * hinting at what they cannot do.
 */
function showFileContextMenu(event, item, relative) {
  closeContextMenu();
  const actions = [];
  if (!item.isDir && canServer("file.read-content")) {
    actions.push({ label: "Download", handler: () => void downloadFile(relative) });
  }
  if (canServer("file.archive")) {
    actions.push({ label: "Compress", handler: () => void compressSelection([item.name]) });
    if (!item.isDir && /\.(tar\.gz|tgz|zip|tar)$/i.test(item.name)) {
      actions.push({
        label: "Dearchive",
        handler: () => void decompressArchive(relative, item.name),
      });
    }
  }
  if (canServer("file.update")) {
    actions.push({ label: "Rename", handler: () => void renameFileTo(relative, dirOf(relative)) });
    actions.push({ label: "Move", handler: () => void moveFileTo(relative) });
  }
  if (canServer("file.delete")) {
    actions.push({
      label: "Delete",
      danger: true,
      handler: async () => {
        if (!window.confirm(`Delete ${item.name}? This cannot be undone.`)) return;
        const res = await api(`/servers/${currentServer.id}/files/delete`, {
          method: "POST",
          token: store.token,
          body: { path: relative },
        });
        if (res.status !== 204) {
          fail(document.getElementById("files-error"), describeProblem(res.status, res.data));
        } else {
          refreshFiles(serverGeneration);
        }
      },
    });
  }
  if (actions.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = action.label;
    if (action.danger) button.classList.add("danger-text");
    button.addEventListener("click", () => {
      closeContextMenu();
      void action.handler();
    });
    menu.append(button);
  }
  // Attached to <body> and position:fixed, so no scrolling ancestor can clip
  // it and clientX/clientY stay viewport-true; a flex-row child would inherit
  // the row's coordinate space and drift when the list scrolls.
  menu.style.position = "fixed";
  document.body.append(menu);
  const menuBounds = menu.getBoundingClientRect();
  const x =
    typeof event.clientX === "number"
      ? event.clientX
      : (event?.target?.getBoundingClientRect?.().left ?? 0);
  const y =
    typeof event.clientY === "number"
      ? event.clientY
      : (event?.target?.getBoundingClientRect?.().top ?? 0);
  // Keep the whole menu inside the viewport near screen edges.
  menu.style.left = `${Math.min(Math.max(0, x), window.innerWidth - menuBounds.width - 4)}px`;
  menu.style.top = `${Math.min(Math.max(0, y), window.innerHeight - menuBounds.height - 4)}px`;
  openContextMenu = menu;
  const first = menu.querySelector("button");
  if (first) first.focus();
}

document.addEventListener("click", (event) => {
  if (openContextMenu && !openContextMenu.contains(event.target)) closeContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);

/** Compress the named items in the current directory into one archive. */
async function compressSelection(names) {
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  const suggested = names.length === 1 ? `${names[0]}.tar.gz` : "archive.tar.gz";
  const name = window.prompt("Archive name (e.g. backup.tar.gz):", suggested);
  if (!name) return;
  const archiveBasename = basename(name);
  if (!archiveBasename) return;
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const paths = names.map((n) => (filesDir ? `${filesDir}/${n}` : n));
  const res = await api(`/servers/${currentServer.id}/files/compress`, {
    method: "POST",
    token: store.token,
    body: { root: filesDir, files: names, paths, archiveName: archiveBasename },
  });
  if (res.status !== 200) {
    if (err) fail(err, describeProblem(res.status, res.data));
    return;
  }
  if (success) {
    success.textContent = `Archive "${archiveBasename}" created.`;
    success.hidden = false;
  }
  refreshFiles(serverGeneration);
}

/** Extract one archive in place. */
async function decompressArchive(relative, name) {
  const err = document.getElementById("files-error");
  const success = document.getElementById("files-success");
  if (err) err.hidden = true;
  if (success) success.hidden = true;
  const res = await api(`/servers/${currentServer.id}/files/decompress`, {
    method: "POST",
    token: store.token,
    body: { path: relative },
  });
  if (res.status !== 200 && res.status !== 204) {
    if (err) fail(err, describeProblem(res.status, res.data));
    return;
  }
  if (success) {
    success.textContent = `Extracted "${name}".`;
    success.hidden = false;
  }
  refreshFiles(serverGeneration);
}

/* ---------- home: owned-only filter ---------- */

// The dashboard defaults to servers you own: a collaborator's list is mostly
// other people's machines. The switch reveals everything you can access
// without a second page, and the choice persists per browser.
const OWNED_ONLY_KEY = "renom.servers.ownedOnly";
let showOwnedOnly = true;

function readOwnedOnlyPreference() {
  const stored = window.localStorage.getItem(OWNED_ONLY_KEY);
  showOwnedOnly = stored === null ? true : stored === "1";
  const toggle = document.getElementById("owned-only-toggle");
  if (toggle) toggle.checked = showOwnedOnly;
}

function applyOwnedOnlyFilter() {
  const list = document.getElementById("server-list");
  if (!list) return;
  let visible = 0;
  for (const card of list.children) {
    const owned = card.dataset.owned !== "0";
    card.hidden = showOwnedOnly && !owned;
    if (!card.hidden) visible += 1;
  }
  const empty = document.getElementById("server-empty");
  if (empty && list.children.length > 0) {
    empty.hidden = visible > 0;
    if (visible === 0) {
      empty.textContent =
        "You don't own any servers. Turn the switch off to see servers shared with you.";
    }
  }
  if (list.children.length > 0) {
    setServerListStatus("available", `${visible} server${visible === 1 ? "" : "s"} shown`);
  }
}

document.getElementById("owned-only-toggle")?.addEventListener("change", (event) => {
  showOwnedOnly = event.target.checked;
  window.localStorage.setItem(OWNED_ONLY_KEY, showOwnedOnly ? "1" : "0");
  applyOwnedOnlyFilter();
});

renderPermissionOptions();
renderApiPermissionOptions();
readOwnedOnlyPreference();
boot();
