#!/usr/bin/env bash
# Run Aiden's Electron e2e suite inside a local Cua Spaces Linux sandbox so test windows never take over
# this Mac's display. It follows CI's Linux E2E job (Node 22.23.4, CI's apt packages, xvfb-run, CI=1), but on
# Apple silicon the Space is Linux arm64, and specs that branch on darwin take their Linux path here.
#
#   scripts/cua-space-e2e.sh                                     # full suite
#   scripts/cua-space-e2e.sh tests/e2e/workspace-panel.spec.ts   # any playwright args
#   scripts/cua-space-e2e.sh --watch tests/e2e/foo.spec.ts       # render on the Space desktop (watch it in Cua Spaces)
#   scripts/cua-space-e2e.sh --run npm run test:foreground-file-tools:electron  # any window-opening command (argv)
#   scripts/cua-space-e2e.sh --reset                             # stop processes left by an interrupted run
#   CUA_SPACE=aiden-e2e-2 scripts/cua-space-e2e.sh --shard=2/3   # another Space, e.g. a concurrent session or shard
#
# One run at a time per Space (a second run against a busy Space exits 75). New Spaces get CUA_SPACE_CPUS (4) and
# CUA_SPACE_MEMORY (8GB); on a Mac all Linux Spaces share cua's runtime VM, so parallel shards need a bigger one
# (`cua config set runtime.linux_cpus` / `runtime.linux_memory_gib`).
# Needs the cua CLI (https://cua.ai/install.sh). Removes nothing on the host; `cua sb rm <name>` deletes the Space.
set -euo pipefail

SPACE="${CUA_SPACE:-aiden-e2e}"
REF="local:$SPACE"
CUA="${CUA_BIN:-$(command -v cua || echo "$HOME/.local/bin/cua")}"
export CUA_TELEMETRY="${CUA_TELEMETRY:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -x "$CUA" ]; then
  echo "cua CLI not found. Install it with: curl -fsSL https://cua.ai/install.sh | DO_NOT_TRACK=1 sh -s -- --only spaces --no-onboarding" >&2
  exit 127
fi

if ! LIST_JSON="$("$CUA" sb ls --local --json)"; then
  echo "cua sb ls failed; is the cua daemon running?" >&2
  exit 1
fi
SPACE_STATUS="$(printf '%s' "$LIST_JSON" | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c)).on("end", () => {
    const space = JSON.parse(raw).find((s) => s.id === process.argv[1]);
    process.stdout.write(space ? String(space.status) : "missing");
  });' "$REF")"
# A missing or stopped Space has no processes left to stop, so --reset does not create or resume one.
if [ "${1:-}" = "--reset" ] && [ "$SPACE_STATUS" != ready ]; then
  echo "Space $SPACE is $SPACE_STATUS; nothing to reset."
  exit 0
fi
case "$SPACE_STATUS" in
  missing)
    echo "Creating Space $SPACE…"
    "$CUA" sb create linux --on local --name "$SPACE" --cpu "${CUA_SPACE_CPUS:-4}" --memory "${CUA_SPACE_MEMORY:-8GB}" --wait desktop ;;
  ready) ;;
  *)
    echo "Space $SPACE is $SPACE_STATUS; resuming…"
    "$CUA" sb resume "$REF" ;;
esac

if [ "${1:-}" = "--reset" ]; then
  # Stop this user's processes that run in or from the synced checkout (npm, builds, Electron, xvfb-run/Xvfb) or
  # hold the run lock. It matches on cwd, executable and open files, not command lines, so it cannot match itself.
  # Exits 1 when nothing was found, which is a clean Space rather than a failure.
  # shellcheck disable=SC2016
  RESET_GUEST='cd / || exit 2
    uid="$(id -u)"; found=""
    for dir in /proc/[0-9]*; do
      pid="${dir#/proc/}"
      [ "$pid" = "$$" ] && continue
      [ "$(stat -c %u "$dir" 2>/dev/null)" = "$uid" ] || continue
      hit=0
      case "$(readlink "$dir/cwd" 2>/dev/null)" in "$HOME/aiden-agent" | "$HOME/aiden-agent/"*) hit=1 ;; esac
      case "$(readlink "$dir/exe" 2>/dev/null)" in "$HOME/aiden-agent/"*) hit=1 ;; esac
      for fd in "$dir"/fd/*; do [ "$(readlink "$fd" 2>/dev/null)" = /tmp/aiden-e2e.lock ] && hit=1; done
      [ "$hit" = 1 ] && found="$found $pid"
    done
    [ -n "$found" ] || exit 1
    kill $found 2>/dev/null; sleep 2; kill -9 $found 2>/dev/null; exit 0'
  set +e
  "$CUA" sb exec -i "$REF" -- bash -c "$RESET_GUEST" </dev/null
  status=$?
  set -e
  case "$status" in
    0) echo "Stopped leftover e2e processes in $SPACE." ;;
    1) echo "No leftover e2e processes in $SPACE." ;;
    *) exit "$status" ;;
  esac
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
RUN_ID="$(basename "$WORK")"

# Tracked and untracked (non-ignored) files, so uncommitted work is tested too. `ls-files -c` still lists
# tracked paths deleted from the working tree, so keep only paths that exist; tar still fails on unreadable ones.
# Untracked secrets that .gitignore does not cover stay on the host.
(cd "$ROOT" && {
  git ls-files -c -z
  git ls-files -o --exclude-standard -z -- . ':(exclude,glob)**/.env*' ':(exclude,glob)**/.npmrc' \
    ':(exclude,glob)**/*.pem' ':(exclude,glob)**/*.key' ':(exclude,glob)**/*.p12' ':(exclude,glob)**/*.p8' \
    ':(exclude,glob)**/*.pfx' ':(exclude,glob)**/*.jks' ':(exclude,glob)**/*.keystore' ':(exclude,glob)**/*.ppk' \
    ':(exclude,glob)**/*.mobileprovision' ':(exclude,glob)**/id_rsa*' ':(exclude,glob)**/id_dsa*' \
    ':(exclude,glob)**/id_ecdsa*' ':(exclude,glob)**/id_ed25519*' ':(exclude,glob)**/.netrc' \
    ':(exclude,glob)**/.git-credentials'
} | while IFS= read -r -d '' path; do if [ -e "$path" ] || [ -L "$path" ]; then printf '%s\0' "$path"; fi; done \
  | COPYFILE_DISABLE=1 tar --null -T - -czf "$WORK/src.tgz" --no-xattrs)
LOCK_HASH="$(shasum -a 256 "$ROOT/package-lock.json" | cut -d' ' -f1)"

cat > "$WORK/run.sh" <<'GUEST'
#!/usr/bin/env bash
set -uo pipefail
RUN_ID="$1"; LOCK_HASH="$2"; shift 2
SRC=~/aiden-src-$RUN_ID.tgz
RESULTS=~/test-results-$RUN_ID.tgz
trap 'rm -f "$SRC" "$0"' EXIT

exec 9>/tmp/aiden-e2e.lock
if ! flock -n 9; then
  echo "SPACE_BUSY: another run is using this Space. Wait for it, set CUA_SPACE to another Space, or run --reset if an interrupted run left processes behind."
  exit 75
fi

# Run children in the background and wait, so Ctrl-C / a dropped host (SIGINT/TERM/HUP from `exec -i`)
# stops the whole tree instead of orphaning Electron and Xvfb. Children do not inherit the lock fd, so only this
# script holds the lock and it is released when the script exits.
kill_tree() { local child; for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill "$1" 2>/dev/null; }
trap 'for c in $(pgrep -P $$); do kill_tree "$c"; done; exit 130' INT TERM HUP
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

APT_PACKAGES="xvfb pkg-config libsecret-1-dev libselinux1-dev gnome-keyring dbus-x11 build-essential python3 libnss3
  libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libdrm2"
APT_PACKAGES="$(echo $APT_PACKAGES)"
# The marker records the installed list, so editing the list reinstalls in warm Spaces too.
APT_MARKER=/var/lib/aiden-e2e-apt-packages
if [ "$(cat "$APT_MARKER" 2>/dev/null)" != "$APT_PACKAGES" ]; then
  export DEBIAN_FRONTEND=noninteractive
  # shellcheck disable=SC2086
  { run_fg sudo -E apt-get update -qq &&
    run_fg sudo -E apt-get install -y -qq $APT_PACKAGES >/dev/null &&
    echo "$APT_PACKAGES" | sudo tee "$APT_MARKER" >/dev/null; } || { echo "APT_INSTALL_FAILED"; exit 2; }
fi

mkdir -p ~/aiden-agent && cd ~/aiden-agent
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
GUEST

"$CUA" sb cp "$WORK/src.tgz" "$REF:/home/cua/aiden-src-$RUN_ID.tgz" >/dev/null
"$CUA" sb cp "$WORK/run.sh" "$REF:/home/cua/aiden-run-$RUN_ID.sh" >/dev/null

set +e
# -i streams output, passes argv untouched, sets no time limit and returns the guest's exit status
# (plain `sb exec` applies a default timeout that cuts a full run short).
"$CUA" sb exec -i "$REF" -- bash "/home/cua/aiden-run-$RUN_ID.sh" "$RUN_ID" "$LOCK_HASH" "$@" </dev/null
status=$?
set -e

OUT="$ROOT/test-results/cua-space-$SPACE"
if "$CUA" sb cp "$REF:/home/cua/test-results-$RUN_ID.tgz" "$WORK/results.tgz" >/dev/null 2>&1; then
  "$CUA" sb exec -i "$REF" -- rm -f "/home/cua/test-results-$RUN_ID.tgz" </dev/null || true
  # Unpack beside the previous artifacts and swap only on success, so a bad archive keeps the last good report.
  mkdir -p "$WORK/results"
  if tar -xzf "$WORK/results.tgz" -C "$WORK/results" && [ -n "$(ls -A "$WORK/results")" ]; then
    rm -rf "$OUT" && mkdir -p "$(dirname "$OUT")" && mv "$WORK/results" "$OUT"
    echo "Artifacts copied to $OUT"
  else
    echo "The run's artifacts were unreadable or empty; $OUT still holds the previous run's." >&2
  fi
elif [ "${1:-}" != "--run" ]; then
  # --run never writes an archive; a Playwright run that left none (busy Space, failed setup or build) says so.
  echo "This run left no artifacts; $OUT still holds the previous run's." >&2
fi
exit $status
