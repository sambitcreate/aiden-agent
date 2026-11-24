import { randomInt } from "node:crypto";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT, BOT_COMPUTER_LINUX_IMAGE } from "./release.js";
import { BOT_COMPUTER_GUEST_USER, BOT_COMPUTER_HOST_KEY_ALIAS } from "./ssh.js";
import { BOT_COMPUTER_LINUX_SHELL_USER, BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

/**
 * Making the shared Debian 13 + XFCE Linux base computer after `lume create --os linux`.
 *
 * Cloud-init seeds Aiden's SSH public key and a random sudo password on first boot;
 * Aiden scans and pins the guest's SSH host key, then runs every provisioning step
 * over system ssh with the sudo password on stdin only (never in argv).
 */

export const BOT_COMPUTER_SSHD_DROP_IN = "/etc/ssh/sshd_config.d/100-aiden.conf";
export { BOT_COMPUTER_LINUX_SHELL_USER };
export const BOT_COMPUTER_LINUX_SHARED_MOUNT = "/mnt/aiden-shared";
/**
 * Lume exposes the Bot's `<botHome>/Computer` directory through Apple's
 * `VZMultipleDirectoryShare` under tag `com.apple.virtio-fs.automount`, which
 * appears inside the mount point as `<mount>/Computer`.
 */
export const BOT_COMPUTER_LINUX_VIRTIOFS_TAG = "com.apple.virtio-fs.automount";
export const BOT_COMPUTER_LINUX_SHARED_TARGET = `${BOT_COMPUTER_LINUX_SHARED_MOUNT}/Computer`;

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const SUDO = "/usr/bin/sudo -S -p ''";

/** A random 32-character guest password from an unambiguous alphabet. */
export function generateGuestPassword(length = 32): string {
  let password = "";
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return password;
}

/**
 * Guest-side X11 VNC (`X0tigervnc`) paths for Linux Bot computers.
 *
 * Lume runs with `--vnc disabled` so macOS's `_VZVNCServer` never binds a
 * wildcard `*:port` socket on the host (G22). Instead `X0tigervnc` listens only
 * on a mode-0600 Unix domain socket owned by `lume` (`-rfbport -1`, no TCP port
 * inside the guest, inaccessible to `aiden-bot`), protected by a per-run VncAuth
 * password file written over SSH stdin, and reached from the host exclusively
 * via a `127.0.0.1` SSH local Unix-socket tunnel.
 */
export const BOT_COMPUTER_LINUX_VNC_DIR = `/home/${BOT_COMPUTER_GUEST_USER}/.local/share/aiden`;
export const BOT_COMPUTER_LINUX_VNC_SOCKET = `${BOT_COMPUTER_LINUX_VNC_DIR}/vnc.sock`;
export const BOT_COMPUTER_LINUX_VNC_PASSWD = `${BOT_COMPUTER_LINUX_VNC_DIR}/vnc.passwd`;
export const BOT_COMPUTER_LINUX_VNC_SERVICE = "aiden-vnc.service";

/** `systemd --user` unit for `X0tigervnc` scraping `DISPLAY=:0` over a private Unix socket. */
export function linuxGuestVncUnit(): string {
  return [
    "[Unit]",
    "Description=Aiden Bot Computer X11 VNC Server",
    "After=graphical-session.target",
    "",
    "[Service]",
    "Type=simple",
    'Environment="DISPLAY=:0"',
    `Environment="XAUTHORITY=/home/${BOT_COMPUTER_GUEST_USER}/.Xauthority"`,
    `ExecStartPre=/bin/rm -f ${BOT_COMPUTER_LINUX_VNC_SOCKET}`,
    `ExecStart=/usr/bin/X0tigervnc -display :0 -rfbport -1 -rfbunixpath ${BOT_COMPUTER_LINUX_VNC_SOCKET} -rfbunixmode 0600 -SecurityTypes VncAuth -PasswordFile ${BOT_COMPUTER_LINUX_VNC_PASSWD} -AlwaysShared`,
    "Restart=on-failure",
    "RestartSec=1",
    "StartLimitIntervalSec=0",
    "",
    "[Install]",
    "WantedBy=default.target",
  ].join("\n");
}

/**
 * Guest command (run over SSH as `lume`, reading the per-run VNC password on stdin)
 * that atomically refreshes the `VncAuth` password file, waits for XFCE/Xorg,
 * starts `aiden-vnc.service`, and waits until the private Unix socket is ready.
 */
export function linuxGuestVncStartScript(): string {
  const dir = quoteRemoteArg(BOT_COMPUTER_LINUX_VNC_DIR);
  const passwd = quoteRemoteArg(BOT_COMPUTER_LINUX_VNC_PASSWD);
  const sock = quoteRemoteArg(BOT_COMPUTER_LINUX_VNC_SOCKET);
  const service = quoteRemoteArg(BOT_COMPUTER_LINUX_VNC_SERVICE);
  return [
    "IFS= read -r pw || exit 64",
    `umask 077 && mkdir -p ${dir} && chmod 700 ${dir}`,
    `printf '%s\\n' "$pw" | /usr/bin/tigervncpasswd -f > ${passwd}.tmp || exit 65`,
    `chmod 600 ${passwd}.tmp && mv -f ${passwd}.tmp ${passwd}`,
    'u="$(id -un)" && uid="$(id -u)"',
    'for i in $(seq 1 30); do if [ -s "$HOME/.Xauthority" ] && pgrep -u "$u" xfce4-session >/dev/null 2>&1; then break; fi; sleep 1; done',
    '[ -s "$HOME/.Xauthority" ] || exit 66',
    'export XDG_RUNTIME_DIR="/run/user/$uid"',
    'export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"',
    `systemctl --user daemon-reload && systemctl --user restart ${service} || exit 67`,
    `for i in $(seq 1 30); do if systemctl --user is-active --quiet ${service} && [ -S ${sock} ]; then exit 0; fi; sleep 0.5; done`,
    "exit 68",
  ].join("\n");
}

/** Desktop, browser, AT-SPI, VNC, and font packages installed from the pinned Debian snapshot. */
export const BOT_COMPUTER_LINUX_DESKTOP_PACKAGES: readonly string[] = Object.freeze([
  "openssh-server",
  "xfce4",
  "xfce4-terminal",
  "lightdm",
  "dbus-x11",
  "xserver-xorg",
  "tigervnc-scraping-server",
  "tigervnc-tools",
  "chromium",
  "firefox-esr",
  "at-spi2-core",
  "libatk-adaptor",
  "fonts-dejavu-core",
  "fonts-noto-core",
]);

export type LinuxProvisionStepId =
  | "capture_host_key"
  | "wait_cloud_init"
  | "harden_sshd"
  | "install_packages"
  | "configure_desktop"
  | "bot_shell_user"
  | "shared_folder"
  | "guest_driver"
  | "verify_desktop"
  | "shut_down";

export type LinuxProvisionChannel = "host_key" | "guest_ssh" | "lume";

export interface LinuxProvisionContext {
  /** Scan the guest's `ssh-ed25519` host key over Lume's private VM network. */
  scanHostKey(): Promise<string>;
  /** Pin the guest host key into Aiden's `known_hosts`. */
  writeKnownHost(hostPublicKey: string): Promise<void>;
  /** System ssh as `lume` with Aiden's key; `stdin` carries sudo password. */
  guestSsh(command: string, options: { stdin?: string; timeoutMs: number }): Promise<BotComputerGuestCommandResult>;
  /** `lume stop <base>` and wait for a clean shutdown. */
  stopBase(): Promise<void>;
  /** Aiden's `ssh-ed25519 …` public key (already seeded for `lume`; also installed for `aiden-bot`). */
  publicKey: string;
  /** The guest's rotated sudo password (already hashed into the cloud-init seed ISO and stored in secrets). */
  password: string;
  /** Optional Debian APT snapshot override (defaults to `BOT_COMPUTER_LINUX_APT_SNAPSHOT`). */
  snapshot?: { codename: string; archiveUrl: string; securityUrl: string };
  /** Optional Linux guest driver install hook (no macOS permissions step on Linux). */
  guestDriver?: {
    install(password: string): Promise<void>;
  };
  signal?: AbortSignal;
}

export interface LinuxProvisionStep {
  id: LinuxProvisionStepId;
  channel: LinuxProvisionChannel;
  run(context: LinuxProvisionContext): Promise<void>;
}

function checkLinuxStep(
  step: LinuxProvisionStepId,
  result: { exitCode: number | null; stderr: string; timedOut?: boolean },
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = result.timedOut ? "it timed out" : `exit ${String(result.exitCode)}`;
  throw new BotComputerError("start_failed", `Preparing the Linux base computer failed at "${step}" (${detail}).`);
}

function validateLinuxSnapshot(snapshot: { codename: string; archiveUrl: string; securityUrl: string }): {
  codename: string;
  archiveUrl: string;
  securityUrl: string;
} {
  if (!/^[a-z0-9-]+$/u.test(snapshot.codename)) {
    throw new BotComputerError("invalid", "The Debian codename is malformed.");
  }
  const cleanUrl = (raw: string): string => {
    if (raw.length === 0 || !/^[!-~]+$/u.test(raw)) {
      throw new BotComputerError("invalid", "APT snapshot URLs must not contain whitespace or control characters.");
    }
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new BotComputerError("invalid", "APT snapshot URLs must be plain https URLs.");
    }
    return parsed.href.replace(/\/+$/u, "");
  };
  return {
    codename: snapshot.codename,
    archiveUrl: cleanUrl(snapshot.archiveUrl),
    securityUrl: cleanUrl(snapshot.securityUrl),
  };
}

export const LINUX_BASE_PROVISION_STEPS: readonly LinuxProvisionStep[] = Object.freeze([
  {
    id: "capture_host_key",
    channel: "host_key",
    async run(context) {
      const hostKey = await context.scanHostKey();
      await context.writeKnownHost(hostKey);
    },
  },
  {
    id: "wait_cloud_init",
    channel: "guest_ssh",
    async run(context) {
      const keyLine = quoteRemoteArg(`${context.publicKey} ${BOT_COMPUTER_HOST_KEY_ALIAS}`);
      const script = [
        'if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || [ "$?" -eq 2 ]; fi',
        'umask 077 && mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys"',
        `(grep -qxF ${keyLine} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${keyLine} >> "$HOME/.ssh/authorized_keys")`,
        'chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys"',
      ].join(" && ");
      checkLinuxStep("wait_cloud_init", await context.guestSsh(script, { timeoutMs: 15 * 60_000 }));
    },
  },
  {
    id: "harden_sshd",
    channel: "guest_ssh",
    async run(context) {
      const script =
        `${SUDO} /bin/sh -c '` +
        'umask 022 && mkdir -p /etc/ssh/sshd_config.d && ' +
        'printf "%s\\n" ' +
        '"# Written by Aiden: Bot computers accept key logins only." ' +
        '"PasswordAuthentication no" ' +
        '"KbdInteractiveAuthentication no" ' +
        '"PermitRootLogin no" ' +
        '"PubkeyAuthentication yes" ' +
        '"AllowStreamLocalForwarding yes" ' +
        '"GatewayPorts no" ' +
        `> ${BOT_COMPUTER_SSHD_DROP_IN} && ` +
        "(systemctl reload ssh >/dev/null 2>&1 || systemctl reload sshd >/dev/null 2>&1 || true) && " +
        '/usr/sbin/sshd -T 2>/dev/null | grep -qx "passwordauthentication no"\'';
      checkLinuxStep("harden_sshd", await context.guestSsh(script, { stdin: `${context.password}\n`, timeoutMs: 60_000 }));
    },
  },
  {
    id: "install_packages",
    channel: "guest_ssh",
    async run(context) {
      const snapshot = validateLinuxSnapshot(
        context.snapshot ?? {
          codename: BOT_COMPUTER_LINUX_IMAGE.codename,
          archiveUrl: BOT_COMPUTER_LINUX_APT_SNAPSHOT.archiveUrl,
          securityUrl: BOT_COMPUTER_LINUX_APT_SNAPSHOT.securityUrl,
        },
      );
      const sourcesList = [
        `deb ${snapshot.archiveUrl} ${snapshot.codename} main contrib non-free-firmware`,
        `deb ${snapshot.securityUrl} ${snapshot.codename}-security main contrib non-free-firmware`,
      ].join("\n");
      const packages = BOT_COMPUTER_LINUX_DESKTOP_PACKAGES.join(" ");
      const script = [
        "rm -f /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/*.sources",
        `printf '%s\\n' ${quoteRemoteArg(sourcesList)} > /etc/apt/sources.list`,
        'printf \'%s\\n\' \'Acquire::Check-Valid-Until "false";\' > /etc/apt/apt.conf.d/99-aiden-snapshot',
        "export DEBIAN_FRONTEND=noninteractive",
        "apt-get update -o Acquire::Retries=3",
        `apt-get install -y --no-install-recommends ${packages}`,
        "apt-get clean",
      ].join(" && ");
      checkLinuxStep(
        "install_packages",
        await context.guestSsh(`${SUDO} /bin/sh -c ${quoteRemoteArg(script)}`, {
          stdin: `${context.password}\n`,
          timeoutMs: 20 * 60_000,
        }),
      );
    },
  },
  {
    id: "configure_desktop",
    channel: "guest_ssh",
    async run(context) {
      const autologin = [
        "[Seat:*]",
        `autologin-user=${BOT_COMPUTER_GUEST_USER}`,
        "autologin-user-timeout=0",
        "user-session=xfce",
      ].join("\n");
      const atspiEnv = [
        "GTK_MODULES=gail:atk-bridge",
        "GNOME_ACCESSIBILITY=1",
        "QT_ACCESSIBILITY=1",
        "ACCESSIBILITY_ENABLED=1",
      ].join("\n");
      const noAutoUpdates = [
        'APT::Periodic::Update-Package-Lists "0";',
        'APT::Periodic::Unattended-Upgrade "0";',
      ].join("\n");
      const sessionPrep = [
        "#!/bin/sh",
        "xset s off -dpms s noblank 2>/dev/null || true",
        "xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false 2>/dev/null || true",
        "xfconf-query -c xfce4-screensaver -p /lock/enabled -n -t bool -s false 2>/dev/null || true",
        "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/dpms-enabled -n -t bool -s false 2>/dev/null || true",
        "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/blank-on-ac -n -t int -s 0 2>/dev/null || true",
        "xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/lock-screen-suspend-hibernate -n -t bool -s false 2>/dev/null || true",
      ].join("\n");
      const desktopEntry = [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Aiden Session Prep",
        "Exec=/usr/local/bin/aiden-session-prep",
        "X-GNOME-Autostart-enabled=true",
      ].join("\n");
      // Cloud-init's default netplan pins DHCP to the base VM's MAC address,
      // which leaves cloned VMs (fresh MAC from `lume clone`) without an IP.
      // Replace it with a MAC-agnostic `en*` DHCP config so clones lease fast.
      const disableCloudNet = "network: {config: disabled}";
      const netplanDhcp = [
        "network:",
        "  version: 2",
        "  ethernets:",
        "    aiden-virtio:",
        "      match:",
        '        name: "en*"',
        "      dhcp4: true",
        "      dhcp-identifier: mac",
      ].join("\n");
      const vncUnitDir = `/home/${BOT_COMPUTER_GUEST_USER}/.config/systemd/user`;
      const vncUnitPath = `${vncUnitDir}/${BOT_COMPUTER_LINUX_VNC_SERVICE}`;
      const waitDesktop =
        `for i in $(seq 1 30); do ` +
        `if [ -s /home/${BOT_COMPUTER_GUEST_USER}/.Xauthority ] && pgrep -u ${BOT_COMPUTER_GUEST_USER} xfce4-session >/dev/null 2>&1; then break; fi; ` +
        `sleep 1; done`;
      const script = [
        "umask 022",
        "mkdir -p /etc/lightdm/lightdm.conf.d /etc/environment.d /etc/profile.d /etc/apt/apt.conf.d /etc/xdg/autostart /etc/cloud/cloud.cfg.d /etc/netplan /usr/local/bin",
        `printf '%s\\n' ${quoteRemoteArg(autologin)} > /etc/lightdm/lightdm.conf.d/50-aiden-autologin.conf`,
        `printf '%s\\n' ${quoteRemoteArg(atspiEnv)} > /etc/environment.d/50-aiden-atspi.conf`,
        `printf '%s\\n' ${quoteRemoteArg(atspiEnv.split("\n").map((line) => `export ${line}`).join("\n"))} > /etc/profile.d/aiden-atspi.sh`,
        `printf '%s\\n' ${quoteRemoteArg(noAutoUpdates)} > /etc/apt/apt.conf.d/20auto-upgrades`,
        `printf '%s\\n' ${quoteRemoteArg(sessionPrep)} > /usr/local/bin/aiden-session-prep`,
        "chmod 755 /usr/local/bin/aiden-session-prep",
        `printf '%s\\n' ${quoteRemoteArg(desktopEntry)} > /etc/xdg/autostart/aiden-no-lock.desktop`,
        `install -d -m 700 -o ${BOT_COMPUTER_GUEST_USER} -g ${BOT_COMPUTER_GUEST_USER} ${quoteRemoteArg(BOT_COMPUTER_LINUX_VNC_DIR)}`,
        `install -d -m 755 -o ${BOT_COMPUTER_GUEST_USER} -g ${BOT_COMPUTER_GUEST_USER} /home/${BOT_COMPUTER_GUEST_USER}/.config /home/${BOT_COMPUTER_GUEST_USER}/.config/systemd ${quoteRemoteArg(vncUnitDir)}`,
        `printf '%s\\n' ${quoteRemoteArg(linuxGuestVncUnit())} > ${quoteRemoteArg(vncUnitPath)}`,
        `chown ${BOT_COMPUTER_GUEST_USER}:${BOT_COMPUTER_GUEST_USER} ${quoteRemoteArg(vncUnitPath)} && chmod 644 ${quoteRemoteArg(vncUnitPath)}`,
        `loginctl enable-linger ${BOT_COMPUTER_GUEST_USER} >/dev/null 2>&1 || true`,
        `printf '%s\\n' ${quoteRemoteArg(disableCloudNet)} > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg`,
        "rm -f /etc/netplan/50-cloud-init.yaml",
        `printf '%s\\n' ${quoteRemoteArg(netplanDhcp)} > /etc/netplan/50-aiden-dhcp.yaml`,
        "chmod 600 /etc/netplan/50-aiden-dhcp.yaml",
        "if command -v netplan >/dev/null 2>&1; then netplan generate >/dev/null 2>&1 || true; fi",
        "systemctl set-default graphical.target >/dev/null 2>&1 || true",
        "systemctl enable lightdm >/dev/null 2>&1 || true",
        "systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true",
        "systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service >/dev/null 2>&1 || true",
        "systemctl restart lightdm >/dev/null 2>&1 || true",
        waitDesktop,
      ].join(" && ");
      checkLinuxStep(
        "configure_desktop",
        await context.guestSsh(`${SUDO} /bin/sh -c ${quoteRemoteArg(script)}`, {
          stdin: `${context.password}\n`,
          timeoutMs: 120_000,
        }),
      );
    },
  },
  {
    // Separate unprivileged user for Bot shell commands so human sign-in (F3)
    // can end every Bot shell process cleanly (`pkill -u aiden-bot`) without
    // touching the desktop session owned by `lume` (decision 4a). Narrowly
    // scoped sudoers rules let `lume` run `sudo -n -H -u aiden-bot` and stop
    // `aiden-bot` processes without granting passwordless root `ALL`.
    id: "bot_shell_user",
    channel: "guest_ssh",
    async run(context) {
      const user = BOT_COMPUTER_LINUX_SHELL_USER;
      const keyLine = quoteRemoteArg(`${context.publicKey} ${BOT_COMPUTER_HOST_KEY_ALIAS}`);
      const sudoers = [
        "# Written by Aiden: scoped Bot shell isolation (decision 4a).",
        `${BOT_COMPUTER_GUEST_USER} ALL=(${user}) NOPASSWD: ALL`,
        `${BOT_COMPUTER_GUEST_USER} ALL=(root) NOPASSWD: /usr/bin/pkill -KILL -u ${user}, /usr/bin/pkill -0 -u ${user}, /usr/bin/pgrep -u ${user}`,
      ].join("\n");
      const script = [
        `if ! id -u ${user} >/dev/null 2>&1; then useradd -m -s /bin/bash -U ${user}; fi`,
        `passwd -l ${user} >/dev/null 2>&1 || true`,
        `deluser ${user} sudo >/dev/null 2>&1 || true`,
        `install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh`,
        `touch /home/${user}/.ssh/authorized_keys`,
        `(grep -qxF ${keyLine} /home/${user}/.ssh/authorized_keys || printf '%s\\n' ${keyLine} >> /home/${user}/.ssh/authorized_keys)`,
        `chown ${user}:${user} /home/${user}/.ssh/authorized_keys`,
        `chmod 600 /home/${user}/.ssh/authorized_keys`,
        // `99-aiden-bot-shell` sorts after cloud-init's `90-cloud-init-users`
        // (`lume ALL=(ALL) ALL`), because in sudoers the last matching rule wins.
        `printf '%s\\n' ${quoteRemoteArg(sudoers)} > /etc/sudoers.d/99-aiden-bot-shell.tmp`,
        "chmod 440 /etc/sudoers.d/99-aiden-bot-shell.tmp",
        "if command -v visudo >/dev/null 2>&1; then visudo -cf /etc/sudoers.d/99-aiden-bot-shell.tmp >/dev/null; fi",
        "mv -f /etc/sudoers.d/99-aiden-bot-shell.tmp /etc/sudoers.d/99-aiden-bot-shell",
        "rm -f /etc/sudoers.d/90-aiden-bot-shell",
      ].join(" && ");
      checkLinuxStep(
        "bot_shell_user",
        await context.guestSsh(`${SUDO} /bin/sh -c ${quoteRemoteArg(script)}`, {
          stdin: `${context.password}\n`,
          timeoutMs: 60_000,
        }),
      );
    },
  },
  {
    // `<botHome>/Computer` is shared read-write over virtiofs under Apple's
    // `com.apple.virtio-fs.automount` share, appearing at `/mnt/aiden-shared/Computer`;
    // expose `~/Shared` directly to that directory for both `lume` and `aiden-bot`.
    id: "shared_folder",
    channel: "guest_ssh",
    async run(context) {
      const fstabLine = `${BOT_COMPUTER_LINUX_VIRTIOFS_TAG} ${BOT_COMPUTER_LINUX_SHARED_MOUNT} virtiofs rw,nofail,x-systemd.automount 0 0`;
      const script = [
        `mkdir -p ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_MOUNT)}`,
        `(grep -qxF ${quoteRemoteArg(fstabLine)} /etc/fstab || printf '%s\\n' ${quoteRemoteArg(fstabLine)} >> /etc/fstab)`,
        `mount ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_MOUNT)} >/dev/null 2>&1 || true`,
        `for u in ${BOT_COMPUTER_GUEST_USER} ${BOT_COMPUTER_LINUX_SHELL_USER}; do s="/home/$u/Shared"; if [ -L "$s" ] || [ ! -e "$s" ]; then ln -sfn ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_TARGET)} "$s" && chown -h "$u:$u" "$s"; else exit 65; fi; done`,
      ].join(" && ");
      checkLinuxStep(
        "shared_folder",
        await context.guestSsh(`${SUDO} /bin/sh -c ${quoteRemoteArg(script)}`, {
          stdin: `${context.password}\n`,
          timeoutMs: 60_000,
        }),
      );
    },
  },
  {
    id: "verify_desktop",
    channel: "guest_ssh",
    async run(context) {
      const script = [
        "command -v xfce4-session >/dev/null",
        "command -v X0tigervnc >/dev/null",
        "command -v tigervncpasswd >/dev/null",
        "command -v chromium >/dev/null",
        "command -v firefox-esr >/dev/null",
        `id -u ${BOT_COMPUTER_LINUX_SHELL_USER} >/dev/null`,
        '/usr/sbin/sshd -T 2>/dev/null | grep -qx "passwordauthentication no"',
        "systemctl is-active --quiet lightdm || systemctl start lightdm >/dev/null 2>&1 || true",
      ].join(" && ");
      checkLinuxStep(
        "verify_desktop",
        await context.guestSsh(`${SUDO} /bin/sh -c ${quoteRemoteArg(script)}`, {
          stdin: `${context.password}\n`,
          timeoutMs: 60_000,
        }),
      );
    },
  },
  {
    id: "guest_driver",
    channel: "guest_ssh",
    async run(context) {
      await context.guestDriver?.install(context.password);
    },
  },
  {
    // Flush ext4 delayed-allocation dirty pages before `lume stop`, which ends
    // a Linux VM in ~1s and otherwise risks zero-filling newly written files.
    id: "shut_down",
    channel: "lume",
    async run(context) {
      checkLinuxStep(
        "shut_down",
        await context.guestSsh(`${SUDO} /bin/sh -c 'sync && sync'`, {
          stdin: `${context.password}\n`,
          timeoutMs: 30_000,
        }),
      );
      await context.stopBase();
    },
  },
]);

/** Run every Linux base provisioning step in order. Stops at the first failure or cancellation. */
export async function provisionLinuxBase(
  context: LinuxProvisionContext,
  options: { onStep?(step: LinuxProvisionStepId): void } = {},
): Promise<void> {
  for (const step of LINUX_BASE_PROVISION_STEPS) {
    if (context.signal?.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
    options.onStep?.(step.id);
    await step.run(context);
  }
}

export interface LinuxBaseBuildDependencies {
  /** Remove a leftover VM of the same name (not found is fine). */
  deleteVm(): Promise<void>;
  /** Create the Linux VM, place & grow its 24 GB sparse disk, and write the CIDATA seed ISO. */
  create(): Promise<void>;
  /** Start the new base with `--mount <seedIso>` and wait for its IP and SSH. */
  start(): Promise<{ ip: string }>;
  provisionContext(ip: string): LinuxProvisionContext;
  /** Best-effort stop after a failure. */
  stop(): Promise<void>;
  /** Delete the temporary CIDATA seed ISO (on both success and failure). */
  removeSeedIso(): Promise<void>;
  /** Delete the verified Debian disk image; only after the base is complete. */
  removeImage(): Promise<void>;
  onStep?(step: "create" | "provision", detail?: LinuxProvisionStepId): void;
  signal?: AbortSignal;
}

/**
 * Create, start, provision and shut down a Linux base VM. On failure the
 * half-made VM and temporary seed ISO are removed while the verified Debian
 * disk image is kept, so a retry needs no download.
 */
export async function buildLinuxBaseVm(deps: LinuxBaseBuildDependencies): Promise<void> {
  const cancelled = () => {
    if (deps.signal?.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
  };
  try {
    cancelled();
    deps.onStep?.("create");
    await deps.deleteVm();
    await deps.create();
    cancelled();
    deps.onStep?.("provision");
    const { ip } = await deps.start();
    cancelled();
    await provisionLinuxBase(deps.provisionContext(ip), { onStep: (step) => deps.onStep?.("provision", step) });
  } catch (error) {
    await deps.stop().catch(() => undefined);
    await deps.deleteVm().catch(() => undefined);
    await deps.removeSeedIso().catch(() => undefined);
    throw error;
  }
  await deps.removeSeedIso().catch(() => undefined);
  await deps.removeImage();
}
