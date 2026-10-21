import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CUA_DRIVER_ALLOWED_TOOLS, CuaDriverError } from "../computer-use/contract.js";
import { ComputerUseController } from "../computer-use/controller.js";
import { createGuestCuaDriverHostFactory, guestDriverSshBridge, type GuestDriverBridgeCommand } from "./guest-driver.js";
import { guestDriverPermissions, guestDriverReady, probeGuestDriver } from "./guest-driver-readiness.js";
import { guestSshPaths } from "./ssh.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/guest-cua-driver.mjs", import.meta.url));

function scratch(t: test.TestContext): string {
  const dir = mkdtempSync(path.join(tmpdir(), "aiden-guest-bridge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fixtureBridge(...args: string[]): GuestDriverBridgeCommand {
  return { command: process.execPath, args: [FIXTURE, ...args], env: { PATH: "/usr/bin:/bin" } };
}

async function host(t: test.TestContext, ...args: string[]) {
  const abort = new AbortController();
  const driverHost = await createGuestCuaDriverHostFactory({ bridge: () => fixtureBridge(...args) })(abort.signal);
  t.after(() => driverHost.shutdown());
  return driverHost;
}

function logged(file: string): Array<{ name: string; args: Record<string, unknown> }> {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string; args: Record<string, unknown> });
}

test("a guest session speaks MCP over the bridge child and keeps only Aiden's allowlist", async (t) => {
  const log = path.join(scratch(t), "calls.jsonl");
  const session = await (await host(t, "--log", log)).createSession();
  assert.equal(session.ready, true);
  // The guest's proxy lists every upstream tool; the catalog check drops the rest.
  assert.deepEqual(new Set(session.toolCatalog.keys()), CUA_DRIVER_ALLOWED_TOOLS);
  assert.equal(session.toolCatalog.has("run_script"), false);
  await assert.rejects(session.callTool("run_script", { script: "say hi" }), (error: unknown) => {
    return error instanceof CuaDriverError && error.code === "unsupported_tool";
  });

  const apps = (await session.callTool("list_apps", {})) as { structuredContent?: { apps?: unknown[] } };
  assert.ok((apps.structuredContent?.apps?.length ?? 0) > 0);
  // start_session ran first, with Aiden's own session id on every call that declares one.
  const calls = logged(log);
  assert.equal(calls[0].name, "start_session");
  assert.equal(calls[calls.length - 1]?.name, "list_apps");
  assert.equal(calls.some((call) => call.name === "run_script"), false, "a refused tool never reaches the guest");
});

test("a guest driver with another tool schema is refused before any call", async (t) => {
  const log = path.join(scratch(t), "calls.jsonl");
  writeFileSync(log, "");
  await assert.rejects((await host(t, "--schema-version", "2", "--log", log)).createSession(), (error: unknown) => {
    return error instanceof CuaDriverError && error.code === "incompatible_driver";
  });
  assert.equal(readFileSync(log, "utf8"), "", "not even start_session");
});

test("a bridge whose daemon never came up fails to connect, with the guest's own words", async (t) => {
  await assert.rejects((await host(t, "--exit", "69")).createSession(), (error: unknown) => {
    return error instanceof CuaDriverError && error.code === "connection_failed" && /no Cua Driver daemon/u.test(error.message);
  });
});

test("the Computer Use controller drives a guest window through the guest host", async (t) => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const controller = new ComputerUseController("guest-test", true, createGuestCuaDriverHostFactory({ bridge: () => fixtureBridge() }));
  t.after(() => controller.close());
  const captured = await controller.execute("call-1", { action: "capture", mode: "som", app: "Safari" }, abort.signal);
  const payload = JSON.parse((captured.content[0] as { text: string }).text) as {
    ok: boolean;
    elements: Array<{ index: number; role?: string; label?: string }>;
  };
  assert.equal(payload.ok, true);
  assert.ok(payload.elements.length > 0);
  assert.ok(captured.content.some((block) => block.type === "image"));
});

test("the probe passes only with both grants, the pinned version, apps, and a real capture", async (t) => {
  const dir = scratch(t);
  const permissions = path.join(dir, "permissions.json");
  writeFileSync(permissions, JSON.stringify({ accessibility: true, screen_recording: false }));
  const session = await (await host(t, "--permissions-file", permissions)).createSession();
  assert.deepEqual(await probeGuestDriver(session), {
    ready: false,
    permissions: { accessibility: true, screenRecording: false },
    reason: "permissions",
  });

  writeFileSync(permissions, JSON.stringify({ accessibility: true, screen_recording: true }));
  assert.deepEqual(await probeGuestDriver(session), {
    ready: true,
    permissions: { accessibility: true, screenRecording: true },
  });

  const older = await (await host(t, "--driver-version", "0.34.1")).createSession();
  assert.equal((await probeGuestDriver(older)).ready, false);
});

test("asking for the grants prompts in the guest; checking never does", async (t) => {
  const dir = scratch(t);
  const permissions = path.join(dir, "permissions.json");
  const log = path.join(dir, "calls.jsonl");
  writeFileSync(permissions, JSON.stringify({ accessibility: false, screen_recording: false }));
  const session = await (await host(t, "--permissions-file", permissions, "--grant-on-prompt", "--log", log)).createSession();

  assert.deepEqual(await guestDriverPermissions(session, { prompt: false }), { accessibility: false, screenRecording: false });
  assert.deepEqual(await guestDriverPermissions(session, { prompt: true }), { accessibility: true, screenRecording: true });
  const checks = logged(log).filter((call) => call.name === "check_permissions");
  assert.deepEqual(
    checks.map((call) => call.args.prompt),
    [false, true],
  );
});

test("only a recorded pass for the pinned driver opens the driver lane", () => {
  assert.equal(guestDriverReady({ version: "0.36.0" }), true);
  assert.equal(guestDriverReady({ version: "0.34.1" }), false);
  assert.equal(guestDriverReady(undefined), false);
});

test("the production bridge is Aiden's own ssh to the guest, ending in the driver's MCP proxy", () => {
  const paths = guestSshPaths("/Users/ada/Library/Application Support/Aiden Agent/bot-computers");
  const bridge = guestDriverSshBridge(
    { host: "192.168.64.7", user: "lume" },
    { home: "/Users/lume", uid: 501 },
    { paths, env: { PATH: "/usr/bin:/bin", HOME: paths.home } },
  );
  assert.equal(bridge.command, "/usr/bin/ssh");
  const separator = bridge.args.indexOf("--");
  assert.deepEqual(bridge.args.slice(separator, separator + 2), ["--", "192.168.64.7"]);
  assert.ok(bridge.args.includes("BatchMode=yes"));
  const remote = bridge.args[bridge.args.length - 1] ?? "";
  assert.match(remote, /^perl -e 'alarm \d+; exec @ARGV' \/bin\/sh -c /u);
  assert.match(remote, /mcp --embedded --socket/u);
  assert.deepEqual(Object.keys(bridge.env).sort(), ["HOME", "PATH"]);
});
