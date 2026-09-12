#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
evidence="${1:?Usage: sudo bash run.sh /absolute/new/evidence-directory}"
[[ "$EUID" -eq 0 && "$evidence" == /* && ! -e "$evidence" ]]
[[ "$(getenforce)" == Enforcing ]]
grep -qx 'ID=fedora' /etc/os-release
user=aiden-protected-ipc-probe
installation=/usr/libexec/aiden-protected-ipc-probe
runtime=/run/aiden-protected-ipc-probe
[[ ! -e "$installation" && ! -e "$runtime" ]]
! getent passwd "$user" >/dev/null
! semodule -l | grep -q '^aiden_ipc_probe\(_deny\)\?\s'
mkdir -m 700 -- "$evidence"
work="$(mktemp -d /var/tmp/aiden-ipc-build.XXXXXX)"
base_installed=false
deny_installed=false
user_created=false
source "$source_dir/cleanup.sh"
trap cleanup EXIT
uname -r >"$evidence/kernel.txt"
rpm -q libsepol libselinux secilc policycoreutils selinux-policy-targeted setools-console >"$evidence/packages.txt"
getenforce >"$evidence/enforcement.txt"
audit_inode="$(stat -c %i /var/log/audit/audit.log)"
audit_offset="$(stat -c %s /var/log/audit/audit.log)"
cp -- "$source_dir"/fixture.c "$source_dir"/aiden_ipc_probe.te "$work/"
gcc -std=c17 -Wall -Wextra -Werror -O2 "$work/fixture.c" -o "$work/fixture"
make -C "$work" -f /usr/share/selinux/devel/Makefile aiden_ipc_probe.pp >"$evidence/build.log" 2>&1
semodule -i "$work/aiden_ipc_probe.pp" >"$evidence/install-base.log" 2>&1
base_installed=true
useradd --system --no-create-home --shell /sbin/nologin "$user"
user_created=true
install -d -o root -g root -m 755 "$installation"
install -o root -g root -m 755 "$work/fixture" "$installation/sender"
install -o root -g root -m 755 "$work/fixture" "$installation/receiver"
chcon -t aiden_ipc_sender_exec_t "$installation/sender"
chcon -t bin_t "$installation/receiver"
install -d -o "$user" -g "$user" -m 755 "$runtime"
chcon -t aiden_ipc_runtime_t "$runtime"
id "$user" >"$evidence/identity.txt"
ls -ldZ "$installation" "$installation/sender" "$installation/receiver" "$runtime" >"$evidence/ownership.txt"
query_policy() {
  local phase="$1"
  cp /sys/fs/selinux/policy "$evidence/$phase.policy"
  sha256sum "$evidence/$phase.policy" >"$evidence/$phase-policy.sha256"
  sesearch -A -s unconfined_t -t aiden_ipc_sender_t -c fd -p use "$evidence/$phase.policy" >"$evidence/$phase-fd-use.txt"
  for permission in read write; do
    sesearch -A -s unconfined_t -t aiden_ipc_sender_t -c unix_stream_socket -p "$permission" "$evidence/$phase.policy" >"$evidence/$phase-generic-$permission.txt"
    sesearch -A -s unconfined_t -t aiden_ipc_protected_socket_t -c unix_stream_socket -p "$permission" "$evidence/$phase.policy" >"$evidence/$phase-protected-$permission.txt"
  done
}
run_channel() {
  local phase="$1" channel="$2"
  rm -f "$runtime/transfer.sock"
  runuser -u "$user" -- timeout --kill-after=1 8 "$installation/receiver" receive "$channel" >"$evidence/$phase-$channel-receiver.json" 2>"$evidence/$phase-$channel-receiver.stderr" &
  receiver_pid=$!
  for ((attempt=0; attempt<40; attempt++)); do
    [[ -S "$runtime/transfer.sock" ]] && break
    sleep 0.1
  done
  [[ -S "$runtime/transfer.sock" ]]
  : >"$evidence/$phase-$channel-sender.json"
  chcon -t aiden_ipc_report_t "$evidence/$phase-$channel-sender.json"
  delegation_unit="aiden-ipc-delegation-$$-$phase-$channel.service"
  timeout --kill-after=2 12 systemd-run --unit="$delegation_unit" --quiet --wait --collect --uid="$user" --property=RuntimeMaxSec=8 --property=TimeoutStartSec=3 --property=TimeoutStopSec=2 --property=StandardInput=null --property="StandardOutput=file:$evidence/$phase-$channel-sender.json" "$installation/sender" send "$channel"
  delegation_unit=
  wait "$receiver_pid"
  receiver_pid=
  [[ ! -s "$evidence/$phase-$channel-receiver.stderr" ]]
}
query_policy before
for channel in generic protected; do run_channel before "$channel"; done
semodule -i "$source_dir/aiden_ipc_probe_deny.cil" >"$evidence/install-deny.log" 2>&1
deny_installed=true
query_policy after
for channel in generic protected; do run_channel after "$channel"; done
for ((attempt=0; attempt<30; attempt++)); do
  [[ "$(stat -c %i /var/log/audit/audit.log)" == "$audit_inode" ]]
  tail -c "+$((audit_offset + 1))" /var/log/audit/audit.log | grep 'type=AVC.*aiden_ipc_' >"$evidence/avc.txt" || true
  if node "$source_dir/verify.mjs" "$evidence" >"$evidence/result.json" 2>"$evidence/verify-error.txt"; then break; fi
  sleep 0.1
done
node "$source_dir/verify.mjs" "$evidence" >"$evidence/result.json"
semodule -r aiden_ipc_probe_deny
deny_installed=false
query_policy restored
for channel in generic protected; do run_channel restored "$channel"; done
node "$source_dir/verify.mjs" "$evidence" --restored >"$evidence/restored-result.json"
cat "$evidence/result.json" "$evidence/restored-result.json"
