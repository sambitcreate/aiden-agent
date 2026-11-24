// The guest driver lane's install: Aiden's pinned Linux arm64 `cua-driver`,
// copied from its vendored helper bundle into the Debian Linux base computer
// during Set up or Update base, and run there as a `systemd --user` service in
// the logged-in XFCE session so it can reach the guest desktop and AT-SPI bus.
//
// - Only the pinned `cua-driver` executable is copied, with its MIT notice
//   beside it. Aiden's broker stays on the Mac.
// - The guest checks the copy itself before it is put in place via
//   `/usr/bin/sha256sum` against Aiden's compiled pin (`CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN`).
//   Nothing is downloaded in the guest, and no PATH lookup ever finds a driver.
// - The service keeps the daemon alive only while an "enabled" file exists, so
//   computer sign-in can stop it without a password (`guestDriverSuspendScript`).
// - The CLI shape (`serve --socket`, `mcp --embedded --socket`) is cua-driver
//   0.38.0's documented one.

import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN } from "../computer-use/binary.js";
import { buildCuaDriverEnvironment } from "../computer-use/contract.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

/** Under the Linux guest user's home. None of these contain a quote or a backslash. */
export const GUEST_DRIVER_SERVICE = "cua-driver.service";
export const GUEST_DRIVER_SUPPORT_DIR = ".local/share/aiden";
export const GUEST_DRIVER_BINARY = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver/cua-driver`;
/** cua-driver's MIT notice, beside the copy it covers. */
export const GUEST_DRIVER_NOTICE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver/LICENSE.cua-driver.md`;
export const GUEST_DRIVER_SOCKET = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.sock`;
export const GUEST_DRIVER_PID_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.pid`;
export const GUEST_DRIVER_ENABLED_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.enabled`;
export const GUEST_DRIVER_UNIT = `.config/systemd/user/${GUEST_DRIVER_SERVICE}`;
/** The copy lands here first: home-relative, with no space, and replaced atomically. */
export const GUEST_DRIVER_STAGING = ".aiden-cua-driver.partial";

/** Compiled Linux arm64 guest driver pin, derived from Aiden's release pin table. */
export const LINUX_GUEST_DRIVER_PIN: GuestDriverPin = Object.freeze({
  version: CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN.version,
  binarySha256: CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN.binarySha256,
});

/** The guest user's home and uid, read from the guest before anything is written. */
export interface GuestDriverLocation {
  home: string;
  uid: number;
}

export interface GuestDriverPin {
  version: string;
  binarySha256: string;
}

export interface GuestDriverInstallContext {
  /** System ssh with Aiden's key; `stdin` carries the systemd unit, `stdinFile` the binary/notice copy. */
  guestSsh(
    command: string,
    options: { stdin?: string; stdinFile?: string; timeoutMs: number },
  ): Promise<BotComputerGuestCommandResult>;
  /** The vendored Linux arm64 driver on this Mac, already verified against the pin. */
  driverPath: string;
  /** Its licence notice from the same helper bundle, copied beside it in the guest. */
  noticePath?: string;
  pin: GuestDriverPin;
  signal?: AbortSignal;
}

export type GuestDriverInstallStep = "locate" | "copy" | "verify" | "notice" | "agent" | "wait_for_socket";

function absolute(location: GuestDriverLocation, relative: string): string {
  return `${location.home}/${relative}`;
}

function linuxUserBusPrefix(uidExpr: string): string {
  return `XDG_RUNTIME_DIR="/run/user/${uidExpr}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uidExpr}/bus"`;
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/** The environment the daemon runs with: no telemetry, no update checks, no scripts, X11 display. */
export function guestDriverEnvironment(location?: GuestDriverLocation): Record<string, string> {
  const env = buildCuaDriverEnvironment({});
  delete env.CUA_DRIVER_HOST_BUNDLE_ID;
  env.CUA_DRIVER_RS_PERMISSIONS_GATE = "0";
  env.DISPLAY = ":0";
  if (location !== undefined) {
    env.XDG_RUNTIME_DIR = `/run/user/${location.uid}`;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${location.uid}/bus`;
  }
  return env;
}

/** `cua-driver serve` as the systemd user service runs it. */
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

/**
 * The `systemd --user` service unit: started with the desktop user's session
 * while the enabled file exists, with absolute paths and telemetry off.
 */
export function guestDriverSystemdUnit(location: GuestDriverLocation): string {
  const envEntries: Array<[string, string]> = [
    ["HOME", location.home],
    ...Object.entries(guestDriverEnvironment(location)),
  ];
  const envLines = envEntries.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`);
  const execStart = guestDriverDaemonArguments(location).join(" ");
  return [
    "[Unit]",
    "Description=Aiden Bot Computer Cua Driver",
    "After=graphical-session.target",
    `ConditionPathExists=${absolute(location, GUEST_DRIVER_ENABLED_FILE)}`,
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${location.home}`,
    ...envLines,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const LOCATE_MARKER = "aiden-guest-driver";

/** Make the folders and report the home and uid, refusing a home outside `/home/*`. */
export function guestDriverLocateScript(): string {
  return [
    'h="$HOME"',
    'case "$h" in /home/*) ;; *) exit 65 ;; esac',
    `umask 022 && /bin/mkdir -p "$h/${GUEST_DRIVER_SUPPORT_DIR}/cua-driver" "$h/.config/systemd/user" || exit 66`,
    `printf '${LOCATE_MARKER} %s %s\\n' "$(/usr/bin/id -u)" "$h"`,
  ].join("\n");
}

export function parseGuestDriverLocation(stdout: string): GuestDriverLocation {
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(`${LOCATE_MARKER} `));
  const match = line
    ? new RegExp(`^${LOCATE_MARKER} ([0-9]{1,7}) (/home/([A-Za-z0-9._-]{1,64}))$`, "u").exec(line)
    : null;
  if (!match || match[3] === "." || match[3] === "..") {
    throw new BotComputerError("start_failed", "The base computer reported an unexpected user home.");
  }
  return { uid: Number(match[1]), home: match[2] };
}

/** Receive the copy on stdin. */
export function guestDriverCopyScript(): string {
  return `umask 077 && /bin/cat > "$HOME/${GUEST_DRIVER_STAGING}"`;
}

/** Receive cua-driver's licence notice on stdin, beside the driver it covers. */
export function guestDriverNoticeScript(): string {
  return `umask 022 && /bin/cat > "$HOME/${GUEST_DRIVER_NOTICE}"`;
}

/**
 * Check the copy in the guest against its pinned SHA-256 and only then move it
 * into place. A copy that fails is deleted.
 */
export function guestDriverVerifyScript(pin: GuestDriverPin): string {
  if (!/^[0-9a-f]{64}$/u.test(pin.binarySha256)) throw new BotComputerError("invalid", "The driver pin is malformed.");
  return [
    `f="$HOME/${GUEST_DRIVER_STAGING}"`,
    `d="$HOME/${GUEST_DRIVER_BINARY}"`,
    "sum=$(/usr/bin/sha256sum \"$f\" | /usr/bin/awk '{print $1}')",
    `[ "$sum" = ${quoteRemoteArg(pin.binarySha256)} ] || { /bin/rm -f "$f"; exit 70; }`,
    '/bin/chmod 755 "$f" && /bin/mv -f "$f" "$d" || exit 72',
  ].join("\n");
}

/** Write the `systemd --user` unit from stdin, enable and restart it. */
export function guestDriverAgentScript(location: GuestDriverLocation): string {
  const unit = absolute(location, GUEST_DRIVER_UNIT);
  const bus = linuxUserBusPrefix(String(location.uid));
  return [
    `u=${quoteRemoteArg(unit)}`,
    'umask 022 && /bin/cat > "$u.partial" || exit 73',
    '/bin/mv -f "$u.partial" "$u" || exit 74',
    `/usr/bin/touch ${quoteRemoteArg(absolute(location, GUEST_DRIVER_ENABLED_FILE))} || exit 74`,
    `${bus} /usr/bin/systemctl --user daemon-reload || exit 75`,
    `${bus} /usr/bin/systemctl --user enable ${GUEST_DRIVER_SERVICE} || exit 75`,
    `${bus} /usr/bin/systemctl --user restart ${GUEST_DRIVER_SERVICE} || exit 75`,
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

/** Restart the `systemd --user` service. */
export function guestDriverRestartScript(location: GuestDriverLocation): string {
  return `${linuxUserBusPrefix(String(location.uid))} /usr/bin/systemctl --user restart ${GUEST_DRIVER_SERVICE} || exit 75`;
}

/**
 * Stop the guest driver for computer sign-in, without a password: remove the
 * enabled file, stop `cua-driver.service`, kill any remaining `cua-driver`
 * process owned by the desktop user, and remove the dead socket file.
 * (Separate Bot shell user processes are ended by `botComputerStopShellUserScript`.)
 */
export function guestDriverSuspendScript(): string {
  return [
    `/bin/rm -f "$HOME/${GUEST_DRIVER_ENABLED_FILE}"`,
    "u=$(/usr/bin/id -u)",
    `${linuxUserBusPrefix("$u")} /usr/bin/systemctl --user stop ${GUEST_DRIVER_SERVICE} >/dev/null 2>&1 || true`,
    '/usr/bin/pkill -KILL -u "$u" -x cua-driver >/dev/null 2>&1 || true',
    `/bin/rm -f "$HOME/${GUEST_DRIVER_SOCKET}"`,
    "exit 0",
  ].join("\n");
}

/**
 * The bridge's remote side: start the daemon again if sign-in stopped it,
 * wait for its socket, then speak MCP on stdio through `mcp --embedded
 * --socket`, which never launches a standalone driver app of its own.
 */
export function guestDriverBridgeScript(location: GuestDriverLocation, waitSeconds = 10): string {
  const env = Object.entries(guestDriverEnvironment(location)).map(([key, value]) => `${key}=${quoteRemoteArg(value)}`);
  return [
    `e=${quoteRemoteArg(absolute(location, GUEST_DRIVER_ENABLED_FILE))}`,
    '[ -e "$e" ] || /usr/bin/touch "$e" || exit 68',
    `if [ ! -S ${quoteRemoteArg(absolute(location, GUEST_DRIVER_SOCKET))} ]; then ${linuxUserBusPrefix(String(location.uid))} /usr/bin/systemctl --user start ${GUEST_DRIVER_SERVICE} >/dev/null 2>&1 || true; fi`,
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
      : result.exitCode === 69
        ? "the helper didn't start"
        : result.timedOut
          ? "it timed out"
          : `exit ${String(result.exitCode)}`;
  throw new BotComputerError("start_failed", `Installing Aiden's helper in the base computer failed at "${step}" (${reason}).`);
}

/**
 * Copy, verify and start the Linux guest driver. Returns where it lives, for
 * the bridge and the readiness probe that follow.
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
  if (context.noticePath !== undefined) {
    step("notice");
    check("notice", await context.guestSsh(guestDriverNoticeScript(), { stdinFile: context.noticePath, timeoutMs: 30_000 }));
  }
  step("agent");
  check(
    "agent",
    await context.guestSsh(guestDriverAgentScript(location), {
      stdin: guestDriverSystemdUnit(location),
      timeoutMs: 60_000,
    }),
  );
  step("wait_for_socket");
  check("wait_for_socket", await context.guestSsh(guestDriverWaitScript(location, 30), { timeoutMs: 45_000 }));
  return location;
}
