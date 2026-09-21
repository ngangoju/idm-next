#!/usr/bin/env bash
#
# IDM-Next launcher (macOS / Linux).
#
#   ./run.sh                 start the desktop app, then make sure the extension
#                            is loaded in Chrome and Brave
#   ./run.sh --dev           same, but with the Vite dev server / hot reload
#   ./run.sh --no-extension  only start the app
#   ./run.sh --extension     only do the browser extension step
#
# About the extension step: stable Chrome (137+) removed the --load-extension
# command-line flag, so no script can silently sideload an unpacked extension.
# What this script does instead is everything around the one manual click:
# it checks each browser's profile to see whether the extension is already
# loaded, and if not, opens the extensions page and puts the folder path on
# your clipboard. Chrome and Brave remember an unpacked extension once you have
# loaded it, so you only do this once per browser.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$ROOT/extension"
EXT_ID="$(tr -d '[:space:]' < "$EXT_DIR/EXTENSION_ID")"
PORT=47591                       # fixed in extension/shared.js and app protocol.ts
HEALTH_URL="http://127.0.0.1:$PORT/health"
LOG="$ROOT/idm-next.log"

APP_PID=""

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *)      die "unsupported OS $(uname -s); use macOS or Linux (or WSL)" ;;
esac

# ---------------------------------------------------------------- prerequisites

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major rest minor
  v="$(node -p 'process.versions.node')"
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
  [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 18 ]; }
}

ensure_deps() {
  if [ -d "$ROOT/node_modules/electron" ] && [ -d "$ROOT/node_modules/@idm-next" ]; then
    return
  fi
  say "Installing dependencies (npm install)"
  (cd "$ROOT" && npm install)
}

# ------------------------------------------------------------------- app launch

health_ok() { curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; }

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  if [ -n "$APP_PID" ]; then kill_tree "$APP_PID"; fi
}

start_app() {
  local script="$1"
  if health_ok; then
    say "IDM-Next is already running on 127.0.0.1:$PORT"
    return
  fi

  say "Starting IDM-Next (npm run $script) — output goes to $(basename "$LOG")"
  (cd "$ROOT" && exec npm run "$script") >"$LOG" 2>&1 < /dev/null &
  APP_PID=$!
  trap cleanup EXIT INT TERM

  # The first run builds main + renderer before Electron opens, so allow time.
  local waited=0
  while ! health_ok; do
    if ! kill -0 "$APP_PID" 2>/dev/null; then
      warn "the app exited before it started listening. Last log lines:"
      tail -n 25 "$LOG" >&2 || true
      exit 1
    fi
    if [ "$waited" -ge 120 ]; then
      warn "no response from $HEALTH_URL after 120s. Last log lines:"
      tail -n 25 "$LOG" >&2 || true
      exit 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  say "App is up ($HEALTH_URL)"
}

# ----------------------------------------------------------- browser extension

browser_label() {
  case "$1" in chrome) echo "Google Chrome" ;; brave) echo "Brave" ;; esac
}

browser_scheme() {
  case "$1" in chrome) echo "chrome" ;; brave) echo "brave" ;; esac
}

browser_data_dir() {
  case "$OS:$1" in
    mac:chrome)   echo "${CHROME_DATA_DIR:-$HOME/Library/Application Support/Google/Chrome}" ;;
    mac:brave)    echo "${BRAVE_DATA_DIR:-$HOME/Library/Application Support/BraveSoftware/Brave-Browser}" ;;
    linux:chrome) echo "${CHROME_DATA_DIR:-$HOME/.config/google-chrome}" ;;
    linux:brave)  echo "${BRAVE_DATA_DIR:-$HOME/.config/BraveSoftware/Brave-Browser}" ;;
  esac
}

# Linux: the first matching executable on PATH, or nothing.
linux_bin() {
  local c
  case "$1" in
    chrome) for c in google-chrome-stable google-chrome; do command -v "$c" && return 0; done ;;
    brave)  for c in brave-browser brave-browser-stable brave; do command -v "$c" && return 0; done ;;
  esac
  return 1
}

browser_present() {
  if [ "$OS" = mac ]; then
    local app
    case "$1" in chrome) app="Google Chrome.app" ;; brave) app="Brave Browser.app" ;; esac
    [ -d "/Applications/$app" ] || [ -d "$HOME/Applications/$app" ]
  else
    linux_bin "$1" >/dev/null
  fi
}

browser_open_extensions() {
  local b="$1" url
  url="$(browser_scheme "$b")://extensions"
  if [ "$OS" = mac ]; then
    case "$b" in chrome) open -a "Google Chrome" "$url" ;; brave) open -a "Brave Browser" "$url" ;; esac
  else
    ( nohup "$(linux_bin "$b")" "$url" >/dev/null 2>&1 & )
  fi
}

copy_to_clipboard() {
  if   command -v pbcopy   >/dev/null 2>&1; then printf '%s' "$1" | pbcopy
  elif command -v wl-copy  >/dev/null 2>&1; then printf '%s' "$1" | wl-copy
  elif command -v xclip    >/dev/null 2>&1; then printf '%s' "$1" | xclip -selection clipboard
  elif command -v xsel     >/dev/null 2>&1; then printf '%s' "$1" | xsel --clipboard --input
  else return 1
  fi
}

# Reads the browser's profile files and prints one of:
#   installed:<profile> | disabled:<profile> | moved:<profile> | missing
# "moved" means it is loaded from a different folder than this checkout.
ext_status() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [root, id, dir] = process.argv.slice(1);
    const rank = { missing: 0, moved: 1, disabled: 2, installed: 3 };
    const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
    let best = ["missing", ""];
    let profiles = [];
    try { profiles = fs.readdirSync(root).filter((d) => d === "Default" || /^Profile [0-9]+$/.test(d)); } catch {}
    for (const p of profiles) {
      for (const f of ["Secure Preferences", "Preferences"]) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(root, p, f), "utf8")); } catch { continue; }
        const s = j.extensions && j.extensions.settings && j.extensions.settings[id];
        if (!s || !s.path) continue;
        let st = "installed";
        if (real(path.resolve(root, p, s.path)) !== real(dir)) st = "moved";
        else if (s.state === 0) st = "disabled";
        if (rank[st] > rank[best[0]]) best = [st, p];
      }
    }
    console.log(best[0] === "missing" ? "missing" : best[0] + ":" + best[1]);
  ' "$1" "$EXT_ID" "$EXT_DIR"
}

setup_extension_for() {
  local b="$1" label st kind
  label="$(browser_label "$b")"

  if ! browser_present "$b"; then
    say "$label: not installed, skipping"
    return
  fi

  st="$(ext_status "$(browser_data_dir "$b")")"
  kind="${st%%:*}"
  case "$kind" in
    installed)
      say "$label: extension already loaded (profile: ${st#*:})"
      return ;;
    disabled)
      warn "$label: extension is loaded but switched off. Turn it on at $(browser_scheme "$b")://extensions" ;;
    moved)
      warn "$label: extension is loaded from a different folder than $EXT_DIR."
      warn "   Remove it there and Load unpacked from this folder (the ID stays the same)." ;;
    *)
      say "$label: extension not loaded yet" ;;
  esac

  browser_open_extensions "$b"
  if copy_to_clipboard "$EXT_DIR"; then
    say "Extension folder copied to your clipboard"
  fi
  cat <<MSG

  In $label:
    1. Switch on "Developer mode" (top right of the extensions page)
    2. Click "Load unpacked" and pick:  $EXT_DIR
       (macOS file dialog: press Cmd+Shift+G, paste, Enter, then Open)
    3. Expected extension ID: $EXT_ID

MSG

  if [ -t 0 ]; then
    read -r -p "Press Enter once done (or type s to skip $label): " reply || true
    case "${reply:-}" in s|S) return ;; esac
    st="$(ext_status "$(browser_data_dir "$b")")"
    case "${st%%:*}" in
      installed) say "$label: extension detected" ;;
      *) warn "$label: could not confirm it from the profile files. If it shows in the list, you are fine." ;;
    esac
  fi
}

setup_extensions() {
  setup_extension_for chrome
  setup_extension_for brave
}

# ------------------------------------------------------------------------ main

usage() { awk 'NR >= 3 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; }

main() {
  local dev=0 with_app=1 with_ext=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --dev)          dev=1 ;;
      --no-extension) with_ext=0 ;;
      --extension)    with_app=0 ;;
      -h|--help)      usage; exit 0 ;;
      *)              die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done

  node_ok || die "Node >= 22.18 is required (found: $(node -v 2>/dev/null || echo none))"

  if [ "$with_app" -eq 1 ]; then
    ensure_deps
    if [ "$dev" -eq 1 ]; then start_app dev; else start_app start; fi
  fi

  if [ "$with_ext" -eq 1 ]; then
    setup_extensions
  fi

  if [ -n "$APP_PID" ]; then
    say "IDM-Next is running. Press Ctrl+C to stop it."
    wait "$APP_PID" || true
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
