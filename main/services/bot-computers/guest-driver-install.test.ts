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
  GUEST_DRIVER_SOCKET,
  GUEST_DRIVER_STAGING,
  guestDriverBridgeScript,
  guestDriverLaunchAgentPlist,
  guestDriverSuspendScript,
  guestDriverVerifyScript,
  guestDriverWaitScript,
  installGuestDriver,
  parseGuestDriverLocation,
  type GuestDriverInstallContext,
  type GuestDriverLocation,
  type GuestDriverPin,
} from "./guest-driver-install.js";
import { BotComputerError, type BotComputerGuestCommandResult } from "./types.js";

/** A small XML property-list reader (dict, array, string, integer, true, false), independent of the generator. */
function parsePlist(xml: string): unknown {
  const body = /<plist version="1\.0">([\s\S]*)<\/plist>/u.exec(xml)?.[1];
  assert.ok(body, "a plist document");
  const tokens = [...body.matchAll(/<(\/?)(dict|array|key|string|integer|true|false)(\/?)>|([^<]+)/gu)];
  let index = 0;
  const unescape = (text: string) =>
    text.replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
  const next = () => {
    while (index < tokens.length && tokens[index]?.[4] !== undefined && tokens[index]![4]!.trim() === "") index += 1;
    return tokens[index++];
  };
  const text = (tag: string) => {
    const content = tokens[index]?.[4] !== undefined ? unescape(tokens[index++]![4]!) : "";
    const close = next();
    assert.equal(close?.[1] === "/" && close[2], tag);
    return content;
  };
  const value = (): unknown => {
    const open = next();
    assert.ok(open && open[1] === "");
    switch (open[2]) {
      case "true":
      case "false":
        assert.equal(open[3], "/");
        return open[2] === "true";
      case "string":
        return text("string");
      case "integer":
        return Number(text("integer"));
      case "array": {
        const items: unknown[] = [];
        for (;;) {
          const peek = tokens.slice(index).find((token) => token[4] === undefined || token[4].trim() !== "");
          if (peek?.[1] === "/" && peek[2] === "array") {
            next();
            return items;
          }
          items.push(value());
        }
      }
      case "dict": {
        const entries: Record<string, unknown> = {};
        for (;;) {
          const key = next();
          if (key?.[1] === "/" && key[2] === "dict") return entries;
          assert.equal(key?.[2], "key");
          entries[text("key")] = value();
        }
      }
      default:
        assert.fail(`unexpected <${open[2]}>`);
    }
  };
  const result = value();
  assert.equal(next(), undefined, "one top-level value");
  return result;
}

const PIN: GuestDriverPin = {
  version: "0.36.0",
  binarySha256: "87c7e782e69703d95524e4ceb7ceba03c8a159caabf1f1ce2c118eade7d2a5ec",
  signingRequirement: 'anchor apple generic and identifier "cua-driver" and certificate leaf[subject.OU] = "YCK386LBJ7"',
};
const LOCATION: GuestDriverLocation = { home: "/Users/lume", uid: 501 };

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
  const home = mkdtempSync(path.join(tmpdir(), "aiden-guest-driver-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, path.dirname(GUEST_DRIVER_BINARY)), { recursive: true });
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
    if (calls.length === 1) return result(0, `noise\naiden-guest-driver 501 /Users/lume\n`);
    return answer(call, calls.length - 1);
  };
}

function context(calls: Call[], overrides: Partial<GuestDriverInstallContext> = {}): GuestDriverInstallContext {
  return {
    guestSsh: guest(calls),
    driverPath: "/Applications/Aiden Agent.app/Contents/Helpers/CuaDriver.app/Contents/MacOS/cua-driver",
    pin: PIN,
    password: "GuestPassword0123456789abcdefgh",
    ...overrides,
  };
}

test("install locates the guest home, streams the vendored file, verifies it there, then loads the agent", async () => {
  const calls: Call[] = [];
  const steps: string[] = [];
  const location = await installGuestDriver(context(calls), { onStep: (step) => steps.push(step) });

  assert.deepEqual(location, LOCATION);
  assert.deepEqual(steps, ["locate", "copy", "verify", "agent", "wait_for_socket"]);
  // The binary goes over stdin from the vendored path, never in argv.
  assert.equal(calls[1].stdinFile, context([]).driverPath);
  assert.equal(calls[1].command.includes("cua-driver.app"), false);
  // The password is the first stdin line of the agent step, followed by the plist; never in a command.
  const agent = calls[3];
  assert.ok(agent.stdin?.startsWith("GuestPassword0123456789abcdefgh\n<?xml"));
  for (const call of calls) assert.equal(call.command.includes("GuestPassword0123456789abcdefgh"), false);
  const parsed = parsePlist(agent.stdin!.slice(agent.stdin!.indexOf("\n") + 1)) as Record<string, unknown>;
  assert.equal(parsed.Label, "com.aiden.bot-computer.cua-driver");
});

test("the driver's licence notice is copied beside it once the copy passed its checks", async (t) => {
  const notice = "/Applications/Aiden Agent.app/Contents/Helpers/CuaDriver.app/Contents/Resources/LICENSE.cua-driver.md";
  const calls: Call[] = [];
  const steps: string[] = [];
  await installGuestDriver(context(calls, { noticePath: notice }), { onStep: (step) => steps.push(step) });
  assert.deepEqual(steps, ["locate", "copy", "verify", "notice", "agent", "wait_for_socket"]);
  const sent = calls.find((call) => call.stdinFile === notice);
  assert.ok(sent, "the notice goes over stdin from the helper bundle");

  // Run as the guest would: the notice lands next to the driver.
  const home = tempHome(t);
  const ran = sh(sent.command, home, "MIT License\n\nCopyright (c) Cua AI, Inc.\n");
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(readFileSync(path.join(home, path.dirname(GUEST_DRIVER_BINARY), "LICENSE.cua-driver.md"), "utf8"), /^MIT License/u);

  // A copy that fails its checks is never given a notice, or loaded.
  const refused: Call[] = [];
  await assert.rejects(
    installGuestDriver(
      context(refused, { noticePath: notice, guestSsh: guest(refused, (_call, index) => result(index === 2 ? 70 : 0)) }),
    ),
  );
  assert.equal(refused.some((call) => call.stdinFile === notice), false);
});

test("a failed guest check stops the install and says which one", async () => {
  const calls: Call[] = [];
  await assert.rejects(
    installGuestDriver(context(calls, { guestSsh: guest(calls, (_call, index) => result(index === 2 ? 70 : 0)) })),
    (error: unknown) =>
      error instanceof BotComputerError && error.code === "start_failed" && /didn't match Aiden's pinned release/u.test(error.message),
  );
  assert.equal(calls.length, 3, "nothing is loaded after a copy that failed its check");

  const signed: Call[] = [];
  await assert.rejects(
    installGuestDriver(context(signed, { guestSsh: guest(signed, (_call, index) => result(index === 2 ? 71 : 0)) })),
    /failed its signature check/u,
  );
});

test("a cancelled install stops before its next step", async () => {
  const abort = new AbortController();
  const calls: Call[] = [];
  await assert.rejects(
    installGuestDriver(
      context(calls, {
        signal: abort.signal,
        guestSsh: guest(calls, () => {
          abort.abort();
          return result(0);
        }),
      }),
    ),
    (error: unknown) => error instanceof BotComputerError && error.code === "cancelled",
  );
  assert.equal(calls.length, 2);
});

test("the guest location must be a plain home under /Users", () => {
  assert.deepEqual(parseGuestDriverLocation("aiden-guest-driver 502 /Users/ada.lovelace\n"), { uid: 502, home: "/Users/ada.lovelace" });
  for (const output of ["aiden-guest-driver 501 /var/root", "aiden-guest-driver 501 /Users/a b", "aiden-guest-driver x /Users/lume", ""]) {
    assert.throws(() => parseGuestDriverLocation(output), BotComputerError);
  }
});

test("the agent runs the daemon from absolute paths in the GUI session, kept alive only while enabled", () => {
  const parsed = parsePlist(guestDriverLaunchAgentPlist(LOCATION)) as Record<string, unknown>;
  assert.deepEqual(parsed.ProgramArguments, [
    "/Users/lume/Library/Application Support/Aiden/cua-driver/cua-driver",
    "serve",
    "--socket",
    "/Users/lume/Library/Application Support/Aiden/cua-driver.sock",
    "--pid-file",
    "/Users/lume/Library/Application Support/Aiden/cua-driver.pid",
    "--no-overlay",
    "--no-permissions-gate",
  ]);
  assert.equal(parsed.LimitLoadToSessionType, "Aqua");
  assert.deepEqual(parsed.KeepAlive, {
    PathState: { "/Users/lume/Library/Application Support/Aiden/cua-driver.enabled": true },
  });
  const env = parsed.EnvironmentVariables as Record<string, string>;
  assert.equal(env.HOME, "/Users/lume");
  assert.equal(env.CUA_DRIVER_RS_TELEMETRY_ENABLED, "0");
  assert.equal(env.CUA_TELEMETRY_ENABLED, "0");
  assert.equal(env.CUA_DRIVER_RS_UPDATE_CHECK, "false");
  assert.equal(env.CUA_DRIVER_DISABLE_RUN_SCRIPT, "1");
  assert.equal(env.DO_NOT_TRACK, "1");
  assert.equal(env.CUA_DRIVER_RS_PERMISSIONS_GATE, "0");
  assert.equal("CUA_DRIVER_HOST_BUNDLE_ID" in env, false, "the guest driver owns its own grants");
  // Every path is absolute; launchd expands nothing.
  assert.equal(guestDriverLaunchAgentPlist(LOCATION).includes("~"), false);
});

const hasShasum = existsSync("/usr/bin/shasum");

test("the guest deletes a copy whose hash doesn't match the pin", { skip: !hasShasum }, (t) => {
  const home = tempHome(t);
  writeFileSync(path.join(home, GUEST_DRIVER_STAGING), "not the pinned driver");
  const run = sh(guestDriverVerifyScript(PIN), home);
  assert.equal(run.status, 70);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_STAGING)), false);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_BINARY)), false);
});

test("a copy with the right hash still isn't placed unless its signature checks out", { skip: !hasShasum || existsSync("/usr/bin/codesign") }, (t) => {
  const home = tempHome(t);
  const bytes = "a file standing in for the driver";
  writeFileSync(path.join(home, GUEST_DRIVER_STAGING), bytes);
  const pin = { ...PIN, binarySha256: createHash("sha256").update(bytes).digest("hex") };
  // Without a codesign that accepts it (none on this host), the check fails closed.
  const run = sh(guestDriverVerifyScript(pin), home);
  assert.equal(run.status, 71);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_STAGING)), false);
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_BINARY)), false);
});

test("the bridge starts a stopped daemon, waits for its socket, then runs the pinned driver with a clean environment", async (t) => {
  const home = tempHome(t);
  const location = { home, uid: 501 };
  const binary = path.join(home, GUEST_DRIVER_BINARY);
  writeFileSync(binary, '#!/bin/sh\nprintf "ARGS %s\\n" "$*"\n/usr/bin/env\n');
  chmodSync(binary, 0o755);
  const socket = path.join(home, GUEST_DRIVER_SOCKET);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  t.after(() => server.close());

  const run = sh(guestDriverBridgeScript(location, 1), home, undefined, { AIDEN_SECRET: "provider-key" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, new RegExp(`^ARGS mcp --embedded --socket ${socket.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"));
  assert.match(run.stdout, /^CUA_DRIVER_RS_TELEMETRY_ENABLED=0$/mu);
  assert.match(run.stdout, /^DO_NOT_TRACK=1$/mu);
  assert.doesNotMatch(run.stdout, /AIDEN_SECRET|provider-key/u);
  // Sign-in stopped it by removing the enabled file; the bridge turns it back on.
  assert.equal(existsSync(path.join(home, GUEST_DRIVER_ENABLED_FILE)), true);
});

test("without the daemon's socket the bridge gives up, bounded, with exit 69", (t) => {
  const home = tempHome(t);
  const started = Date.now();
  const run = sh(guestDriverWaitScript({ home, uid: 501 }, 0.5), home);
  assert.equal(run.status, 69);
  assert.ok(Date.now() - started < 10_000);
});

test("suspending removes the enabled file so the agent isn't kept alive", (t) => {
  const home = tempHome(t);
  const enabled = path.join(home, GUEST_DRIVER_ENABLED_FILE);
  writeFileSync(enabled, "");
  const run = sh(guestDriverSuspendScript(), home);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(enabled), false);
});
