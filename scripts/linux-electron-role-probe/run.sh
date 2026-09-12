#!/usr/bin/env bash
# Disposable Fedora GNOME guest only. This grants no Computer Use authority.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
evidence="${1:?Usage: sudo bash run.sh /absolute/new/evidence-directory}"
[[ $EUID -eq 0 && "$evidence" == /* && ! -e "$evidence" ]]
[[ $(getenforce) == Enforcing ]]
grep -qx 'ID=fedora' /etc/os-release
[[ $(id -u fedora) == 1000 && -S /run/user/1000/wayland-0 ]]
installation=/usr/libexec/aiden-electron-role-probe
runtime=/var/tmp/aiden-electron-role-probe-runtime
unit=aiden-electron-role-probe.service
sender_unit=aiden-electron-role-probe-sender.service
ipc_runtime=/run/aiden-electron-role-probe-ipc
[[ ! -e "$installation" && ! -e "$runtime" && ! -e "/etc/systemd/system/$unit" ]]
[[ ! -e "$ipc_runtime" && ! -e "/etc/systemd/system/$sender_unit" ]]
! semodule -l | grep -q '^aiden_electron_role_probe\(_deny\)\?\s'
payload=/var/tmp/aiden-electron43/dist
[[ -x "$payload/electron" && "$(realpath "$payload")" == "$payload" ]]
# Reject links/devices/FIFOs before copying operator-provided synthetic inputs.
[[ -z "$(find "$payload" ! -type f ! -type d -print -quit)" ]]
mkdir -m 700 -- "$evidence"
work="$(mktemp -d /var/tmp/aiden-electron-role-build.XXXXXX)"
base_installed=false
deny_installed=false
unit_created=false
sender_created=false
source "$source_dir/cleanup.sh"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
audit_inode="$(stat -c %i /var/log/audit/audit.log)"
audit_offset="$(stat -c %s /var/log/audit/audit.log)"
run_started="$(date -u +'%Y-%m-%d %H:%M:%S')"
uname -a >"$evidence/kernel.txt"
getenforce >"$evidence/enforcement-before.txt"
cat /sys/fs/selinux/policy_capabilities/memfd_class >"$evidence/memfd-class.txt"
semodule -l >"$evidence/modules-before.txt"
cp -- "$source_dir/aiden_electron_role_probe.te" "$work/"
rpm -q nodejs22-devel >"$evidence/napi-headers.txt"
gcc -std=c17 -Wall -Wextra -Werror -O2 "$source_dir/ipc-server.c" -o "$work/ipc-server"
gcc -std=c17 -Wall -Wextra -Werror -O2 -fPIC -shared -I/usr/include/node "$source_dir/ipc-addon.c" -o "$work/ipc-addon.node"
make -C "$work" -f /usr/share/selinux/devel/Makefile aiden_electron_role_probe.pp >"$evidence/build.log" 2>&1
semodule -i "$work/aiden_electron_role_probe.pp" >"$evidence/install-base.log" 2>&1
base_installed=true
semodule -i "$source_dir/aiden_electron_role_probe_deny.cil" >"$evidence/install-deny.log" 2>&1
deny_installed=true
install -d -m 755 "$installation"
cp -a -- "$payload/." "$installation/"
[[ -z "$(find "$installation" ! -type f ! -type d -print -quit)" ]]
chown -R root:root "$installation"
chmod -R go-w "$installation"
install -m 644 "$source_dir/main.cjs" "$source_dir/worker.cjs" "$installation/"
install -m 755 "$work/ipc-server" "$installation/"
install -m 644 "$work/ipc-addon.node" "$installation/"
restorecon -RF "$installation"
chcon -t aiden_electron_role_probe_sender_exec_t "$installation/ipc-server"
chcon -t aiden_electron_role_probe_exec_t "$installation/electron" "$installation/chrome_crashpad_handler"
install -d -o fedora -g fedora -m 700 "$runtime"
sha256sum "$installation/ipc-addon.node" "$installation/ipc-server" "$installation/electron" "$installation/main.cjs" "$installation/worker.cjs" >"$evidence/payload.sha256"
ls -lZ "$installation/electron" "$installation/main.cjs" >"$evidence/payload-metadata.txt"
install -d -o fedora -g fedora -m 700 "$ipc_runtime"
chcon -t aiden_electron_role_probe_ipc_runtime_t "$ipc_runtime"
: >"$evidence/ipc-server.jsonl"
chcon -t aiden_electron_role_probe_report_t "$evidence/ipc-server.jsonl"
sender_created=true
cat >"/etc/systemd/system/$sender_unit" <<UNIT
[Service]
Type=simple
User=fedora
Group=fedora
ExecStart=$installation/ipc-server
StandardInput=null
StandardOutput=file:$evidence/ipc-server.jsonl
StandardError=journal
TimeoutStopSec=3
RuntimeMaxSec=40
LimitCORE=0
KillMode=control-group
UNIT
chmod 644 "/etc/systemd/system/$sender_unit"
unit_created=true
cat >"/etc/systemd/system/$unit" <<UNIT
[Unit]
Description=Disposable Electron SELinux role experiment
[Service]
Type=simple
User=fedora
Group=fedora
WorkingDirectory=$installation
Environment=XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus XDG_SESSION_TYPE=wayland
ExecStart=$installation/electron --ozone-platform=wayland $installation/main.cjs
StandardInput=null
StandardOutput=journal
StandardError=journal
TimeoutStopSec=3
RuntimeMaxSec=50
LimitCORE=0
KillMode=control-group
UNIT
chmod 644 "/etc/systemd/system/$unit"
systemctl daemon-reload
sesearch -A -s aiden_electron_role_probe_main_t -t aiden_electron_role_probe_exec_t -c file >"$evidence/main-exec-rules.txt"
sesearch -T -s aiden_electron_role_probe_main_t -t aiden_electron_role_probe_exec_t >"$evidence/transition-rules.txt"
systemctl start "$sender_unit"
for ((attempt=0; attempt<50; attempt++)); do
  [[ -S "$ipc_runtime/transfer.sock" ]] && break
  sleep 0.1
done
[[ -S "$ipc_runtime/transfer.sock" ]]
systemctl start "$unit"
for ((attempt=0; attempt<200; attempt++)); do
  [[ -e "$runtime/ready" || -e "$runtime/app.json" ]] && break
  sleep 0.1
done
journalctl -u "$unit" --since "$run_started" --no-pager >"$evidence/journal.txt"
[[ "$(stat -c %i /var/log/audit/audit.log)" == "$audit_inode" ]]
tail -c "+$((audit_offset + 1))" /var/log/audit/audit.log | grep 'type=AVC.*aiden_electron_role_probe_' >"$evidence/audit.txt" || true
[[ -e "$runtime/ready" ]] || { [[ ! -e "$runtime/app.json" ]] || cp "$runtime/app.json" "$evidence/"; exit 1; }
main_pid="$(systemctl show -p MainPID --value "$unit")"
[[ "$main_pid" -gt 1 ]]
cgroup="$(systemctl show -p ControlGroup --value "$unit")"
python3 "$source_dir/collect.py" "$main_pid" "$cgroup" >"$evidence/processes.json"
set +e
timeout --kill-after=2 5 runuser -u fedora -- /bin/sh -c 'exec "$1" --version' probe "$installation/electron" >"$evidence/direct.txt" 2>&1
direct_status=$?
timeout --kill-after=2 5 runuser -u fedora -- runcon -u unconfined_u -r unconfined_r -t aiden_electron_role_probe_main_t -- "$installation/electron" --version >"$evidence/forged.txt" 2>&1
forged_status=$?
set -e
printf '{"direct":%d,"forged":%d}\n' "$direct_status" "$forged_status" >"$evidence/negative-status.json"
for ((attempt=0; attempt<200; attempt++)); do
  [[ -e "$runtime/app.json" ]] && break
  sleep 0.1
done
cp "$runtime/app.json" "$evidence/"
journalctl -u "$unit" --since "$run_started" --no-pager >"$evidence/journal.txt"
sesearch -A -s aiden_electron_role_probe_main_t -c file -p execute_no_trans >"$evidence/main-execute-no-trans.txt"
sesearch -A -s unconfined_t -t aiden_electron_role_probe_main_t -c process -p transition >"$evidence/outsider-transition.txt"
journalctl -u "$sender_unit" --since "$run_started" --no-pager >"$evidence/ipc-server-journal.txt"
systemctl show -p ExecMainStatus --value "$sender_unit" >"$evidence/ipc-server-status.txt"
cp /sys/fs/selinux/policy "$evidence/ipc.policy"
for role in main child; do
  sesearch -A -s "aiden_electron_role_probe_${role}_t" -t aiden_electron_role_probe_sender_t -c fd -p use "$evidence/ipc.policy" >"$evidence/ipc-$role-fd-use.txt"
  for channel in generic protected; do
    object=aiden_electron_role_probe_sender_t
    [[ "$channel" != protected ]] || object=aiden_electron_role_probe_protected_t
    for permission in read write; do
      sesearch -A -s "aiden_electron_role_probe_${role}_t" -t "$object" -c unix_stream_socket -p "$permission" "$evidence/ipc.policy" >"$evidence/ipc-$role-$channel-$permission.txt"
    done
  done
done
for ((attempt=0; attempt<30; attempt++)); do
  [[ "$(stat -c %i /var/log/audit/audit.log)" == "$audit_inode" ]]
  [[ "$(stat -c %s /var/log/audit/audit.log)" -ge "$audit_offset" ]]
  tail -c "+$((audit_offset + 1))" /var/log/audit/audit.log | grep 'type=AVC.*aiden_electron_role_probe_' >"$evidence/ipc-avc.txt" || true
  if node "$source_dir/verify.mjs" "$evidence" >"$evidence/verify.stdout" 2>"$evidence/verify.stderr"; then break; fi
  sleep 0.1
done
node "$source_dir/verify.mjs" "$evidence"
