#!/usr/bin/env bash
# The in-Space half of `scripts/cua-space-e2e.sh --reset`, which runs it there with `bash -c`. It stops this user's
# processes that run in or from the synced checkout (npm, builds, Electron, xvfb-run/Xvfb) or hold the run lock.
# It matches on cwd, executable and open files, not command lines, so it cannot match itself.
# Exits 0 after stopping something and 1 when nothing was found, which is a clean Space rather than a failure.
PROC="${AIDEN_E2E_PROC:-/proc}"                # override only for tests
LOCK="${AIDEN_E2E_LOCK:-/tmp/aiden-e2e.lock}"  # override only for tests
CHECKOUT="$HOME/aiden-agent"
cd / || exit 2
found=""
for dir in "$PROC"/[0-9]*; do
  pid="${dir##*/}"
  [ "$pid" = "$$" ] && continue
  [ -O "$dir" ] || continue
  hit=0
  case "$(readlink "$dir/cwd" 2>/dev/null)" in "$CHECKOUT" | "$CHECKOUT/"*) hit=1 ;; esac
  case "$(readlink "$dir/exe" 2>/dev/null)" in "$CHECKOUT/"*) hit=1 ;; esac
  for fd in "$dir"/fd/*; do [ "$(readlink "$fd" 2>/dev/null)" = "$LOCK" ] && hit=1; done
  [ "$hit" = 1 ] && found="$found $pid"
done
[ -n "$found" ] || exit 1
# shellcheck disable=SC2086 # one argument per pid
kill $found 2>/dev/null
sleep 2
# shellcheck disable=SC2086
kill -9 $found 2>/dev/null
exit 0
