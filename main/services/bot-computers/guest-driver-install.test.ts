import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GUEST_DRIVER_BINARY,
  GUEST_DRIVER_ENABLED_FILE,
  GUEST_DRIVER_NOTICE,
  GUEST_DRIVER_SERVICE,
  GUEST_DRIVER_SOCKET,
  GUEST_DRIVER_STAGING,
  GUEST_DRIVER_UNIT,
  LINUX_GUEST_DRIVER_PIN,
  guestDriverBridgeScript,
  guestDriverRestartScript,
  guestDriverSuspendScript,
  guestDriverSystemdUnit,
  guestDriverVerifyScript,
  guestDriverWaitScript,
  installGuestDriver,
  parseGuestDriverLocation,
  type GuestDriverInstallContext,
  type GuestDriverLocation,
  type GuestDriverPin,
} from "./guest-driver-install.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

const LOCATION: GuestDriverLocation = { home: "/home/aiden", uid: 1000 };
const hasSha256sum = existsSync("/usr/bin/sha256sum");

function result(exitCode: number, stdout = ""): BotComputerGuestCommandResult {
  return { exitCode, stdout, stderr: "", truncated: false, timedOut: false };
}

/** Run a guest script locally with /bin/sh and a chosen HOME. */
function sh(script: string, home: string, stdin?: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/sh", ["-c", script], {
    env: { PATH: "/usr/bin:/bin", HOME: home, ...env },
    input: stdin,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function tempHome(t: test.TestContext): string {
  // Short, like a real guest home: a Unix socket path is at most 107 bytes on Linux (103 on macOS).
  const home = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "agd-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, path.dirname(GUEST_DRIVER_BINARY)), { recursive: true });
  mkdirSync(path.join(home, path.dirname(GUEST_DRIVER_UNIT)), { recursive: true });
  return home;
}

interface Call {
  command: string;
  stdin?: string;
  stdinFile?: string;
}

function guest(calls: Call[], answer: (call: Call, index: number) => BotComputerGuestCommandResult = () => result(0)) {
  return async (command: string, options: { stdin?: string; stdinFile?: string; timeoutMs: number }) => {
    const call = { command, stdin: options.stdin, stdinFile: options.stdinFile };
    calls.push(call);
    if (calls.length === 1) return result(0, "noise\naiden-guest-driver 1000 /home/aiden\n");
    return answer(call, calls.length - 1);
  };
}

function context(calls: Call[], overrides: Partial<GuestDriverInstallContext> = {}): GuestDriverInstallContext {
  return {
    guestSsh: guest(calls),
    driverPath: "/Applications/Aiden Agent.app/Contents/Resources/bot-computers/cua-driver-linux-arm64/cua-driver",
    pin: LINUX_GUEST_DRIVER_PIN,
    ...overrides,
  };
}

test("install locates /home, streams the vendored Linux arm64 binary, verifies via sha256sum, and installs a systemd user unit", async (t) => {
  const calls: Call[] = [];
  const steps: string[] = [];
  const notice = "/Applications/Aiden Agent.app/Contents/Helpers/CuaDriver.app/Contents/Resources/LICENSE.cua-driver.md";
  const location = await installGuestDriver(context(calls, { noticePath: notice }), { onStep: (step) => steps.push(step) });

  assert.deepEqual(location, LOCATION);
  assert.deepEqual(steps, ["locate", "copy", "verify", "notice", "agent", "wait_for_socket"]);
  assert.equal(calls[1].stdinFile, context([]).driverPath);
  // Verify uses sha256sum and never calls codesign.
  assert.match(calls[2].command, /\/usr\/bin\/sha256sum/u);
  assert.equal(calls[2].command.includes("codesign"), false);
  // Notice lands under ~/.local/share/aiden/cua-driver.
  const home = tempHome(t);
  const noticeRun = sh(calls[3].command, home, "MIT License\n");
  assert.equal(noticeRun.status, 0, noticeRun.stderr);
  assert.equal(readFileSync(path.join(home, GUEST_DRIVER_NOTICE), "utf8"), "MIT License\n");
  // Agent writes the systemd user unit directly on stdin with no password anywhere.
  const agent = calls[4];
  assert.ok(agent.stdin?.startsWith("[Unit]\n"));
  assert.match(agent.command, /systemctl --user daemon-reload/u);
  assert.match(agent.command, new RegExp(`systemctl --user enable ${GUEST_DRIVER_SERVICE}`, "u"));
  assert.match(agent.command, new RegExp(`systemctl --user restart ${GUEST_DRIVER_SERVICE}`, "u"));
});

test("a failed guest check stops the install before notice or systemd unit, and cancellation stops before the next step", async () => {
  const notice = "/Applications/Aiden Agent.app/Contents/Helpers/CuaDriver.app/Contents/Resources/LICENSE.cua-driver.md";
  const refused: Call[] = [];
  await assert.rejects(
    installGuestDriver(
      context(refused, { noticePath: notice, guestSsh: guest(refused, (_call, index) => result(index === 2 ? 70 : 0)) }),
    ),
    (error: unknown) =>
      error instanceof BotComputerError && error.code === "start_failed" && /didn't match Aiden's pinned release/u.test(error.message),
  );
  assert.equal(refused.length, 3);
  assert.equal(refused.some((call) => call.stdinFile === notice), false);

  const abort = new AbortController();
  const cancelled: Call[] = [];
  await assert.rejects(
    installGuestDriver(
      context(cancelled, {
        signal: abort.signal,
        guestSsh: guest(cancelled, () => {
          abort.abort();
          return result(0);
        }),
      }),
    ),
    (error: unknown) => error instanceof BotComputerError && error.code === "cancelled",
  );
  assert.equal(cancelled.length, 2);
});

test("guest location accepts plain homes under /home and rejects /Users, /root, or traversal", () => {
  assert.deepEqual(parseGuestDriverLocation("aiden-guest-driver 1000 /home/aiden\n"), LOCATION);
  assert.deepEqual(parseGuestDriverLocation("aiden-guest-driver 1001 /home/ada.lovelace\n"), {
    uid: 1001,
    home: "/home/ada.lovelace",
  });
  for (const output of [
    "aiden-guest-driver 501 /Users/lume",
    "aiden-guest-driver 0 /root",
    "aiden-guest-driver 1000 /home/..",
    "aiden-guest-driver 1000 /home/.",
    "aiden-guest-driver 1000 /home/a b",
    "",
  ]) {
    assert.throws(() => parseGuestDriverLocation(output), BotComputerError);
  }
});

test("systemd user unit uses absolute paths, DISPLAY=:0, bus env, and keeps telemetry off", () => {
  const unit = guestDriverSystemdUnit(LOCATION);
  assert.match(unit, /^ConditionPathExists=\/home\/aiden\/\.local\/share\/aiden\/cua-driver\.enabled$/mu);
  assert.match(unit, /^After=graphical-session\.target$/mu);
  assert.match(unit, /^WorkingDirectory=\/home\/aiden$/mu);
  assert.match(unit, /^Environment="HOME=\/home\/aiden"$/mu);
  assert.match(unit, /^Environment="DISPLAY=:0"$/mu);
  assert.match(unit, /^Environment="XDG_RUNTIME_DIR=\/run\/user\/1000"$/mu);
  assert.match(unit, /^Environment="DBUS_SESSION_BUS_ADDRESS=unix:path=\/run\/user\/1000\/bus"$/mu);
  assert.match(unit, /^Environment="CUA_DRIVER_RS_TELEMETRY_ENABLED=0"$/mu);
  assert.match(unit, /^Environment="CUA_DRIVER_DISABLE_RUN_SCRIPT=1"$/mu);
  assert.match(unit, /^Environment="DO_NOT_TRACK=1"$/mu);
  assert.match(
    unit,
    /^ExecStart=\/home\/aiden\/\.local\/share\/aiden\/cua-driver\/cua-driver serve --socket \/home\/aiden\/\.local\/share\/aiden\/cua-driver\.sock --pid-file \/home\/aiden\/\.local\/share\/aiden\/cua-driver\.pid --no-overlay --no-permissions-gate$/mu,
  );
  assert.equal(unit.includes("~"), false);
  assert.match(guestDriverRestartScript(LOCATION), /systemctl --user restart cua-driver\.service/u);
});

test("verify script rejects mismatched SHA-256 and places matching binary without codesign", { skip: !hasSha256sum }, (t) => {
  const home = tempHome(t);
  writeFileSync(path.join(home, GUEST_DRIVER_STAGING), "wrong bytes");
  const rejected = sh(guestDriverVerifyScript(LINUX_GUEST_DRIVER_PIN), home);
  assert.equal(rejected.status, 70);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_STAGING)), false);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_BINARY)), false);

  const bytes = "#!/bin/sh\necho ok\n";
  writeFileSync(path.join(home, GUEST_DRIVER_STAGING), bytes);
  const matchingPin: GuestDriverPin = {
    version: LINUX_GUEST_DRIVER_PIN.version,
    binarySha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const accepted = sh(guestDriverVerifyScript(matchingPin), home);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_STAGING)), false);
  assert.equal(readFileSync(path.join(home, GUEST_DRIVER_BINARY), "utf8"), bytes);
});

test("bridge, wait, and suspend manage the enabled file, clean environment, and dead socket", async (t) => {
  const home = tempHome(t);
  const location = { home, uid: 1000 };
  const binary = path.join(home, GUEST_DRIVER_BINARY);
  writeFileSync(binary, '#!/bin/sh\nprintf "ARGS %s\\n" "$*"\n/usr/bin/env\n');
  chmodSync(binary, 0o755);
  const socket = path.join(home, GUEST_DRIVER_SOCKET);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => server.close());

  const waited = sh(guestDriverWaitScript(location, 1), home);
  assert.equal(waited.status, 0, waited.stderr);

  const run = sh(guestDriverBridgeScript(location, 1), home, undefined, { AIDEN_SECRET: "provider-key" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^ARGS mcp --embedded --socket ${socket.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  assert.match(run.stdout, /^DISPLAY=:0$/mu);
  assert.match(run.stdout, /^CUA_DRIVER_RS_TELEMETRY_ENABLED=0$/mu);
  assert.doesNotMatch(run.stdout, /AIDEN_SECRET|provider-key/u);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_ENABLED_FILE)), true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  const suspended = sh(guestDriverSuspendScript(), home);
  assert.equal(suspended.status, 0, suspended.stderr);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_ENABLED_FILE)), false);
  assert.equal(existsSync(socket), false);

  const afterSuspend = sh(guestDriverBridgeScript(location, 0.5), home);
  assert.equal(afterSuspend.status, 69);
});
