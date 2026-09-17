"use strict";
/* Renom web client — no build step. Talks to /api/v3 on the same origin. */
const API = "/api/v3";
const tokenKey = "renom.token";

const views = {
  setup: document.getElementById("view-setup"),
  login: document.getElementById("view-login"),
  home: document.getElementById("view-home"),
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

async function boot() {
  try {
    const { data } = await api("/setup/status");
    if (data && data.needsSetup) {
      show("setup");
      return;
    }
  } catch {
    /* setup endpoint unreachable — fall through to login */
  }
  if (store.token) {
    const ok = await loadHome();
    if (ok) return;
  }
  show("login");
}

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

async function loadHome() {
  const { status, data } = await api("/auth/me", { token: store.token });
  if (status !== 200) {
    store.token = null;
    show("login");
    return false;
  }
  const me = data.user;
  document.getElementById("home-greeting").textContent =
    `Welcome back, ${me.displayName || me.username}.`;
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

async function refreshUsers() {
  const list = document.getElementById("user-list");
  const { status, data } = await api("/users?limit=100", { token: store.token });
  if (status !== 200) return;
  list.innerHTML = "";
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
}

document.getElementById("form-user").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("user-error");
  err.hidden = true;
  const fd = new FormData(e.target);
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
});

document.getElementById("btn-signout").addEventListener("click", () => {
  store.token = null;
  show("login");
});

function describeProblem(status, data) {
  const detail = data && data.error ? data.error.message : null;
  if (status === 400 || status === 422)
    return detail || "Something in the form needs fixing — check each field.";
  if (status === 409) return detail || "That name is already taken.";
  return detail || "Something went wrong on our side. Try again.";
}

boot();
