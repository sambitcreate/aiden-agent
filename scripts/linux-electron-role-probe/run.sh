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
[[ ! -e "$installation" && ! -e "$runtime" && ! -e "/etc/systemd/system/$unit" ]]
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
source "$source_dir/cleanup.sh"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
uname -a >"$evidence/kernel.txt"
getenforce >"$evidence/enforcement-before.txt"
cat /sys/fs/selinux/policy_capabilities/memfd_class >"$evidence/memfd-class.txt"
semodule -l >"$evidence/modules-before.txt"
cp -- "$source_dir/aiden_electron_role_probe.te" "$work/"
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
restorecon -RF "$installation"
chcon -t aiden_electron_role_probe_exec_t "$installation/electron" "$installation/chrome_crashpad_handler"
install -d -o fedora -g fedora -m 700 "$runtime"
sha256sum "$installation/electron" "$installation/main.cjs" "$installation/worker.cjs" >"$evidence/payload.sha256"
ls -lZ "$installation/electron" "$installation/main.cjs" >"$evidence/payload-metadata.txt"
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
systemctl start "$unit"
for ((attempt=0; attempt<200; attempt++)); do
  [[ -e "$runtime/ready" || -e "$runtime/app.json" ]] && break
  sleep 0.1
done
journalctl -u "$unit" --no-pager -n 100 >"$evidence/journal.txt"
ausearch -m AVC,SELINUX_ERR -ts recent >"$evidence/audit.txt" || true
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
journalctl -u "$unit" --no-pager -n 100 >"$evidence/journal.txt"
sesearch -A -s aiden_electron_role_probe_main_t -c file -p execute_no_trans >"$evidence/main-execute-no-trans.txt"
sesearch -A -s unconfined_t -t aiden_electron_role_probe_main_t -c process -p transition >"$evidence/outsider-transition.txt"
node "$source_dir/verify.mjs" "$evidence"
