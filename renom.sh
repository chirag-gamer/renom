#!/usr/bin/env bash
#
# Renom console dashboard — one script, three jobs: install, update, delete.
#
# Run it from a clone:
#   ./renom.sh
# Or straight from the internet (inspect it first — it's short and readable):
#   curl -fsSL https://raw.githubusercontent.com/chirag-gamer/renom/dev/renom.sh | bash
#
# Pinning: `dev` moves. For a reproducible install, fetch a tag instead and
# check it out: RENOM_REF=v0.1.0 curl ... | bash. Tags are immutable; branches
# are not. Whatever you pipe from the internet, read it first.
#
# When piped through curl, the script clones the panel into ./renom (or
# $RENOM_DIR) and re-runs itself from there, so every prompt still works.
set -euo pipefail

REPO_URL="https://github.com/chirag-gamer/renom.git"
RENOM_REF="${RENOM_REF:-dev}"
TARGET_DIR="${RENOM_DIR:-renom}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

say() { printf '%s\n' "$*"; }
info() { printf "${CYAN}[renom]${NC} %s\n" "$*"; }
ok() { printf "${GREEN}[ok]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[warn]${NC} %s\n" "$*"; }
die() { printf "${RED}[error]${NC} %s\n" "$*"; exit 1; }

# Prompts must read from the terminal even when this script arrives via a pipe.
TTY="/dev/tty"
if [ -t 0 ]; then TTY="/dev/stdin"; fi
ask() {
  local prompt="$1" default="$2" answer=""
  printf '%s [%s]: ' "$prompt" "$default" >"$TTY" 2>&1 || true
  IFS= read -r answer <"$TTY" || answer=""
  if [ -z "$answer" ]; then printf '%s' "$default"; else printf '%s' "$answer"; fi
}

banner() {
  if [ -t 1 ]; then clear 2>/dev/null || true; fi
  printf "${CYAN}${BOLD}%s${NC}\n" "  ____                        "
  printf "${CYAN}${BOLD}%s${NC}\n" " |  _ \ ___ _ __   ___  _ __ ___ "
  printf "${CYAN}${BOLD}%s${NC}\n" " | |_) / _ \ '_ \ / _ \| '_ \` _ \ "
  printf "${CYAN}${BOLD}%s${NC}\n" " |  _ <  __/ | | | (_) | | | | | |"
  printf "${CYAN}${BOLD}%s${NC}\n" " |_| \_\___|_| |_|\___/|_| |_| |_|"
  say ""
}

# If we were piped (no install.sh beside us), fetch the repo, then hand over.
ensure_repo() {
  if [ -f "./install.sh" ] && [ -f "./renom.sh" ]; then return 0; fi
  command -v git >/dev/null 2>&1 || die "git is required for the remote install. Install git and re-run."
  if [ -d "$TARGET_DIR" ] && [ -f "$TARGET_DIR/install.sh" ]; then
    info "Using existing checkout at ./$TARGET_DIR."
  else
    info "Downloading Renom ($RENOM_REF) into ./$TARGET_DIR ..."
    git clone --depth 1 --branch "$RENOM_REF" "$REPO_URL" "$TARGET_DIR" \
      || die "Clone failed. Check the ref, the URL, and your connection."
  fi
  cd "$TARGET_DIR" || die "Cannot enter $TARGET_DIR."
  exec bash ./renom.sh "$@"
}

do_install() {
  [ -f ./install.sh ] || die "install.sh not found here. Run this from the Renom folder."
  info "Installing the panel (dependencies, build, admin account)..."
  bash ./install.sh
}

do_update() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not a git checkout — cannot update."
  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  info "Updating on branch $branch ..."
  git pull --ff-only || die "Pull failed — resolve local changes first, then re-run."
  info "Reinstalling dependencies and rebuilding..."
  npm install --no-audit --no-fund || die "npm install failed."
  npm run build || die "Build failed."
  ok "Updated. Restart the panel to run the new code."
  say "  If you run it by hand:  npm start --workspace @renom/panel"
}

do_delete() {
  say ""
  warn "This removes the Renom installation in $(pwd)."
  warn "Server data is KEPT by default (database, server files, backups)."
  local confirm
  confirm="$(ask "Type DELETE to confirm" "")"
  [ "$confirm" = "DELETE" ] || { say "Aborted. Nothing was touched."; return 0; }
  local purge
  purge="$(ask "Also delete server data (database + server files)? yes/NO" "NO")"

  # Stop anything obviously ours before deleting files out from under it.
  # (.env is parsed, never sourced: executing it would run attacker text.)
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -qi renom; then
    info "Stopping pm2 process..."
    pm2 delete renom 2>/dev/null || true
  fi
  pkill -f "apps/panel/dist/server/index.js" 2>/dev/null || true
  info "Stopped panel processes, if any were running."

  if [ "$purge" = "yes" ] || [ "$purge" = "YES" ]; then
    local data_dir="./data"
    if [ -f .env ]; then
      local found
      found="$(grep -E '^DATA_DIR=' .env 2>/dev/null | cut -d= -f2- | tr -d '\r' | head -n 1 || true)"
      if [ -n "$found" ]; then data_dir="$found"; fi
    fi
    warn "Deleting data in $data_dir — this cannot be undone."
    local sure
    sure="$(ask "Type YES-I-AM-SURE" "")"
    if [ "$sure" = "YES-I-AM-SURE" ]; then
      rm -rf -- "$data_dir"
      ok "Server data deleted."
    else
      say "Keeping server data."
    fi
  else
    ok "Server data kept. Reinstall later and it will be picked up."
  fi
  say ""
  say "To finish, delete this folder yourself:  rm -rf $(pwd)"
  say "(The script won't delete the folder it's running from.)"
}

main() {
  ensure_repo "$@"
  banner
  say "What should I do?"
  say "  1) Install panel   (fresh setup: dependencies, port, admin account)"
  say "  2) Update panel    (git pull, rebuild, restart)"
  say "  3) Delete panel    (remove install; server data kept unless you say so)"
  say ""
  local choice
  choice="$(ask "Choose 1, 2 or 3" "1")"
  case "$choice" in
    1) do_install ;;
    2) do_update ;;
    3) do_delete ;;
    *) die "Choose 1, 2 or 3." ;;
  esac
}

main "$@"
