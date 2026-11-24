import { randomInt } from "node:crypto";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { BOT_COMPUTER_LINUX_APT_SNAPSHOT, BOT_COMPUTER_LINUX_IMAGE } from "./release.js";
import { BOT_COMPUTER_GUEST_USER, BOT_COMPUTER_HOST_KEY_ALIAS } from "./ssh.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

/**
 * Making the shared base after `lume create --unattended tahoe` (plan §8.3).
 *
 * The preset leaves user `lume` with password `lume`, SSH on and autologin.
 * The first two steps run over `lume ssh`, which logs in with that default
 * password; the rest run over system ssh with Aiden's key and the pinned host
 * key, with every secret on stdin rather than in argv. Script contents are
 * assumed until owner-Mac acceptance (see docs/bot-computers.md).
 */

export type ProvisionStepId =
  | "install_key"
  | "capture_host_key"
  | "rotate_password"
  | "harden_sshd"
  | "disable_updates"
  | "suppress_prompts"
  | "shared_folder"
  | "guest_driver"
  | "permissions"
  | "shut_down";

export type ProvisionChannel = "lume_ssh" | "guest_ssh" | "lume";

export interface ProvisionContext {
  /** `lume ssh <base> <command>` with the preset's default password. */
  lumeSsh(command: string, timeoutSeconds: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  /** System ssh with Aiden's key; `stdin` carries secrets. */
  guestSsh(command: string, options: { stdin?: string; timeoutMs: number }): Promise<BotComputerGuestCommandResult>;
  /** `lume stop <base>` and wait for it to be stopped. */
  stopBase(): Promise<void>;
  /** Aiden's `ssh-ed25519 …` public key. */
  publicKey: string;
  writeKnownHost(hostPublicKey: string): Promise<void>;
  newPassword(): string;
  /** Stored before the guest's password changes, so it is never lost. */
  storePassword(password: string): Promise<void>;
  /**
   * The guest driver lane (plan §8.6): install Aiden's pinned cua-driver, then
   * walk the person through its grants in the live view. Neither ever fails
   * the base: without them it is made for the VNC lane only.
   */
  guestDriver?: {
    install(password: string): Promise<void>;
    grant(password: string): Promise<void>;
  };
  signal?: AbortSignal;
}

interface ProvisionState {
  /** The guest password sudo needs right now. */
  password: string;
}

export interface ProvisionStep {
  id: ProvisionStepId;
  channel: ProvisionChannel;
  run(context: ProvisionContext, state: ProvisionState): Promise<void>;
}

export const BOT_COMPUTER_DEFAULT_GUEST_PASSWORD = "lume";
export const BOT_COMPUTER_SHARED_MOUNT = "/Volumes/My Shared Files";
export const BOT_COMPUTER_SSHD_DROP_IN = "/etc/ssh/sshd_config.d/100-aiden.conf";

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** A random 32-character guest password from an unambiguous alphabet. */
export function generateGuestPassword(length = 32): string {
  let password = "";
  for (let index = 0; index < length; index += 1) password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return password;
}

/**
 * `/etc/kcpassword` for autologin: the password plus at least one NUL, padded
 * to a multiple of 12 and XORed with Apple's fixed key (as Lume's own offline
 * patcher writes it). Without it the rotated password would break autologin
 * and reset the login keychain on every boot.
 */
export function kcpasswordBytes(password: string): Buffer {
  const key = [0x7d, 0x89, 0x52, 0x23, 0xd2, 0xbc, 0xdd, 0xea, 0xa3, 0xb9, 0x1f];
  const plain = [...Buffer.from(password, "utf8")];
  plain.push(...new Array<number>(12 - (plain.length % 12)).fill(0));
  return Buffer.from(plain.map((byte, index) => byte ^ (key[index % key.length] ?? 0)));
}

function check(
  step: ProvisionStepId,
  result: { exitCode: number | null; stderr: string; timedOut?: boolean },
): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const detail = result.timedOut ? "it timed out" : `exit ${String(result.exitCode)}`;
  throw new BotComputerError("start_failed", `Preparing the base computer failed at "${step}" (${detail}).`);
}

const SUDO = "/usr/bin/sudo -S -p ''";

export const BASE_PROVISION_STEPS: readonly ProvisionStep[] = Object.freeze([
  {
    id: "install_key",
    channel: "lume_ssh",
    async run(context) {
      const line = quoteRemoteArg(`${context.publicKey} ${BOT_COMPUTER_HOST_KEY_ALIAS}`);
      const script = [
        'umask 077 && mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys"',
        `(grep -qxF ${line} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${line} >> "$HOME/.ssh/authorized_keys")`,
        'chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys"',
      ].join(" && ");
      check("install_key", await context.lumeSsh(script, 60));
    },
  },
  {
    // Captured over the preset's password session on Lume's private NAT,
    // before system ssh, which refuses any host key it doesn't already know.
    id: "capture_host_key",
    channel: "lume_ssh",
    async run(context) {
      const result = await context.lumeSsh("cat /etc/ssh/ssh_host_ed25519_key.pub", 60);
      check("capture_host_key", result);
      const line = result.stdout.split(/\r?\n/u).find((entry) => entry.startsWith("ssh-ed25519 "));
      if (!line) throw new BotComputerError("start_failed", "The base computer did not report its SSH host key.");
      await context.writeKnownHost(line);
    },
  },
  {
    id: "rotate_password",
    channel: "guest_ssh",
    async run(context, state) {
      const next = context.newPassword();
      await context.storePassword(next);
      const script = [
        "IFS= read -r old && IFS= read -r new && IFS= read -r kc || exit 64",
        '/usr/bin/dscl . -passwd "/Users/$(/usr/bin/id -un)" "$old" "$new" || exit 65',
        '/usr/bin/security set-keychain-password -o "$old" -p "$new" "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || true',
        `printf '%s\\n%s\\n' "$new" "$kc" | ${SUDO} /bin/sh -c 'IFS= read -r kc && umask 077 && printf "%s" "$kc" | /usr/bin/base64 -D -o /etc/kcpassword.aiden && /usr/sbin/chown root:wheel /etc/kcpassword.aiden && /bin/chmod 600 /etc/kcpassword.aiden && /bin/mv -f /etc/kcpassword.aiden /etc/kcpassword' || exit 66`,
      ].join("\n");
      const stdin = `${state.password}\n${next}\n${kcpasswordBytes(next).toString("base64")}\n`;
      check("rotate_password", await context.guestSsh(script, { stdin, timeoutMs: 60_000 }));
      state.password = next;
    },
  },
  {
    // macOS starts sshd per connection, so the next connection reads this
    // file; `sshd -T` proves the effective setting before setup continues.
    id: "harden_sshd",
    channel: "guest_ssh",
    async run(context, state) {
      const script = `${SUDO} /bin/sh -c 'umask 022 && printf "%s\\n" "# Written by Aiden: Bot computers accept key logins only." "PasswordAuthentication no" "KbdInteractiveAuthentication no" > ${BOT_COMPUTER_SSHD_DROP_IN} && /usr/sbin/sshd -T 2>/dev/null | /usr/bin/grep -qx "passwordauthentication no"'`;
      check("harden_sshd", await context.guestSsh(script, { stdin: `${state.password}\n`, timeoutMs: 60_000 }));
    },
  },
  {
    // Updates come with a new pinned base, never inside a Bot's computer.
    id: "disable_updates",
    channel: "guest_ssh",
    async run(context, state) {
      const writes = [
        "AutomaticCheckEnabled",
        "AutomaticDownload",
        "AutomaticallyInstallMacOSUpdates",
        "ConfigDataInstall",
        "CriticalUpdateInstall",
      ]
        .map((key) => `/usr/bin/defaults write /Library/Preferences/com.apple.SoftwareUpdate ${key} -bool false`)
        .join(" && ");
      const script = `${SUDO} /bin/sh -c '${writes} && /usr/bin/defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false && { /usr/sbin/softwareupdate --schedule off >/dev/null 2>&1 || true; }'`;
      check("disable_updates", await context.guestSsh(script, { stdin: `${state.password}\n`, timeoutMs: 120_000 }));
    },
  },
  {
    id: "suppress_prompts",
    channel: "guest_ssh",
    async run(context, state) {
      const seen = [
        "DidSeeCloudSetup",
        "DidSeePrivacy",
        "DidSeeSiriSetup",
        "DidSeeScreenTime",
        "DidSeeAppearanceSetup",
        "DidSeeTouchIDSetup",
        "DidSeeApplePaySetup",
        "DidSeeActivationLock",
        "DidSeeAccessibility",
        "DidSeeTrueTonePrivacy",
        "DidSeeIntelligence",
        "DidSeeTermsOfAddress",
        "SkipFirstLoginOptimization",
      ];
      const history = '"/Library/Application Support/CrashReporter/DiagnosticMessagesHistory.plist"';
      const script = [
        "IFS= read -r pw || exit 64",
        `for k in ${seen.join(" ")}; do /usr/bin/defaults write com.apple.SetupAssistant "$k" -bool true || exit 65; done`,
        '/usr/bin/defaults write com.apple.SetupAssistant LastSeenCloudProductVersion "$(/usr/bin/sw_vers -productVersion)" || exit 65',
        '/usr/bin/defaults write com.apple.SetupAssistant LastSeenBuddyBuildVersion "$(/usr/bin/sw_vers -buildVersion)" || exit 65',
        '/usr/bin/defaults write com.apple.assistant.support "Assistant Enabled" -bool false || exit 65',
        "/usr/bin/defaults write com.apple.CrashReporter DialogType none || exit 65",
        `printf '%s\\n' "$pw" | ${SUDO} /bin/sh -c '/usr/bin/defaults write ${history} AutoSubmit -bool false && /usr/bin/defaults write ${history} ThirdPartyDataSubmit -bool false' || exit 66`,
      ].join("\n");
      check("suppress_prompts", await context.guestSsh(script, { stdin: `${state.password}\n`, timeoutMs: 60_000 }));
    },
  },
  {
    // `<botHome>/Computer` is shared read-write and macOS mounts it here.
    id: "shared_folder",
    channel: "guest_ssh",
    async run(context) {
      const script = `s="$HOME/Shared"; if [ -L "$s" ] || [ ! -e "$s" ]; then /bin/ln -sfn ${quoteRemoteArg(BOT_COMPUTER_SHARED_MOUNT)} "$s"; else exit 65; fi`;
      check("shared_folder", await context.guestSsh(script, { timeoutMs: 30_000 }));
    },
  },
  {
    id: "guest_driver",
    channel: "guest_ssh",
    async run(context, state) {
      await context.guestDriver?.install(state.password);
    },
  },
  {
    // "Allow Accessibility and Screen Recording for cua-driver": the person
    // grants them in the base's live view, or skips; clones inherit them.
    id: "permissions",
    channel: "guest_ssh",
    async run(context, state) {
      await context.guestDriver?.grant(state.password);
    },
  },
  {
    id: "shut_down",
    channel: "lume",
    async run(context) {
      await context.stopBase();
    },
  },
]);

/** Run every step in order. Stops at the first failure or cancellation. */
export async function provisionBase(
  context: ProvisionContext,
  options: { onStep?(step: ProvisionStepId): void } = {},
): Promise<void> {
  const state: ProvisionState = { password: BOT_COMPUTER_DEFAULT_GUEST_PASSWORD };
  for (const step of BASE_PROVISION_STEPS) {
    if (context.signal?.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
    options.onStep?.(step.id);
    await step.run(context, state);
  }
}

export interface BaseBuildDependencies {
  /** Remove a leftover VM of the same name (not found is fine). */
  deleteVm(): Promise<void>;
  /** `lume create <base> --ipsw … --unattended tahoe`. */
  create(): Promise<void>;
  /** Start the new base and wait for its IP and SSH. */
  start(): Promise<{ ip: string }>;
  provisionContext(ip: string): ProvisionContext;
  /** Best-effort stop after a failure. */
  stop(): Promise<void>;
  /** Delete the verified restore image; only after the base is complete. */
  removeIpsw(): Promise<void>;
  onStep?(step: "create" | "provision", detail?: ProvisionStepId): void;
  signal?: AbortSignal;
}

/**
 * Create, start, provision and shut down a base VM. On failure the half-made
 * VM is removed and the restore image is kept, so a retry needs no download.
 */
export async function buildBaseVm(deps: BaseBuildDependencies): Promise<void> {
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
    await provisionBase(deps.provisionContext(ip), { onStep: (step) => deps.onStep?.("provision", step) });
  } catch (error) {
    await deps.stop().catch(() => undefined);
    await deps.deleteVm().catch(() => undefined);
    throw error;
  }
  await deps.removeIpsw();
}

// ── Linux base provisioning (PR 5 / F2, gated behind AIDEN_BOT_COMPUTERS_LINUX) ──

/** Separate unprivileged Linux user for Bot `computer_shell` isolation (decision 4a). */
export const BOT_COMPUTER_LINUX_SHELL_USER = "aiden-bot";
export const BOT_COMPUTER_LINUX_SHARED_MOUNT = "/mnt/aiden-shared";
export const BOT_COMPUTER_LINUX_VIRTIOFS_TAG = "automount";

/** Desktop, browser, AT-SPI, and font packages installed from the pinned Debian snapshot. */
export const BOT_COMPUTER_LINUX_DESKTOP_PACKAGES: readonly string[] = Object.freeze([
  "openssh-server",
  "xfce4",
  "xfce4-terminal",
  "lightdm",
  "dbus-x11",
  "xserver-xorg",
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
      const script = [
        "umask 022",
        "mkdir -p /etc/lightdm/lightdm.conf.d /etc/environment.d /etc/profile.d /etc/apt/apt.conf.d /etc/xdg/autostart /usr/local/bin",
        `printf '%s\\n' ${quoteRemoteArg(autologin)} > /etc/lightdm/lightdm.conf.d/50-aiden-autologin.conf`,
        `printf '%s\\n' ${quoteRemoteArg(atspiEnv)} > /etc/environment.d/50-aiden-atspi.conf`,
        `printf '%s\\n' ${quoteRemoteArg(atspiEnv.split("\n").map((line) => `export ${line}`).join("\n"))} > /etc/profile.d/aiden-atspi.sh`,
        `printf '%s\\n' ${quoteRemoteArg(noAutoUpdates)} > /etc/apt/apt.conf.d/20auto-upgrades`,
        `printf '%s\\n' ${quoteRemoteArg(sessionPrep)} > /usr/local/bin/aiden-session-prep`,
        "chmod 755 /usr/local/bin/aiden-session-prep",
        `printf '%s\\n' ${quoteRemoteArg(desktopEntry)} > /etc/xdg/autostart/aiden-no-lock.desktop`,
        "systemctl set-default graphical.target >/dev/null 2>&1 || true",
        "systemctl enable lightdm >/dev/null 2>&1 || true",
        "systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true",
        "systemctl disable --now apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service >/dev/null 2>&1 || true",
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
        `printf '%s\\n' ${quoteRemoteArg(sudoers)} > /etc/sudoers.d/90-aiden-bot-shell.tmp`,
        "chmod 440 /etc/sudoers.d/90-aiden-bot-shell.tmp",
        "if command -v visudo >/dev/null 2>&1; then visudo -cf /etc/sudoers.d/90-aiden-bot-shell.tmp >/dev/null; fi",
        "mv -f /etc/sudoers.d/90-aiden-bot-shell.tmp /etc/sudoers.d/90-aiden-bot-shell",
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
    // `<botHome>/Computer` is shared read-write over virtiofs; mount it at
    // `/mnt/aiden-shared` and expose `~/Shared` for both `lume` and `aiden-bot`.
    id: "shared_folder",
    channel: "guest_ssh",
    async run(context) {
      const fstabLine = `${BOT_COMPUTER_LINUX_VIRTIOFS_TAG} ${BOT_COMPUTER_LINUX_SHARED_MOUNT} virtiofs rw,nofail,x-systemd.automount 0 0`;
      const script = [
        `mkdir -p ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_MOUNT)}`,
        `(grep -qxF ${quoteRemoteArg(fstabLine)} /etc/fstab || printf '%s\\n' ${quoteRemoteArg(fstabLine)} >> /etc/fstab)`,
        `mount ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_MOUNT)} >/dev/null 2>&1 || true`,
        `for u in ${BOT_COMPUTER_GUEST_USER} ${BOT_COMPUTER_LINUX_SHELL_USER}; do s="/home/$u/Shared"; if [ -L "$s" ] || [ ! -e "$s" ]; then ln -sfn ${quoteRemoteArg(BOT_COMPUTER_LINUX_SHARED_MOUNT)} "$s" && chown -h "$u:$u" "$s"; else exit 65; fi; done`,
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
    id: "guest_driver",
    channel: "guest_ssh",
    async run(context) {
      await context.guestDriver?.install(context.password);
    },
  },
  {
    id: "verify_desktop",
    channel: "guest_ssh",
    async run(context) {
      const script = [
        "command -v xfce4-session >/dev/null",
        "command -v chromium >/dev/null",
        "command -v firefox-esr >/dev/null",
        `id -u ${BOT_COMPUTER_LINUX_SHELL_USER} >/dev/null`,
        '/usr/sbin/sshd -T 2>/dev/null | grep -qx "passwordauthentication no"',
        "systemctl start lightdm >/dev/null 2>&1 || true",
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
    id: "shut_down",
    channel: "lume",
    async run(context) {
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
