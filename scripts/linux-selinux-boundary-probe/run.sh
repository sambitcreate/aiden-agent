#!/usr/bin/env bash
# Disposable guest only. No setenforce, booleans, global audit changes or -N.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
evidence="${1:?Usage: sudo bash run.sh /absolute/new/evidence-directory}"
[[ "$EUID" -eq 0 && "$evidence" == /* && ! -e "$evidence" ]]
[[ "$(getenforce)" == Enforcing ]]
grep -qx 'ID=fedora' /etc/os-release
user=aiden-boundary-probe
unit=aiden-selinux-boundary-probe.service
installation=/usr/libexec/aiden-selinux-boundary-probe
runtime=/run/aiden-selinux-boundary-probe
[[ ! -e "$installation" && ! -e "$runtime" && ! -e "/etc/systemd/system/$unit" ]]
! getent passwd "$user" >/dev/null
! semodule -l | grep -q '^aiden_boundary_probe\(_deny\)\?\s'
mkdir -m 700 -- "$evidence"
work="$(mktemp -d /var/tmp/aiden-boundary-build.XXXXXX)"
base_installed=false
deny_installed=false
user_created=false
source "$source_dir/cleanup.sh"
trap cleanup EXIT
uname -r >"$evidence/kernel.txt"
rpm -q libsepol libselinux secilc policycoreutils selinux-policy-targeted setools-console >"$evidence/packages.txt"
cat /sys/kernel/security/lsm >"$evidence/lsm.txt"
getenforce >"$evidence/enforcement.txt"
getsebool deny_ptrace >"$evidence/ptrace-boolean.txt"
cat /proc/sys/kernel/yama/ptrace_scope >"$evidence/yama.txt"
sha256sum /sys/fs/selinux/policy >"$evidence/policy-original.sha256"
audit_inode="$(stat -c %i /var/log/audit/audit.log)"
audit_offset="$(stat -c %s /var/log/audit/audit.log)"
cp -- "$source_dir"/fixture.c "$source_dir"/aiden_boundary_probe.te "$work/"
gcc -std=c17 -Wall -Wextra -Werror -O2 "$work/fixture.c" -o "$work/fixture"
make -C "$work" -f /usr/share/selinux/devel/Makefile aiden_boundary_probe.pp >"$evidence/build.log" 2>&1
semodule -i "$work/aiden_boundary_probe.pp" >"$evidence/install-base.log" 2>&1
base_installed=true
useradd --system --no-create-home --shell /sbin/nologin "$user"
user_created=true
install -d -o root -g root -m 755 "$installation"
install -o root -g root -m 755 "$work/fixture" "$installation/holder"
install -o root -g root -m 755 "$work/fixture" "$installation/attacker"
chcon -t aiden_boundary_probe_exec_t "$installation/holder"
chcon -t bin_t "$installation/attacker"
install -d -o "$user" -g "$user" -m 755 "$runtime"
printf 'synthetic-probe-data\n' >"$runtime/private.txt"
chown "$user:$user" "$runtime/private.txt"
chmod 600 "$runtime/private.txt"
chcon -R -t aiden_boundary_probe_data_t "$runtime"
cat >"/etc/systemd/system/$unit" <<UNIT
[Unit]
Description=Disposable Aiden SELinux boundary experiment
[Service]
Type=simple
User=$user
Group=$user
ExecStart=$installation/holder holder
StandardInput=null
StandardOutput=null
StandardError=null
TimeoutStopSec=3
KillMode=control-group
UNIT
chmod 644 "/etc/systemd/system/$unit"
systemctl daemon-reload
start_holder() {
  systemctl start "$unit"
  for ((attempt=0; attempt<50; attempt++)); do
    [[ -S "$runtime/socket" ]] && break
    sleep 0.1
  done
  [[ -S "$runtime/socket" ]]
  pid="$(systemctl show -p MainPID --value "$unit")"
  [[ "$pid" -gt 1 ]]
  # The native holder checks its context and non-root UID before opening this
  # socket. The deny overlay intentionally blocks unconfined root's /proc too.
  if ! "$deny_installed"; then
    grep -q ':aiden_boundary_probe_t:' "/proc/$pid/attr/current"
    [[ "$(stat -c %u "/proc/$pid")" == "$(id -u "$user")" ]]
  fi
}
run_probe() {
  local phase="$1" operation="$2" status
  shift 2
  set +e
  runuser -u "$user" -- "$installation/attacker" "$operation" "$@" >"$evidence/$phase-$operation.json" 2>"$evidence/$phase-$operation.stderr"
  status=$?
  set -e
  [[ "$status" -eq 0 || "$status" -eq 1 ]]
  [[ ! -s "$evidence/$phase-$operation.stderr" ]]
}
query_policy() {
  local phase="$1"
  cp /sys/fs/selinux/policy "$evidence/$phase.policy"
  sha256sum "$evidence/$phase.policy" >"$evidence/$phase-policy.sha256"
  sesearch -A -s unconfined_t -t aiden_boundary_probe_data_t -c file -p read "$evidence/$phase.policy" >"$evidence/$phase-file-allow.txt"
  sesearch -A -s unconfined_t -t aiden_boundary_probe_t -c file -p read "$evidence/$phase.policy" >"$evidence/$phase-proc-allow.txt"
  sesearch -A -s unconfined_t -t aiden_boundary_probe_t -c unix_stream_socket -p connectto "$evidence/$phase.policy" >"$evidence/$phase-socket-allow.txt"
  sesearch -A -t aiden_boundary_probe_t -c process -p transition "$evidence/$phase.policy" >"$evidence/$phase-transition-allow.txt"
  sesearch -A -t aiden_boundary_probe_t -c process -p dyntransition "$evidence/$phase.policy" >"$evidence/$phase-dyntransition-allow.txt"
  sesearch -A -s unconfined_t -t aiden_boundary_probe_t -c process -p ptrace "$evidence/$phase.policy" >"$evidence/$phase-ptrace-allow.txt"
  sesearch --dontaudit -s unconfined_t -t aiden_boundary_probe_t -c file -p read "$evidence/$phase.policy" >"$evidence/$phase-proc-dontaudit.txt"
}
start_holder
runuser -u "$user" -- cat /proc/self/attr/current >"$evidence/attacker-context.txt"
grep -q ':unconfined_t:' "$evidence/attacker-context.txt"
cat "/proc/$pid/attr/current" >"$evidence/holder-context.txt"
id "$user" >"$evidence/attacker-identity.txt"
ls -ldZ "$installation" "$installation/holder" "$runtime" "$runtime/private.txt" >"$evidence/ownership.txt"
query_policy before
for operation in file socket; do run_probe before "$operation"; done
for operation in proc proc-fd ptrace pidfd; do run_probe before "$operation" "$pid"; done
semodule -i "$source_dir/aiden_boundary_probe_deny.cil" >"$evidence/install-deny.log" 2>&1
deny_installed=true
query_policy after
for operation in file socket; do run_probe after "$operation"; done
for operation in proc proc-fd ptrace pidfd; do run_probe after "$operation" "$pid"; done
set +e
runuser -u "$user" -- timeout --kill-after=1 2 "$installation/holder" holder >"$evidence/direct-exec.txt" 2>&1
direct_status=$?
runuser -u "$user" -- timeout --kill-after=1 2 runcon -t aiden_boundary_probe_t "$installation/holder" holder >"$evidence/runcon.txt" 2>&1
runcon_status=$?
set -e
printf '{"direct":%s,"runcon":%s}\n' "$direct_status" "$runcon_status" >"$evidence/entry-attempts.json"
[[ "$direct_status" -ne 0 && "$direct_status" -ne 124 && "$direct_status" -ne 137 && "$runcon_status" -ne 0 ]]
! grep -q 'invalid context' "$evidence/runcon.txt"
systemctl stop "$unit"
rm -f "$runtime/socket"
start_holder
printf 'native-context-check-before-socket\n' >"$evidence/hardened-holder-check.txt"
# Read only this run's appended records, filtering before retaining evidence.
# Audit delivery is asynchronous. Rotation or missing AVCs must fail validation.
for ((attempt=0; attempt<30; attempt++)); do
  [[ "$(stat -c %i /var/log/audit/audit.log)" == "$audit_inode" ]]
  tail -c "+$((audit_offset + 1))" /var/log/audit/audit.log | grep 'type=AVC.*aiden_boundary_probe' >"$evidence/avc.txt" || true
  if node "$source_dir/verify.mjs" "$evidence" >"$evidence/result.json" 2>"$evidence/verify-error.txt"; then break; fi
  sleep 0.1
done
node "$source_dir/verify.mjs" "$evidence" >"$evidence/result.json"
# A reversible subtraction must restore the selected stock grants.
semodule -r aiden_boundary_probe_deny
deny_installed=false
cat "/proc/$pid/attr/current" >"$evidence/restored-holder-context.txt"
for operation in file socket; do run_probe restored "$operation"; done
run_probe restored proc "$pid"
node "$source_dir/verify.mjs" "$evidence" --restored >"$evidence/restored-result.json"
cat "$evidence/result.json" "$evidence/restored-result.json"
