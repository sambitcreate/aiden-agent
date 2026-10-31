#!/usr/bin/env bash
# The in-Space half of scripts/cua-space-e2e.sh, which copies it into the Space for each run and runs it there as
#   bash aiden-run-<id>.sh <run id> <package-lock hash> [--run <command...> | --watch] [playwright args]
# It takes the Space's run lock, installs Node and CI's apt packages, refreshes the synced checkout and its npm cache,
# then runs the command or the Playwright suite and packs the results for the host. It deletes itself on exit.
set -uo pipefail
RUN_ID="$1"; LOCK_HASH="$2"; shift 2
SRC=~/aiden-src-$RUN_ID.tgz
RESULTS=~/test-results-$RUN_ID.tgz
trap 'rm -f "$SRC" "$0"' EXIT

exec 9>"${AIDEN_E2E_LOCK:-/tmp/aiden-e2e.lock}"  # override only for tests
if ! flock -n 9; then
  echo "SPACE_BUSY: another run is using this Space. Wait for it, set CUA_SPACE to another Space, or run --reset if an interrupted run left processes behind."
  exit 75
fi

# Run children in the background and wait, so Ctrl-C / a dropped host (SIGINT/TERM/HUP from `exec -i`)
# stops the whole tree instead of orphaning Electron and Xvfb. Children do not inherit the lock fd, so only this
# script holds the lock and it is released when the script exits.
# shellcheck disable=SC2329 # reached through the signal trap below
kill_tree() { local child; for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill "$1" 2>/dev/null; }
# shellcheck disable=SC2329 # the signal trap
on_signal() { local child; for child in $(pgrep -P $$); do kill_tree "$child"; done; exit 130; }
trap on_signal INT TERM HUP
run_fg() { "$@" 9>&- & wait $!; }

NODE_VERSION=22.23.4
case "$(uname -m)" in aarch64|arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
if ! /opt/node22/bin/node --version 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  { curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz &&
    sudo rm -rf /opt/node22 && sudo mkdir -p /opt/node22 &&
    sudo tar -xJf /tmp/node.tar.xz -C /opt/node22 --strip-components=1; } || { echo "NODE_INSTALL_FAILED"; exit 2; }
fi
export PATH=/opt/node22/bin:$PATH
if [ "$(node --version)" != "v$NODE_VERSION" ]; then echo "NODE_VERSION_MISMATCH: $(node --version)"; exit 2; fi

APT_PACKAGES=(xvfb pkg-config libsecret-1-dev libselinux1-dev gnome-keyring dbus-x11 build-essential python3 libnss3
  libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libdrm2)
# The marker records the installed list, so editing the list reinstalls in warm Spaces too.
APT_MARKER=/var/lib/aiden-e2e-apt-packages
if [ "$(cat "$APT_MARKER" 2>/dev/null)" != "${APT_PACKAGES[*]}" ]; then
  export DEBIAN_FRONTEND=noninteractive
  { run_fg sudo -E apt-get update -qq &&
    run_fg sudo -E apt-get install -y -qq "${APT_PACKAGES[@]}" >/dev/null &&
    echo "${APT_PACKAGES[*]}" | sudo tee "$APT_MARKER" >/dev/null; } || { echo "APT_INSTALL_FAILED"; exit 2; }
fi

# Fail rather than clear whatever directory we are in if the checkout directory cannot be entered.
{ mkdir -p ~/aiden-agent && cd ~/aiden-agent; } || { echo "CHECKOUT_DIR_FAILED"; exit 2; }
# Replace the source but keep node_modules between runs.
find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf "$SRC" || { echo "SOURCE_EXTRACT_FAILED"; exit 2; }
CACHE_KEY="$LOCK_HASH-node$NODE_VERSION-$(uname -m)"
if [ "$(cat node_modules/.aiden-cache-key 2>/dev/null)" != "$CACHE_KEY" ]; then
  run_fg npm ci --no-audit --no-fund || { echo "NPM_CI_FAILED"; exit 2; }
  echo "$CACHE_KEY" > node_modules/.aiden-cache-key
else
  # The source swap above deletes postinstall outputs outside node_modules (resources/generative-ui), so
  # rerun the idempotent postinstall when npm ci is skipped.
  run_fg npm run postinstall || { echo "POSTINSTALL_FAILED"; exit 2; }
fi

ulimit -c 0
if [ "${1:-}" = "--run" ]; then
  shift
  run_fg xvfb-run --auto-servernum dbus-run-session -- "$@"
  exit $?
fi

WATCH=0
if [ "${1:-}" = "--watch" ]; then WATCH=1; shift; fi
{ run_fg npm run type-check:e2e && run_fg npm run build; } || { echo "E2E_BUILD_FAILED"; exit 2; }
export CI=1
if [ "$WATCH" = 1 ]; then
  DISPLAY=:1 run_fg dbus-run-session -- npx playwright test --config=playwright.config.ts --fail-on-flaky-tests "$@"
else
  run_fg xvfb-run --auto-servernum dbus-run-session -- npx playwright test --config=playwright.config.ts --fail-on-flaky-tests "$@"
fi
status=$?
tar -czf "$RESULTS" test-results playwright-report 2>/dev/null || true
exit $status
