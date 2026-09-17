#!/usr/bin/env bash
#
# Renom installer — one machine, one panel.
#
# Run it from a clone (./install.sh) or through the dashboard (./renom.sh).
# It works on a bare machine: missing basics (curl, git, tar) and Node.js 24+
# are installed when a supported package manager is available.
#
# What it asks: port, admin account. Everything else has sane defaults.
# Safe to re-run: existing .env values become the prompt defaults, your
# session secret is kept, and admin creation is skipped when users exist.
set -euo pipefail

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

say() { printf '%s\n' "$*"; }
info() { printf "${BLUE}[INFO]${NC} %s\n" "$*"; }
ok() { printf "${GREEN}[OK]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC} %s\n" "$*"; }
die() { printf "${RED}[ERROR]${NC} %s\n" "$*"; exit 1; }

ask() { # ask <prompt> <default> -> prints value
  local prompt="$1" default="$2" answer=""
  printf '%s [%s]: ' "$prompt" "$default" >&2
  IFS= read -r answer || answer=""
  if [ -z "$answer" ]; then printf '%s' "$default"; else printf '%s' "$answer"; fi
}
ask_secret() { # ask_secret <prompt> -> prints value (input hidden); fails on EOF
  local prompt="$1" answer=""
  printf '%s: ' "$prompt" >&2
  IFS= read -rs answer || return 1
  printf '\n' >&2
  printf '%s' "$answer"
}

# Read one KEY from .env (empty when absent) so reruns keep your settings.
env_default() {
  local key="$1" fallback="$2" found=""
  if [ -f .env ]; then
    found="$(grep -E "^${key}=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r' | head -n 1 || true)"
  fi
  if [ -n "$found" ]; then printf '%s' "$found"; else printf '%s' "$fallback"; fi
}

banner() {
  if [ -t 1 ]; then clear 2>/dev/null || true; fi
  printf "${CYAN}${BOLD}%s${NC}\n" "  ____                        "
  printf "${CYAN}${BOLD}%s${NC}\n" " |  _ \ ___ _ __   ___  _ __ ___ "
  printf "${CYAN}${BOLD}%s${NC}\n" " | |_) / _ \ '_ \ / _ \| '_ \` _ \ "
  printf "${CYAN}${BOLD}%s${NC}\n" " |  _ <  __/ | | | (_) | | | | | |"
  printf "${CYAN}${BOLD}%s${NC}\n" " |_| \_\___|_| |_|\___/|_| |_| |_|"
  printf "${CYAN}%s${NC}\n" "            panel installer"
  say ""
}

# ---------------------------------------------------------------- dependencies

have() { command -v "$1" >/dev/null 2>&1; }

install_basics() {
  local missing=""
  for tool in curl git tar; do
    have "$tool" || missing="$missing $tool"
  done
  # Java runs Minecraft servers; warn (don't force) when absent.
  have java || warn "Java not found — Minecraft servers need it. Install a JRE (17+) to boot them."
  if [ -z "$missing" ]; then return 0; fi
  info "Installing basics:$missing ..."
  if have apt-get; then
    sudo apt-get update && sudo apt-get install -y $missing
  elif have dnf; then
    sudo dnf install -y $missing
  elif have pacman; then
    sudo pacman -Sy --noconfirm $missing
  elif have apk; then
    sudo apk add $missing
  else
    die "Cannot install$missing automatically (no apt/dnf/pacman/apk). Install them and re-run."
  fi
}

ensure_node() {
  if have node; then
    local major
    major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -ge 24 ]; then ok "Node.js $(node --version) — good."; return 0; fi
    warn "Node.js $(node --version) is too old — Renom needs 24+."
  else
    info "Node.js not found."
  fi
  if have apt-get; then
    info "Installing Node.js 24 (NodeSource)..."
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - \
      || die "NodeSource setup failed."
    sudo apt-get install -y nodejs || die "Node.js install failed."
  elif have dnf; then
    sudo dnf module install -y nodejs:24/common || sudo dnf install -y nodejs \
      || die "Node.js install failed."
  else
    die "Install Node.js 24+ from https://nodejs.org/en/download and re-run."
  fi
  have node || die "Node.js still missing after install."
  ok "Node.js $(node --version) — good."
}

# ---------------------------------------------------------------- firewall

lan_ips() {
  # Best-effort LAN addresses for the "open this" line. Never fatal.
  if have hostname; then hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^127\.' | head -n 3 || true; fi
}

open_firewall() {
  local port="$1"
  if have ufw && sudo ufw status 2>/dev/null | grep -q 'Status: active'; then
    sudo ufw allow "$port"/tcp >/dev/null && ok "Opened TCP $port in ufw." && return 0
  fi
  if have firewall-cmd && sudo firewall-cmd --state 2>/dev/null | grep -q running; then
    sudo firewall-cmd --permanent --add-port="$port"/tcp >/dev/null \
      && sudo firewall-cmd --reload >/dev/null \
      && ok "Opened TCP $port in firewalld." && return 0
  fi
  warn "Could not open TCP $port automatically — allow it in your firewall manually."
  return 0
}

# ---------------------------------------------------------------- main

banner
say "== Renom installer =="
say ""

install_basics
ensure_node
say ""

# --- where should the panel listen? Reruns offer the current values.
HOST="$(ask "Listen address (127.0.0.1 = this machine only, 0.0.0.0 = your network)" "$(env_default HOST "127.0.0.1")")"
PORT="$(ask "Port" "$(env_default PORT "8080")")"
DATA_DIR="$(ask "Data directory (database, servers, backups)" "$(env_default DATA_DIR "./data")")"
case "$PORT" in
  '' | *[!0-9]* | 0) die "Port must be a number from 1 to 65535." ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "Port must be 1-65535."; fi
if [ "$HOST" = "0.0.0.0" ]; then
  warn "Listening on every interface is convenient but exposes logins to your whole network."
  warn "Prefer 127.0.0.1 + SSH tunnel unless you know this network."
  open_firewall "$PORT"
fi
say ""

# --- secrets + config. Reruns keep JWT_SECRET and SETUP_TOKEN.
JWT_SECRET="$(env_default JWT_SECRET "")"
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
  info "Generated a fresh session secret."
else
  info "Keeping your existing session secret."
fi
SETUP_TOKEN="$(env_default SETUP_TOKEN "")"
if [ -z "$SETUP_TOKEN" ]; then
  SETUP_TOKEN="$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("base64url"))')"
fi

# Upsert managed keys, preserving everything else in .env (custom LOG_LEVEL,
# CORS_ORIGINS, JWT_TTL_SECONDS, BCRYPT_COST, and your own keys survive).
upsert_env() { # upsert_env KEY VALUE
  local key="$1" value="$2" tmp
  tmp="$(mktemp)" || die "Cannot create temp file."
  if [ -f .env ]; then
    awk -v k="$key" -v v="$value" '
      BEGIN { done = 0 }
      $0 ~ "^" k "=" { print k "=" v; done = 1; next }
      { print }
      END { if (!done) print k "=" v }
    ' .env >"$tmp" && mv "$tmp" .env
  else
    printf '# Written by install.sh. Edit freely; never commit this file.\n' > .env
    printf '%s=%s\n' "$key" "$value" >> .env
    rm -f "$tmp"
  fi
}

upsert_env NODE_ENV production
upsert_env HOST "$HOST"
upsert_env PORT "$PORT"
upsert_env JWT_SECRET "$JWT_SECRET"
upsert_env SETUP_TOKEN "$SETUP_TOKEN"
upsert_env DATA_DIR "$DATA_DIR"
upsert_env LOG_LEVEL "$(env_default LOG_LEVEL "info")"
chmod 600 .env
ok "Wrote .env (port ${PORT}, data in ${DATA_DIR}). Other keys untouched."
say ""

# --- install + build.
info "Installing dependencies (this takes a minute)..."
npm install --no-audit --no-fund || die "npm install failed."
info "Building..."
npm run build || die "Build failed."
say ""

# --- admin account, only when the panel has no users yet.
ADMIN_EXISTS="$(DATA_DIR="$DATA_DIR" npm run --silent setup:admin --workspace @renom/panel -- --check 2>/dev/null || echo unknown)"
if [ "$ADMIN_EXISTS" = "yes" ]; then
  info "Accounts already exist — skipping admin creation."
elif [ "$ADMIN_EXISTS" = "unknown" ]; then
  warn "Could not check for existing accounts. Create the admin from the web page on first open"
  warn "using this setup token: ${SETUP_TOKEN}"
else
  say "Now the admin account. This is the owner of the panel —"
  say "after this, new accounts are made from inside, never from the installer."
  say ""
  ADMIN_USER="$(ask "Admin username" "admin")"
  ADMIN_EMAIL="$(ask "Admin email (optional, Enter to skip)" "")"
  # The installer generates a strong password and shows it ONCE. Write it
  # down now: it never appears again, and nothing is stored in shell history.
  ADMIN_PASS="$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("base64url").slice(0,16))')"
  # Everything travels by environment, never argv (invisible to `ps`).
  export RENOM_ADMIN_USER="$ADMIN_USER" RENOM_ADMIN_PASSWORD="$ADMIN_PASS"
  if [ -n "$ADMIN_EMAIL" ]; then export RENOM_ADMIN_EMAIL="$ADMIN_EMAIL"; fi
  DATA_DIR="$DATA_DIR" \
    npm run setup:admin --workspace @renom/panel -- || die "Admin creation failed."
  unset RENOM_ADMIN_USER RENOM_ADMIN_PASSWORD RENOM_ADMIN_EMAIL
  say ""
  say "Your admin password (shown once — save it now):"
  say "  ${ADMIN_PASS}"
  say "Change it after first sign-in from the admin Users page."
  unset ADMIN_PASS
fi
say ""

# --- done. Print something the user can actually open.
DISPLAY_HOST="$HOST"
if [ "$HOST" = "0.0.0.0" ]; then
  DISPLAY_HOST="$(lan_ips | head -n 1 || true)"
  if [ -z "$DISPLAY_HOST" ]; then DISPLAY_HOST="<this-machine-ip>"; fi
fi
say "== Done. Renom is installed. =="
say ""
say "Start it with:   npm start --workspace @renom/panel"
say "Then open:       http://${DISPLAY_HOST}:${PORT}"
say ""
say "Keep it running with systemd, pm2, or screen — see README.md."
say "Back up ${DATA_DIR}/panel.db and you can rebuild everything else from this folder."
