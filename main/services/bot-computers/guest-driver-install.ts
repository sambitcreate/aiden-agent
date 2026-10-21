// The guest driver lane's install (plan §8.6, decision 7): Aiden's own pinned
// `cua-driver`, copied from its vendored helper bundle into the base computer
// during Set up or Update base, and run there as a LaunchAgent in the
// logged-in session so it can reach the guest's window server.
//
// - Only the upstream-signed `cua-driver` executable is copied. Aiden's broker
//   stays on the Mac: it authenticates the Aiden process it runs under.
// - The guest checks the copy itself before it is put in place: its SHA-256
//   against Aiden's compiled pin, and its signature against the pinned Cua
//   identity and Team ID. Nothing is downloaded in the guest, and no PATH
//   lookup ever finds a driver.
// - The agent keeps the daemon alive only while an "enabled" file exists, so
//   computer sign-in can stop it without the guest password (see
//   `guestDriverSuspendScript`).
// - The CLI shape (`serve --socket`, `mcp --embedded --socket`) is cua-driver
//   0.36.0's documented one; the scripts are unproven until owner-Mac
//   acceptance (docs/bot-computers.md, "Guest driver lane").

import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { buildCuaDriverEnvironment } from "../computer-use/contract.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

export const GUEST_DRIVER_LABEL = "com.aiden.bot-computer.cua-driver";
/** Under the guest user's home. None of these contain a quote or a backslash. */
export const GUEST_DRIVER_SUPPORT_DIR = "Library/Application Support/Aiden";
export const GUEST_DRIVER_BINARY = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver/cua-driver`;
export const GUEST_DRIVER_SOCKET = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.sock`;
export const GUEST_DRIVER_PID_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.pid`;
export const GUEST_DRIVER_ENABLED_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.enabled`;
export const GUEST_DRIVER_PLIST = `Library/LaunchAgents/${GUEST_DRIVER_LABEL}.plist`;
export const GUEST_DRIVER_LOG = "Library/Logs/Aiden/cua-driver.log";
/** The copy lands here first: home-relative, with no space, and replaced atomically. */
export const GUEST_DRIVER_STAGING = ".aiden-cua-driver.partial";

/** The guest user's home and uid, read from the guest before anything is written. */
export interface GuestDriverLocation {
  home: string;
  uid: number;
}

export interface GuestDriverPin {
  version: string;
  binarySha256: string;
  signingRequirement: string;
}

export interface GuestDriverInstallContext {
  /** System ssh with Aiden's key; `stdin` carries the guest password, `stdinFile` the copy. */
  guestSsh(
    command: string,
    options: { stdin?: string; stdinFile?: string; timeoutMs: number },
  ): Promise<BotComputerGuestCommandResult>;
  /** The vendored driver on this Mac, already verified against the pin. */
  driverPath: string;
  pin: GuestDriverPin;
  /** The guest password sudo needs to load the agent into the logged-in session. */
  password: string;
  signal?: AbortSignal;
}

export type GuestDriverInstallStep = "locate" | "copy" | "verify" | "agent" | "wait_for_socket";

function absolute(location: GuestDriverLocation, relative: string): string {
  return `${location.home}/${relative}`;
}

/** The environment the daemon runs with: no telemetry, no update checks, no scripts. */
export function guestDriverEnvironment(): Record<string, string> {
  const env = buildCuaDriverEnvironment({});
  // That label names Aiden's broker for the Mac's embedded driver; the guest
  // driver owns its own permissions.
  delete env.CUA_DRIVER_HOST_BUNDLE_ID;
  env.CUA_DRIVER_RS_PERMISSIONS_GATE = "0";
  return env;
}

/** `cua-driver serve` as the agent runs it. */
export function guestDriverDaemonArguments(location: GuestDriverLocation): string[] {
  return [
    absolute(location, GUEST_DRIVER_BINARY),
    "serve",
    "--socket",
    absolute(location, GUEST_DRIVER_SOCKET),
    "--pid-file",
    absolute(location, GUEST_DRIVER_PID_FILE),
    "--no-overlay",
    "--no-permissions-gate",
  ];
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

/**
 * The LaunchAgent: loaded at every login of the guest user (the base logs in
 * on its own), only in the GUI session, kept alive while the enabled file
 * exists. Every path is absolute.
 */
export function guestDriverLaunchAgentPlist(location: GuestDriverLocation): string {
  const strings = (values: readonly string[]) => values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(guestDriverEnvironment())
    .map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
    .join("\n");
  const log = xml(absolute(location, GUEST_DRIVER_LOG));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${GUEST_DRIVER_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    strings(guestDriverDaemonArguments(location)),
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    `\t\t<key>HOME</key>\n\t\t<string>${xml(location.home)}</string>`,
    env,
    "\t</dict>",
    "\t<key>WorkingDirectory</key>",
    `\t<string>${xml(location.home)}</string>`,
    "\t<key>LimitLoadToSessionType</key>",
    "\t<string>Aqua</string>",
    "\t<key>ProcessType</key>",
    "\t<string>Interactive</string>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>PathState</key>",
    "\t\t<dict>",
    `\t\t\t<key>${xml(absolute(location, GUEST_DRIVER_ENABLED_FILE))}</key>`,
    "\t\t\t<true/>",
    "\t\t</dict>",
    "\t</dict>",
    "\t<key>ThrottleInterval</key>",
    "\t<integer>5</integer>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${log}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${log}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const SUDO = "/usr/bin/sudo -S -p ''";
const LOCATE_MARKER = "aiden-guest-driver";

/** Make the folders and report the home and uid, refusing a home outside /Users. */
export function guestDriverLocateScript(): string {
  return [
    'h="$HOME"',
    'case "$h" in /Users/*) ;; *) exit 65 ;; esac',
    `umask 022 && /bin/mkdir -p "$h/${GUEST_DRIVER_SUPPORT_DIR}/cua-driver" "$h/Library/LaunchAgents" "$h/Library/Logs/Aiden" || exit 66`,
    `printf '${LOCATE_MARKER} %s %s\\n' "$(/usr/bin/id -u)" "$h"`,
  ].join("\n");
}

export function parseGuestDriverLocation(stdout: string): GuestDriverLocation {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(`${LOCATE_MARKER} `));
  const match = line ? new RegExp(`^${LOCATE_MARKER} ([0-9]{1,7}) (/Users/[A-Za-z0-9._-]{1,64})$`, "u").exec(line) : null;
  if (!match) throw new BotComputerError("start_failed", "The base computer reported an unexpected user home.");
  return { uid: Number(match[1]), home: match[2] };
}

/** Receive the copy on stdin. */
export function guestDriverCopyScript(): string {
  return `umask 077 && /bin/cat > "$HOME/${GUEST_DRIVER_STAGING}"`;
}

/**
 * Check the copy in the guest (hash, then signature) and only then move it
 * into place. A copy that fails either check is deleted.
 */
export function guestDriverVerifyScript(pin: GuestDriverPin): string {
  if (!/^[0-9a-f]{64}$/u.test(pin.binarySha256)) throw new BotComputerError("invalid", "The driver pin is malformed.");
  return [
    `f="$HOME/${GUEST_DRIVER_STAGING}"`,
    `d="$HOME/${GUEST_DRIVER_BINARY}"`,
    "sum=$(/usr/bin/shasum -a 256 \"$f\" | /usr/bin/awk '{print $1}')",
    `[ "$sum" = ${quoteRemoteArg(pin.binarySha256)} ] || { /bin/rm -f "$f"; exit 70; }`,
    `/usr/bin/codesign --verify --strict -R=${quoteRemoteArg(pin.signingRequirement)} "$f" >/dev/null 2>&1 || { /bin/rm -f "$f"; exit 71; }`,
    '/bin/chmod 755 "$f" && /bin/mv -f "$f" "$d" || exit 72',
  ].join("\n");
}

/**
 * Write the agent (plist on stdin after the password line), lint it, and load
 * it into the logged-in session. Loading another user's GUI domain from an SSH
 * session needs root, hence sudo with the password on stdin.
 */
export function guestDriverAgentScript(location: GuestDriverLocation): string {
  const plist = absolute(location, GUEST_DRIVER_PLIST);
  return [
    "IFS= read -r pw || exit 64",
    `p=${quoteRemoteArg(plist)}`,
    'umask 022 && /bin/cat > "$p.partial" || exit 73',
    '/usr/bin/plutil -lint -s "$p.partial" || { /bin/rm -f "$p.partial"; exit 74; }',
    '/bin/mv -f "$p.partial" "$p" || exit 74',
    `/usr/bin/touch ${quoteRemoteArg(absolute(location, GUEST_DRIVER_ENABLED_FILE))} || exit 74`,
    `printf '%s\\n' "$pw" | ${SUDO} /bin/launchctl bootout gui/${location.uid}/${GUEST_DRIVER_LABEL} >/dev/null 2>&1`,
    `printf '%s\\n' "$pw" | ${SUDO} /bin/launchctl bootstrap gui/${location.uid} "$p" || exit 75`,
  ].join("\n");
}

/** Wait, bounded, for the daemon's socket. Exit 69 when it never appears. */
export function guestDriverWaitScript(location: GuestDriverLocation, seconds: number): string {
  const tries = Math.max(1, Math.ceil(seconds * 4));
  return [
    `s=${quoteRemoteArg(absolute(location, GUEST_DRIVER_SOCKET))}`,
    `i=0; while [ ! -S "$s" ] && [ "$i" -lt ${tries} ]; do /bin/sleep 0.25; i=$((i+1)); done`,
    '[ -S "$s" ] || exit 69',
  ].join("\n");
}

/** Restart the daemon so a process started before the grant sees it (TCC caches per process). */
export function guestDriverRestartScript(location: GuestDriverLocation): string {
  return [
    "IFS= read -r pw || exit 64",
    `printf '%s\\n' "$pw" | ${SUDO} /bin/launchctl kickstart -k gui/${location.uid}/${GUEST_DRIVER_LABEL} || exit 75`,
  ].join("\n");
}

/**
 * Stop the guest driver for computer sign-in, without the guest password:
 * remove the enabled file so the agent isn't kept alive, then end every
 * process signed as cua-driver, wherever its file is. A copy the Bot made
 * keeps the driver's signature and so its grants; this sweep ends those too.
 */
export function guestDriverSuspendScript(): string {
  return [
    `/bin/rm -f "$HOME/${GUEST_DRIVER_ENABLED_FILE}"`,
    "u=$(/usr/bin/id -u)",
    'for p in $(/usr/bin/pgrep -U "$u"); do',
    '  [ "$p" = "$$" ] && continue',
    '  if /usr/bin/codesign -d -v "+$p" 2>&1 | /usr/bin/grep -qx "Identifier=cua-driver"; then /bin/kill -KILL "$p" 2>/dev/null; fi',
    "done",
    "exit 0",
  ].join("\n");
}

/**
 * The bridge's remote side: start the daemon again if sign-in stopped it,
 * wait for its socket, then speak MCP on stdio through `mcp --embedded
 * --socket`, which never launches a standalone driver app of its own.
 */
export function guestDriverBridgeScript(location: GuestDriverLocation, waitSeconds = 10): string {
  const env = Object.entries(guestDriverEnvironment()).map(([key, value]) => `${key}=${quoteRemoteArg(value)}`);
  return [
    `e=${quoteRemoteArg(absolute(location, GUEST_DRIVER_ENABLED_FILE))}`,
    '[ -e "$e" ] || /usr/bin/touch "$e" || exit 68',
    guestDriverWaitScript(location, waitSeconds),
    [
      "exec /usr/bin/env -i",
      `HOME=${quoteRemoteArg(location.home)}`,
      ...env,
      quoteRemoteArg(absolute(location, GUEST_DRIVER_BINARY)),
      "mcp --embedded --socket",
      quoteRemoteArg(absolute(location, GUEST_DRIVER_SOCKET)),
    ].join(" "),
  ].join("\n");
}

function check(step: GuestDriverInstallStep, result: BotComputerGuestCommandResult): void {
  if (result.exitCode === 0 && !result.timedOut) return;
  const reason =
    result.exitCode === 70
      ? "the copied helper didn't match Aiden's pinned release"
      : result.exitCode === 71
        ? "the copied helper failed its signature check"
        : result.exitCode === 69
          ? "the helper didn't start"
          : result.timedOut
            ? "it timed out"
            : `exit ${String(result.exitCode)}`;
  throw new BotComputerError("start_failed", `Installing Aiden's helper in the base computer failed at "${step}" (${reason}).`);
}

/**
 * Copy, verify and load the guest driver. Returns where it lives, for the
 * bridge and the permission step that follow.
 */
export async function installGuestDriver(
  context: GuestDriverInstallContext,
  options: { onStep?(step: GuestDriverInstallStep): void } = {},
): Promise<GuestDriverLocation> {
  const step = (id: GuestDriverInstallStep) => {
    if (context.signal?.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
    options.onStep?.(id);
  };
  step("locate");
  const located = await context.guestSsh(guestDriverLocateScript(), { timeoutMs: 30_000 });
  check("locate", located);
  const location = parseGuestDriverLocation(located.stdout);
  step("copy");
  check("copy", await context.guestSsh(guestDriverCopyScript(), { stdinFile: context.driverPath, timeoutMs: 300_000 }));
  step("verify");
  check("verify", await context.guestSsh(guestDriverVerifyScript(context.pin), { timeoutMs: 120_000 }));
  step("agent");
  check(
    "agent",
    await context.guestSsh(guestDriverAgentScript(location), {
      stdin: `${context.password}\n${guestDriverLaunchAgentPlist(location)}`,
      timeoutMs: 60_000,
    }),
  );
  step("wait_for_socket");
  check("wait_for_socket", await context.guestSsh(guestDriverWaitScript(location, 30), { timeoutMs: 45_000 }));
  return location;
}
