#!/usr/bin/env bash
# Best effort teardown; failures never skip subsequent cleanup steps.
cleanup() {
  local original=$? failed=0
  trap - EXIT
  if "$unit_created"; then systemctl stop "$unit" >>"$evidence/cleanup.log" 2>&1 || failed=1; fi
  python3 "$source_dir/stop-processes.py" >>"$evidence/cleanup.log" 2>&1 || failed=1
  rm -f -- "/etc/systemd/system/$unit" >>"$evidence/cleanup.log" 2>&1 || failed=1
  systemctl daemon-reload >>"$evidence/cleanup.log" 2>&1 || failed=1
  rm -rf -- "$installation" "$runtime" "$work" >>"$evidence/cleanup.log" 2>&1 || failed=1
  if "$deny_installed"; then semodule -r aiden_electron_role_probe_deny >>"$evidence/cleanup.log" 2>&1 || failed=1; fi
  if "$base_installed"; then semodule -r aiden_electron_role_probe >>"$evidence/cleanup.log" 2>&1 || failed=1; fi
  getenforce >"$evidence/enforcement-after.txt" || failed=1
  semodule -l >"$evidence/modules-after.txt" || failed=1
  printf '%s\n' "$failed" >"$evidence/cleanup-status.txt"
  if [[ $original -ne 0 ]]; then exit "$original"; fi
  exit "$failed"
}
