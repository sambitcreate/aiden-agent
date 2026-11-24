// The guest driver lane's install (plan §8.6, decision 7; Linux plan F3):
// Aiden's own pinned `cua-driver`, copied from its vendored helper bundle into
// the base computer during Set up or Update base, and run there in the
// logged-in GUI session (LaunchAgent on macOS; `systemd --user` service on
// Linux when `AIDEN_BOT_COMPUTERS_LINUX=1`) so it can reach the guest desktop.
//
// - Only the pinned `cua-driver` executable is copied, with its MIT notice
//   beside it. Aiden's broker stays on the Mac: it authenticates the Aiden
//   process it runs under.
// - The guest checks the copy itself before it is put in place: its SHA-256
//   against Aiden's compiled pin (plus its code signature on macOS against the
//   pinned Cua identity and Team ID). Nothing is downloaded in the guest, and
//   no PATH lookup ever finds a driver.
// - The service keeps the daemon alive only while an "enabled" file exists, so
//   computer sign-in can stop it without the guest password (see
//   `guestDriverSuspendScript`).
// - The CLI shape (`serve --socket`, `mcp --embedded --socket`) is cua-driver
//   0.38.0's documented one.

import { quoteRemoteArg } from "../devices/ssh-device-script.js";
import { CUA_DRIVER_LINUX_ARM64_UPSTREAM_PIN } from "../computer-use/binary.js";
import { buildCuaDriverEnvironment } from "../computer-use/contract.js";
import { botComputerGuestOs, type BotComputerGuestOs } from "./linux-guest-flag.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

export const GUEST_DRIVER_LABEL = "com.aiden.bot-computer.cua-driver";
/** Under the macOS guest user's home. None of these contain a quote or a backslash. */
export const GUEST_DRIVER_SUPPORT_DIR = "Library/Application Support/Aiden";
export const GUEST_DRIVER_BINARY = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver/cua-driver`;
/** cua-driver's MIT notice, beside the copy it covers. */
export const GUEST_DRIVER_NOTICE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver/LICENSE.cua-driver.md`;
export const GUEST_DRIVER_SOCKET = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.sock`;
export const GUEST_DRIVER_PID_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.pid`;
export const GUEST_DRIVER_ENABLED_FILE = `${GUEST_DRIVER_SUPPORT_DIR}/cua-driver.enabled`;
export const GUEST_DRIVER_PLIST = `Library/LaunchAgents/${GUEST_DRIVER_LABEL}.plist`;
export const GUEST_DRIVER_LOG = "Library/Logs/Aiden/cua-driver.log";
/** The copy lands here first: home-relative, with no space, and replaced atomically. */
export const GUEST_DRIVER_STAGING = ".aiden-cua-driver.partial";

/** Under the Linux guest user's home (`AIDEN_BOT_COMPUTERS_LINUX=1`). */
export const LINUX_GUEST_DRIVER_SERVICE = "cua-driver.service";
export const LINUX_GUEST_DRIVER_SUPPORT_DIR = ".local/share/aiden";
export const LINUX_GUEST_DRIVER_BINARY = `${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver/cua-driver`;
export const LINUX_GUEST_DRIVER_NOTICE = `${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver/LICENSE.cua-driver.md`;
export const LINUX_GUEST_DRIVER_SOCKET = `${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver.sock`;
export const LINUX_GUEST_DRIVER_PID_FILE = `${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver.pid`;
export const LINUX_GUEST_DRIVER_ENABLED_FILE = `${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver.enabled`;
export const LINUX_GUEST_DRIVER_UNIT = `.config/systemd/user/${LINUX_GUEST_DRIVER_SERVICE}`;

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
  /** Required for macOS guests (verified by `codesign`); omitted for Linux guests (SHA-256 only). */
  signingRequirement?: string;
}

export interface GuestDriverInstallContext {
  /** System ssh with Aiden's key; `stdin` carries the guest password/unit, `stdinFile` the copy. */
  guestSsh(
    command: string,
    options: { stdin?: string; stdinFile?: string; timeoutMs: number },
  ): Promise<BotComputerGuestCommandResult>;
  /** The vendored driver on this Mac, already verified against the pin. */
  driverPath: string;
  /** Its licence notice from the same helper bundle, copied beside it in the guest. */
  noticePath?: string;
  pin: GuestDriverPin;
  /** The guest password sudo needs on macOS to load the LaunchAgent into the logged-in session. */
  password: string;
  /** Guest OS target; defaults to `botComputerGuestOs()`. */
  guestOs?: BotComputerGuestOs;
  signal?: AbortSignal;
}

export type GuestDriverInstallStep = "locate" | "copy" | "verify" | "notice" | "agent" | "wait_for_socket";

interface GuestDriverPaths {
  supportDir: string;
  binary: string;
  notice: string;
  socket: string;
  pidFile: string;
  enabledFile: string;
}

function pathsFor(guestOs: BotComputerGuestOs): GuestDriverPaths {
  if (guestOs === "linux") {
    return {
      supportDir: LINUX_GUEST_DRIVER_SUPPORT_DIR,
      binary: LINUX_GUEST_DRIVER_BINARY,
      notice: LINUX_GUEST_DRIVER_NOTICE,
      socket: LINUX_GUEST_DRIVER_SOCKET,
      pidFile: LINUX_GUEST_DRIVER_PID_FILE,
      enabledFile: LINUX_GUEST_DRIVER_ENABLED_FILE,
    };
  }
  return {
    supportDir: GUEST_DRIVER_SUPPORT_DIR,
    binary: GUEST_DRIVER_BINARY,
    notice: GUEST_DRIVER_NOTICE,
    socket: GUEST_DRIVER_SOCKET,
    pidFile: GUEST_DRIVER_PID_FILE,
    enabledFile: GUEST_DRIVER_ENABLED_FILE,
  };
}

function absolute(location: GuestDriverLocation, relative: string): string {
  return `${location.home}/${relative}`;
}

function linuxUserBusPrefix(uidExpr: string): string {
  return `XDG_RUNTIME_DIR="/run/user/${uidExpr}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uidExpr}/bus"`;
}

/** The environment the daemon runs with: no telemetry, no update checks, no scripts. */
export function guestDriverEnvironment(
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
  location?: GuestDriverLocation,
): Record<string, string> {
  const env = buildCuaDriverEnvironment({});
  // That label names Aiden's broker for the Mac's embedded driver; the guest
  // driver owns its own permissions.
  delete env.CUA_DRIVER_HOST_BUNDLE_ID;
  env.CUA_DRIVER_RS_PERMISSIONS_GATE = "0";
  if (guestOs === "linux") {
    env.DISPLAY = ":0";
    if (location !== undefined) {
      // LightDM launches Xorg with `-auth /var/run/lightdm/root/:0` and writes the
      // session cookie to `$HOME/.Xauthority`, so `cua-driver` needs XAUTHORITY to reach `:0`.
      env.XAUTHORITY = `${location.home}/.Xauthority`;
      env.XDG_RUNTIME_DIR = `/run/user/${location.uid}`;
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${location.uid}/bus`;
    }
  }
  return env;
}

/** `cua-driver serve` as the service runs it. */
export function guestDriverDaemonArguments(
  location: GuestDriverLocation,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string[] {
  const paths = pathsFor(guestOs);
  return [
    absolute(location, paths.binary),
    "serve",
    "--socket",
    absolute(location, paths.socket),
    "--pid-file",
    absolute(location, paths.pidFile),
    "--no-overlay",
    "--no-permissions-gate",
  ];
}

function xml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * The LaunchAgent (macOS): loaded at every login of the guest user (the base
 * logs in on its own), only in the GUI session, kept alive while the enabled
 * file exists. Every path is absolute.
 */
export function guestDriverLaunchAgentPlist(location: GuestDriverLocation): string {
  const strings = (values: readonly string[]) => values.map((value) => `\t\t<string>${xml(value)}</string>`).join("\n");
  const env = Object.entries(guestDriverEnvironment("macos"))
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
    strings(guestDriverDaemonArguments(location, "macos")),
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

/**
 * The `systemd --user` service unit (Linux): started with the desktop user's
 * session while the enabled file exists, with absolute paths and telemetry off.
 */
export function guestDriverSystemdUnit(location: GuestDriverLocation): string {
  const envEntries: Array<[string, string]> = [
    ["HOME", location.home],
    ...Object.entries(guestDriverEnvironment("linux", location)),
  ];
  const envLines = envEntries.map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`);
  const execStart = guestDriverDaemonArguments(location, "linux").join(" ");
  return [
    "[Unit]",
    "Description=Aiden Bot Computer Cua Driver",
    "After=graphical-session.target",
    `ConditionPathExists=${absolute(location, LINUX_GUEST_DRIVER_ENABLED_FILE)}`,
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

const SUDO = "/usr/bin/sudo -S -p ''";
const LOCATE_MARKER = "aiden-guest-driver";

/** Make the folders and report the home and uid, refusing an unexpected home prefix. */
export function guestDriverLocateScript(guestOs: BotComputerGuestOs = botComputerGuestOs()): string {
  if (guestOs === "linux") {
    return [
      'h="$HOME"',
      'case "$h" in /home/*) ;; *) exit 65 ;; esac',
      `umask 022 && /bin/mkdir -p "$h/${LINUX_GUEST_DRIVER_SUPPORT_DIR}/cua-driver" "$h/.config/systemd/user" || exit 66`,
      `printf '${LOCATE_MARKER} %s %s\\n' "$(/usr/bin/id -u)" "$h"`,
    ].join("\n");
  }
  return [
    'h="$HOME"',
    'case "$h" in /Users/*) ;; *) exit 65 ;; esac',
    `umask 022 && /bin/mkdir -p "$h/${GUEST_DRIVER_SUPPORT_DIR}/cua-driver" "$h/Library/LaunchAgents" "$h/Library/Logs/Aiden" || exit 66`,
    `printf '${LOCATE_MARKER} %s %s\\n' "$(/usr/bin/id -u)" "$h"`,
  ].join("\n");
}

export function parseGuestDriverLocation(
  stdout: string,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): GuestDriverLocation {
  const prefix = guestOs === "linux" ? "/home" : "/Users";
  const line = stdout.split(/\r?\n/u).find((entry) => entry.startsWith(`${LOCATE_MARKER} `));
  const match = line
    ? new RegExp(`^${LOCATE_MARKER} ([0-9]{1,7}) (${prefix}/([A-Za-z0-9._-]{1,64}))$`, "u").exec(line)
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
export function guestDriverNoticeScript(guestOs: BotComputerGuestOs = botComputerGuestOs()): string {
  return `umask 022 && /bin/cat > "$HOME/${pathsFor(guestOs).notice}"`;
}

/**
 * Check the copy in the guest (SHA-256 on Linux; SHA-256 then code signature on
 * macOS) and only then move it into place. A copy that fails is deleted.
 */
export function guestDriverVerifyScript(
  pin: GuestDriverPin,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  if (!/^[0-9a-f]{64}$/u.test(pin.binarySha256)) throw new BotComputerError("invalid", "The driver pin is malformed.");
  const paths = pathsFor(guestOs);
  if (guestOs === "linux") {
    return [
      `f="$HOME/${GUEST_DRIVER_STAGING}"`,
      `d="$HOME/${paths.binary}"`,
      "sum=$(/usr/bin/sha256sum \"$f\" | /usr/bin/awk '{print $1}')",
      `[ "$sum" = ${quoteRemoteArg(pin.binarySha256)} ] || { /bin/rm -f "$f"; exit 70; }`,
      '/bin/chmod 755 "$f" && /bin/mv -f "$f" "$d" || exit 72',
    ].join("\n");
  }
  if (!pin.signingRequirement) throw new BotComputerError("invalid", "The macOS driver pin requires a signing requirement.");
  return [
    `f="$HOME/${GUEST_DRIVER_STAGING}"`,
    `d="$HOME/${paths.binary}"`,
    "sum=$(/usr/bin/shasum -a 256 \"$f\" | /usr/bin/awk '{print $1}')",
    `[ "$sum" = ${quoteRemoteArg(pin.binarySha256)} ] || { /bin/rm -f "$f"; exit 70; }`,
    `/usr/bin/codesign --verify --strict -R=${quoteRemoteArg(pin.signingRequirement)} "$f" >/dev/null 2>&1 || { /bin/rm -f "$f"; exit 71; }`,
    '/bin/chmod 755 "$f" && /bin/mv -f "$f" "$d" || exit 72',
  ].join("\n");
}

/**
 * Write and start the guest service:
 * - macOS: plist on stdin after the password line, linted with `plutil`, loaded
 *   into the logged-in GUI domain via `launchctl bootstrap`.
 * - Linux: unit file on stdin (no password), installed under
 *   `~/.config/systemd/user/cua-driver.service`, enabled and restarted via
 *   `systemctl --user`.
 */
export function guestDriverAgentScript(
  location: GuestDriverLocation,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  if (guestOs === "linux") {
    const unit = absolute(location, LINUX_GUEST_DRIVER_UNIT);
    const bus = linuxUserBusPrefix(String(location.uid));
    return [
      `u=${quoteRemoteArg(unit)}`,
      'umask 022 && /bin/cat > "$u.partial" || exit 73',
      '/bin/mv -f "$u.partial" "$u" || exit 74',
      `/usr/bin/touch ${quoteRemoteArg(absolute(location, LINUX_GUEST_DRIVER_ENABLED_FILE))} || exit 74`,
      `${bus} /usr/bin/systemctl --user daemon-reload || exit 75`,
      `${bus} /usr/bin/systemctl --user enable ${LINUX_GUEST_DRIVER_SERVICE} || exit 75`,
      `${bus} /usr/bin/systemctl --user restart ${LINUX_GUEST_DRIVER_SERVICE} || exit 75`,
    ].join("\n");
  }
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
export function guestDriverWaitScript(
  location: GuestDriverLocation,
  seconds: number,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  const tries = Math.max(1, Math.ceil(seconds * 4));
  return [
    `s=${quoteRemoteArg(absolute(location, pathsFor(guestOs).socket))}`,
    `i=0; while [ ! -S "$s" ] && [ "$i" -lt ${tries} ]; do /bin/sleep 0.25; i=$((i+1)); done`,
    '[ -S "$s" ] || exit 69',
  ].join("\n");
}

/** Restart the daemon (macOS TCC refresh or Linux service restart). */
export function guestDriverRestartScript(
  location: GuestDriverLocation,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  if (guestOs === "linux") {
    return `${linuxUserBusPrefix(String(location.uid))} /usr/bin/systemctl --user restart ${LINUX_GUEST_DRIVER_SERVICE} || exit 75`;
  }
  return [
    "IFS= read -r pw || exit 64",
    `printf '%s\\n' "$pw" | ${SUDO} /bin/launchctl kickstart -k gui/${location.uid}/${GUEST_DRIVER_LABEL} || exit 75`,
  ].join("\n");
}

/**
 * Stop the guest driver for computer sign-in, without the guest password:
 * - macOS: remove the enabled file so the LaunchAgent isn't kept alive, kill
 *   every process signed as `cua-driver`, and remove the dead socket file.
 * - Linux: remove the enabled file, stop `cua-driver.service`, kill any
 *   remaining `cua-driver` process owned by the desktop user, and remove the
 *   dead socket file. (Separate Bot shell user processes are ended by
 *   `botComputerStopShellUserScript` during sign-in.)
 */
export function guestDriverSuspendScript(guestOs: BotComputerGuestOs = botComputerGuestOs()): string {
  if (guestOs === "linux") {
    return [
      `/bin/rm -f "$HOME/${LINUX_GUEST_DRIVER_ENABLED_FILE}"`,
      "u=$(/usr/bin/id -u)",
      `${linuxUserBusPrefix("$u")} /usr/bin/systemctl --user stop ${LINUX_GUEST_DRIVER_SERVICE} >/dev/null 2>&1 || true`,
      '/usr/bin/pkill -KILL -u "$u" -x cua-driver >/dev/null 2>&1 || true',
      `/bin/rm -f "$HOME/${LINUX_GUEST_DRIVER_SOCKET}"`,
      "exit 0",
    ].join("\n");
  }
  return [
    `/bin/rm -f "$HOME/${GUEST_DRIVER_ENABLED_FILE}"`,
    "u=$(/usr/bin/id -u)",
    'for p in $(/usr/bin/pgrep -U "$u"); do',
    '  [ "$p" = "$$" ] && continue',
    '  if /usr/bin/codesign -d -v "+$p" 2>&1 | /usr/bin/grep -qx "Identifier=cua-driver"; then /bin/kill -KILL "$p" 2>/dev/null; fi',
    "done",
    `/bin/rm -f "$HOME/${GUEST_DRIVER_SOCKET}"`,
    "exit 0",
  ].join("\n");
}

/**
 * The bridge's remote side: start the daemon again if sign-in stopped it,
 * wait for its socket, then speak MCP on stdio through `mcp --embedded
 * --socket`, which never launches a standalone driver app of its own.
 */
export function guestDriverBridgeScript(
  location: GuestDriverLocation,
  waitSeconds = 10,
  guestOs: BotComputerGuestOs = botComputerGuestOs(),
): string {
  const paths = pathsFor(guestOs);
  const env = Object.entries(guestDriverEnvironment(guestOs, location)).map(
    ([key, value]) => `${key}=${quoteRemoteArg(value)}`,
  );
  const lines = [
    `e=${quoteRemoteArg(absolute(location, paths.enabledFile))}`,
    '[ -e "$e" ] || /usr/bin/touch "$e" || exit 68',
  ];
  if (guestOs === "linux") {
    lines.push(
      `if [ ! -S ${quoteRemoteArg(absolute(location, paths.socket))} ]; then ${linuxUserBusPrefix(String(location.uid))} /usr/bin/systemctl --user start ${LINUX_GUEST_DRIVER_SERVICE} >/dev/null 2>&1 || true; fi`,
    );
  }
  lines.push(
    guestDriverWaitScript(location, waitSeconds, guestOs),
    [
      "exec /usr/bin/env -i",
      `HOME=${quoteRemoteArg(location.home)}`,
      ...env,
      quoteRemoteArg(absolute(location, paths.binary)),
      "mcp --embedded --socket",
      quoteRemoteArg(absolute(location, paths.socket)),
    ].join(" "),
  );
  return lines.join("\n");
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
 * bridge and the readiness probe that follow.
 */
export async function installGuestDriver(
  context: GuestDriverInstallContext,
  options: { onStep?(step: GuestDriverInstallStep): void } = {},
): Promise<GuestDriverLocation> {
  const guestOs = context.guestOs ?? botComputerGuestOs();
  const step = (id: GuestDriverInstallStep) => {
    if (context.signal?.aborted) throw new BotComputerError("cancelled", "Setting up Bot computers was cancelled.");
    options.onStep?.(id);
  };
  step("locate");
  const located = await context.guestSsh(guestDriverLocateScript(guestOs), { timeoutMs: 30_000 });
  check("locate", located);
  const location = parseGuestDriverLocation(located.stdout, guestOs);
  step("copy");
  check("copy", await context.guestSsh(guestDriverCopyScript(), { stdinFile: context.driverPath, timeoutMs: 300_000 }));
  step("verify");
  check("verify", await context.guestSsh(guestDriverVerifyScript(context.pin, guestOs), { timeoutMs: 120_000 }));
  if (context.noticePath !== undefined) {
    step("notice");
    check("notice", await context.guestSsh(guestDriverNoticeScript(guestOs), { stdinFile: context.noticePath, timeoutMs: 30_000 }));
  }
  step("agent");
  const agentStdin =
    guestOs === "linux"
      ? guestDriverSystemdUnit(location)
      : `${context.password}\n${guestDriverLaunchAgentPlist(location)}`;
  check(
    "agent",
    await context.guestSsh(guestDriverAgentScript(location, guestOs), {
      stdin: agentStdin,
      timeoutMs: 60_000,
    }),
  );
  step("wait_for_socket");
  check("wait_for_socket", await context.guestSsh(guestDriverWaitScript(location, 30, guestOs), { timeoutMs: 45_000 }));
  return location;
}
