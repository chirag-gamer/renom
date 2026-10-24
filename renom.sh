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

have() { command -v "$1" >/dev/null 2>&1; }

# Verify systemd is booted and active as PID 1 / live init manager.
# Avoid false positives in containers or chroots where /run/systemd/system may be exposed
# or mock systemctl is installed, but systemd is not actively managing services.
is_systemd_active() {
  have systemctl || return 1
  [ -d "/run/systemd/system" ] || return 1

  # Check if PID 1 is systemd
  if [ -r /proc/1/comm ] && [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ]; then
    return 0
  fi
  if [ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ]; then
    return 0
  fi

  # Or verify systemd manager liveness via communication
  local state
  state="$(systemctl is-system-running 2>/dev/null || true)"
  case "$state" in
    running|degraded|maintenance|starting|initializing)
      return 0
      ;;
  esac

  return 1
}

# Stop any running panel process scoped specifically to this checkout directory.
# Waits up to 30 seconds for the panel and any managed game servers to shut down cleanly
# before the listening port is released.
stop_panel_processes() {
  local cur_dir
  cur_dir="$(pwd -P 2>/dev/null || pwd)"
  local candidate_pids=""

  if command -v pgrep >/dev/null 2>&1; then
    candidate_pids="$(pgrep -f "dist/server/index.js" 2>/dev/null || true)"
  elif command -v ps >/dev/null 2>&1; then
    candidate_pids="$(ps -eo pid,args 2>/dev/null | grep "dist/server/index.js" | grep -v grep | awk '{print $1}' || true)"
  fi
  [ -n "$candidate_pids" ] || return 0

  local target_pids=""
  for pid in $candidate_pids; do
    [ -n "$pid" ] || continue
    local matched=0
    if [ -d "/proc/$pid" ]; then
      local proc_cwd proc_cmd
      proc_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
      proc_cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$proc_cwd" in
        "$cur_dir"|"$cur_dir"/*) matched=1 ;;
      esac
      case "$proc_cmd" in
        *"$cur_dir/"*|*"$cur_dir "*) matched=1 ;;
      esac
    elif command -v pwdx >/dev/null 2>&1; then
      local proc_cwd
      proc_cwd="$(pwdx "$pid" 2>/dev/null | cut -d: -f2- | tr -d ' ' || true)"
      case "$proc_cwd" in
        "$cur_dir"|"$cur_dir"/*) matched=1 ;;
      esac
    elif command -v lsof >/dev/null 2>&1; then
      local lsof_cwd
      lsof_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
      case "$lsof_cwd" in
        "$cur_dir"|"$cur_dir"/*) matched=1 ;;
      esac
    fi

    if [ "$matched" -eq 1 ]; then
      target_pids="${target_pids} $pid"
    fi
  done

  [ -n "$target_pids" ] || return 0

  info "Stopping previous panel process (PID(s):$target_pids)..."
  for pid in $target_pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  # The panel's SIGTERM handler terminates its child game server processes, then closes the HTTP server.
  # Poll up to 30s for the process to exit so port 8080 is freed before starting the new instance.
  local i=0
  while [ "$i" -lt 30 ]; do
    local any_alive=0
    for pid in $target_pids; do
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=1
        break
      fi
    done
    [ "$any_alive" -eq 1 ] || break
    sleep 1
    i=$((i + 1))
  done

  # Force kill if still lingering after timeout
  for pid in $target_pids; do
    if kill -0 "$pid" 2>/dev/null; then
      warn "Process $pid did not exit cleanly within 30s; sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
}

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
  info "Ensuring Java runtimes required by Minecraft are installed..."
  bash ./install.sh --ensure-java || die "Java runtime provisioning failed."
  info "Reinstalling dependencies and rebuilding..."
  npm install --no-audit --no-fund || die "npm install failed."
  npm run build || die "Build failed."
  if is_systemd_active && systemctl list-unit-files >/dev/null 2>&1 && systemctl is-enabled --quiet renom.service 2>/dev/null; then
    sudo systemctl restart renom.service || die "Update built, but the Renom service restart failed."
    ok "Updated and restarted the Renom background service."
  elif command -v pm2 >/dev/null 2>&1 && pm2 describe renom >/dev/null 2>&1; then
    if pm2 restart renom; then
      ok "Updated and restarted the Renom pm2 process."
    else
      warn "Could not restart pm2 process automatically. Run: pm2 restart renom"
    fi
  elif [ -t 1 ] && { [ -t 0 ] || (exec </dev/tty) 2>/dev/null; }; then
    ok "Updated."
    stop_panel_processes
    say "Starting Renom server now..."
    say ""
    exec npm start --workspace @renom/panel
  else
    ok "Updated. Restart the panel to run the new code."
    say "  If you run it by hand:  npm start --workspace @renom/panel"
  fi
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
  if command -v pm2 >/dev/null 2>&1 && pm2 describe renom >/dev/null 2>&1; then
    info "Stopping pm2 process..."
    pm2 delete renom 2>/dev/null || true
  fi
  stop_panel_processes
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
