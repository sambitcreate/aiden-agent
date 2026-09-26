# Source before any fixture mutation; each cleanup step must survive failures.
cleanup() {
  local result=$?
  trap - EXIT
  set +e
  if [[ -n "${delegation_unit:-}" ]]; then systemctl stop "$delegation_unit" >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  if [[ -n "${receiver_pid:-}" ]]; then wait "$receiver_pid" || result=1; fi
  rm -rf -- "$installation" "$runtime" "$work" >>"$evidence/cleanup.log" 2>&1 || result=1
  if "$deny_installed"; then semodule -r aiden_ipc_probe_deny >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  if "$base_installed"; then semodule -r aiden_ipc_probe >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  if "$user_created"; then userdel "$user" >>"$evidence/cleanup.log" 2>&1 || result=1; fi
  printf 'exit=%s\n' "$result" >>"$evidence/cleanup.log" || result=1
  exit "$result"
}
