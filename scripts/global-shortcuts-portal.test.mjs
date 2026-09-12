/* global process */
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout, clearTimeout } from "node:timers";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, URL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const helper = path.join(root, "build/native/aiden-global-shortcuts-portal");

if (process.platform !== "linux") {
  test("Global Shortcuts native protocol requires Linux", { skip: true }, () => {});
} else if (process.env.AIDEN_PRIVATE_PORTAL_TEST !== "1") {
  test("Global Shortcuts protocol on a private D-Bus bus", async () => {
    const { stdout } = await execute("/usr/bin/dbus-run-session", ["--", process.execPath, "--test", fileURLToPath(import.meta.url)], {
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", AIDEN_PRIVATE_PORTAL_TEST: "1" }, timeout: 30000, maxBuffer: 65536,
    }).catch(error => { throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`); });
    assert.match(stdout, /# fail 0/u);
  });
} else {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-portal-protocol-"));
  const mock = path.join(directory, "mock");
  const { stdout: flags } = await execute("/usr/bin/pkg-config", ["--cflags", "--libs", "gio-unix-2.0"]);
  await execute("/usr/bin/cc", [path.join(root, "native/global-shortcuts-portal/mock.c"), "-o", mock, ...flags.trim().split(/\s+/u)]);
  test.after(async () => { await rm(directory, { recursive: true, force: true }); });
  test("invalid native commands and unavailable bus fail without a portal prompt", async () => {
    for (const args of [[], ["probe"], ["bind", "x".repeat(129)], ["bind", "bad\ntrigger"]]) {
      await assert.rejects(execute(helper, args), error => error.code === 6 && error.stdout === "" && error.stderr === "");
    }
    await assert.rejects(execute(helper, ["bind"], { env: { PATH: "/usr/bin:/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-aiden-portal-bus" } }), error => error.code === 2 && JSON.parse(error.stdout).code === "unavailable" && error.stderr === "");
  });
  for (const mode of ["success", "cancelled", "absent-binding", "wrong-session", "owner-lost", "shortcuts-changed", "await-close", "await-terminate"]) {
    test(`portal helper ${mode}`, async () => {
      const portal = spawn(mock, [mode], { stdio: ["ignore", "pipe", "pipe"] });
      let child;
      const timer = setTimeout(() => { child?.kill("SIGKILL"); portal.kill("SIGKILL"); }, 6000);
      try {
        await once(portal.stdout, "data");
        child = spawn(helper, ["bind", "CTRL+D"], { stdio: ["pipe", "pipe", "pipe"] });
        const chunks = []; let stderr = ""; let requestedStop = false;
        child.stdout.on("data", chunk => {
          chunks.push(chunk);
          if (!requestedStop && Buffer.concat(chunks).toString().includes('"deactivated"')) {
            requestedStop = true;
            if (mode === "await-close") child.stdin.end();
            if (mode === "await-terminate") child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const [code] = await once(child, "close");
        const events = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
        assert.equal(stderr, "");
        if (["cancelled", "absent-binding", "wrong-session"].includes(mode)) {
          assert.equal(code, 2);
          assert.deepEqual(events, [{ type: "error", code: mode === "wrong-session" ? "protocol" : "cancelled" }]);
        } else {
          assert.deepEqual(events.slice(0, 3), [{ type: "bound", triggerDescription: 'Ctrl+"D"' }, { type: "activated" }, { type: "deactivated" }]);
          assert.deepEqual(events[3], ["owner-lost", "shortcuts-changed"].includes(mode) ? { type: "error", code: "unavailable" } : { type: "closed" });
          assert.equal(events.length, 4);
          assert.equal(code, ["owner-lost", "shortcuts-changed"].includes(mode) ? 2 : 0);
        }
      } finally { clearTimeout(timer); child?.kill("SIGKILL"); if (portal.exitCode === null && portal.signalCode === null) { const exited = once(portal, "close"); portal.kill("SIGKILL"); await exited; } }
    });
  }
}
