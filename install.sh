#!/usr/bin/env bash
#
# Renom installer — one machine, one panel.
#
# What it does:
#   1. Checks for Node.js >= 24 (the only requirement — no compilers, no Docker needed for the panel itself).
#   2. Asks where the panel should listen (host + port) and where to keep its data.
#   3. Writes a .env with a freshly generated secret, installs dependencies, builds.
#   4. Asks you to create the admin account, then tells you where to open the panel.
#
# Safe to re-run: it never deletes data, and it skips admin creation if accounts already exist.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
ask() { # ask <prompt> <default> -> prints value
  local prompt="$1" default="$2" answer=""
  printf '%s [%s]: ' "$prompt" "$default" >&2
  IFS= read -r answer || true
  if [ -z "$answer" ]; then printf '%s' "$default"; else printf '%s' "$answer"; fi
}
ask_secret() { # ask_secret <prompt> -> prints value (input hidden)
  local prompt="$1" answer=""
  printf '%s: ' "$prompt" >&2
  IFS= read -rs answer || true
  printf '\n' >&2
  printf '%s' "$answer"
}

say "== Renom installer =="
say ""

# 1. Node check — the only hard requirement.
if ! command -v node >/dev/null 2>&1; then
  say "error: Node.js is not installed. Install Node.js 24 or newer, then re-run this script."
  say "  https://nodejs.org/en/download"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 24 ]; then
  say "error: found Node.js $(node --version), but Renom needs Node.js 24 or newer."
  exit 1
fi
say "Node.js $(node --version) — good."
say ""

# 2. Where should the panel live on the network?
HOST="$(ask "Listen address (127.0.0.1 = this machine only, 0.0.0.0 = your whole network)" "0.0.0.0")"
PORT="$(ask "Port" "8080")"
DATA_DIR="$(ask "Data directory (database, servers, backups)" "./data")"
case "$PORT" in
  ''|*[!0-9]*|0|*[0-9][0-9][0-9][0-9][0-9][0-9]*) say "error: port must be a number from 1 to 65535."; exit 1;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then say "error: port must be 1-65535."; exit 1; fi
say ""

# 3. Secrets + config. Re-running keeps your existing JWT secret.
JWT_SECRET=""
if [ -f .env ]; then
  JWT_SECRET="$(node -e 'try{const fs=require("fs");const m=fs.readFileSync(".env","utf8").match(/^JWT_SECRET=(.*)$/m);process.stdout.write(m?m[1].trim():"")}catch{process.stdout.write("")}')"
fi
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(48).toString("base64url"))')"
  say "Generated a fresh session secret."
else
  say "Keeping your existing session secret."
fi

cat > .env <<EOF
# Written by install.sh on $(date -u '+%Y-%m-%dT%H:%M:%SZ'). Edit freely; never commit this file.
NODE_ENV=production
HOST=${HOST}
PORT=${PORT}
JWT_SECRET=${JWT_SECRET}
DATA_DIR=${DATA_DIR}
LOG_LEVEL=info
EOF
chmod 600 .env
say "Wrote .env (port ${PORT}, data in ${DATA_DIR})."
say ""

# 4. Install + build.
say "Installing dependencies (this takes a minute)..."
npm install --no-audit --no-fund
say "Building..."
npm run build
say ""

# 5. Admin account — only if the panel has no users yet.
ADMIN_EXISTS="$(DATA_DIR="$DATA_DIR" node -e '
try {
  const { openAndMigrate } = require("./apps/panel/dist/server/infra/db/index.js");
  const { join, resolve } = require("node:path");
  const db = openAndMigrate(join(resolve(process.env.DATA_DIR || "./data"), "panel.db"));
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  process.stdout.write(String(row.n > 0 ? "yes" : "no"));
  db.close();
} catch (e) { process.stdout.write("unknown"); }')"
if [ "$ADMIN_EXISTS" = "yes" ]; then
  say "Accounts already exist — skipping admin creation."
elif [ "$ADMIN_EXISTS" = "unknown" ]; then
  say "warning: could not check for existing accounts. Create the admin from the web page on first open."
else
  say "Now create your admin account. This is the owner of the panel —"
  say "after this, new accounts are made from inside, never from the installer."
  say ""
  ADMIN_USER="$(ask "Admin username" "admin")"
  while true; do
    ADMIN_PASS="$(ask_secret "Admin password (at least 12 characters)")"
    if [ "${#ADMIN_PASS}" -ge 12 ]; then break; fi
    say "Too short — pick at least 12 characters." >&2
  done
  ADMIN_EMAIL="$(ask "Admin email (optional, Enter to skip)" "")"
  DATA_DIR="$DATA_DIR" npx tsx apps/panel/src/server/cli/create-owner.ts \
    --username "$ADMIN_USER" --password "$ADMIN_PASS" ${ADMIN_EMAIL:+--email "$ADMIN_EMAIL"}
fi
say ""

# 6. Done. Tell the truth about what happens next.
DISPLAY_HOST="$HOST"
if [ "$HOST" = "0.0.0.0" ]; then DISPLAY_HOST="<this-machine-ip>"; fi
say "== Done. Renom is installed. =="
say ""
say "Start it with:   npm start --workspace @renom/panel"
say "Then open:       http://${DISPLAY_HOST}:${PORT}"
say ""
say "Keep it running with systemd, pm2, or screen — see README.md."
say "Back up ${DATA_DIR}/panel.db and you can rebuild everything else from this folder."
