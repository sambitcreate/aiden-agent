#!/usr/bin/env bash
# Run Aiden's Electron e2e suite inside a local Cua Spaces Linux sandbox so test windows never take over
# this Mac's display. Mirrors CI's Linux job: Node 22.22.3, CI's apt packages, xvfb-run.
#
#   scripts/cua-space-e2e.sh                                     # full suite
#   scripts/cua-space-e2e.sh tests/e2e/workspace-panel.spec.ts   # any playwright args
#   scripts/cua-space-e2e.sh --watch tests/e2e/foo.spec.ts       # render on the Space desktop (watch it in Cua Spaces)
#   CUA_SPACE=aiden-e2e-2 scripts/cua-space-e2e.sh --shard=2/3   # a second Space for a parallel shard
#   scripts/cua-space-e2e.sh --run npm run test:foreground-file-tools:electron  # any window-opening command
#
# Needs the cua CLI (https://cua.ai/install.sh). Removes nothing on the host; `cua sb rm <name>` deletes the Space.
set -euo pipefail

SPACE="${CUA_SPACE:-aiden-e2e}"
CUA="${CUA_BIN:-$(command -v cua || echo "$HOME/.local/bin/cua")}"
export CUA_TELEMETRY="${CUA_TELEMETRY:-0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! "$CUA" sb ls 2>/dev/null | grep -q "local:$SPACE "; then
  echo "Creating Space $SPACE…"
  "$CUA" sb create linux --name "$SPACE" --cpu 8 --memory 16GB --wait desktop
fi

# Tracked and untracked (non-ignored) files, so uncommitted work is tested too.
(cd "$ROOT" && git ls-files -co --exclude-standard -z | COPYFILE_DISABLE=1 tar --null -T - -czf "$WORK/src.tgz" --no-xattrs)
LOCK_HASH="$(shasum -a 256 "$ROOT/package-lock.json" | cut -d' ' -f1)"

cat > "$WORK/run.sh" <<'GUEST'
#!/usr/bin/env bash
set -uo pipefail
LOCK_HASH="$1"; shift
NODE_VERSION=22.22.3
case "$(uname -m)" in aarch64|arm64) NODE_ARCH=arm64 ;; *) NODE_ARCH=x64 ;; esac
if ! /opt/node22/bin/node --version 2>/dev/null | grep -q "v$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_ARCH.tar.xz" -o /tmp/node.tar.xz
  sudo mkdir -p /opt/node22 && sudo tar -xJf /tmp/node.tar.xz -C /opt/node22 --strip-components=1
fi
export PATH=/opt/node22/bin:$PATH
if [ ! -f /var/lib/aiden-e2e-apt-done ]; then
  export DEBIAN_FRONTEND=noninteractive
  sudo -E apt-get update -qq
  sudo -E apt-get install -y -qq xvfb pkg-config libsecret-1-dev libselinux1-dev gnome-keyring dbus-x11 \
    build-essential python3 libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2t64 libxss1 libdrm2 >/dev/null
  sudo touch /var/lib/aiden-e2e-apt-done
fi

mkdir -p ~/aiden-agent && cd ~/aiden-agent
# Replace the source but keep node_modules between runs.
find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -xzf ~/aiden-src.tgz
if [ "$(cat node_modules/.aiden-lock-hash 2>/dev/null)" != "$LOCK_HASH" ]; then
  npm ci --no-audit --no-fund && echo "$LOCK_HASH" > node_modules/.aiden-lock-hash
fi

ulimit -c 0
if [ "${1:-}" = "--run" ]; then
  shift
  xvfb-run --auto-servernum dbus-run-session -- bash -c "$*"
  exit $?
fi

WATCH=0
if [ "${1:-}" = "--watch" ]; then WATCH=1; shift; fi
npm run type-check:e2e && npm run build || { echo "E2E_BUILD_FAILED"; exit 2; }
if [ "$WATCH" = 1 ]; then
  DISPLAY=:1 dbus-run-session -- npx playwright test --config=playwright.config.ts --fail-on-flaky-tests "$@"
else
  xvfb-run --auto-servernum dbus-run-session -- npx playwright test --config=playwright.config.ts --fail-on-flaky-tests "$@"
fi
status=$?
tar -czf ~/test-results.tgz test-results playwright-report 2>/dev/null || true
exit $status
GUEST

"$CUA" sb cp "$WORK/src.tgz" "$SPACE:/home/cua/aiden-src.tgz" >/dev/null
"$CUA" sb cp "$WORK/run.sh" "$SPACE:/home/cua/aiden-run.sh" >/dev/null

set +e
# -i streams output, passes argv untouched, sets no time limit and returns the guest's exit status
# (plain `sb exec` applies a default timeout that cuts a full run short).
"$CUA" sb exec -i "$SPACE" -- bash /home/cua/aiden-run.sh "$LOCK_HASH" "$@" </dev/null
status=$?
set -e

OUT="$ROOT/test-results/cua-space-$SPACE"
if "$CUA" sb cp "$SPACE:/home/cua/test-results.tgz" "$WORK/results.tgz" >/dev/null 2>&1; then
  rm -rf "$OUT" && mkdir -p "$OUT"
  tar -xzf "$WORK/results.tgz" -C "$OUT" 2>/dev/null || true
  echo "Artifacts copied to $OUT"
fi
exit $status
