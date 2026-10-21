import { randomInt } from "node:crypto";
import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { BOT_COMPUTER_HOST_KEY_ALIAS } from "./ssh.js";
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
