# Sourced by run.sh. Keep every action independent: EXIT cleanup must finish
# even if removing a unit, reloading systemd, or deleting files fails.
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -n "${delegation_unit:-}" ]]; then systemctl stop "$delegation_unit" >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  # Native receiver has its own six-second alarm; reap it before deleting UID.
  if [[ -n "${receiver_pid:-}" ]]; then wait "$receiver_pid" || result=1; fi
  systemctl stop "$unit" >>"$evidence/cleanup.log" 2>&1 || result=1
  rm -f -- "/etc/systemd/system/$unit" >>"$evidence/cleanup.log" 2>&1 || result=1
  systemctl daemon-reload >>"$evidence/cleanup.log" 2>&1 || result=1
  rm -rf -- "$installation" "$runtime" "$work" >>"$evidence/cleanup.log" 2>&1 || result=1
  if "$deny_installed"; then semodule -r aiden_boundary_probe_deny >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  if "$base_installed"; then semodule -r aiden_boundary_probe >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  if "$user_created"; then userdel "$user" >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  printf 'exit=%s\n' "$result" >>"$evidence/cleanup.log" || result=1
  exit "$result"
}
