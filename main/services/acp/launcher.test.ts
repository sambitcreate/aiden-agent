import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildChildEnvironment } from "./environment.js";
import { AcpRuntimeLauncher } from "./launcher.js";
import { AcpPidLedger } from "./pid-ledger.js";
import { FAKE_AGENT, fakeDefinition, tempDir } from "./test-support.js";

function launcher(stateDir: string, ledger: AcpPidLedger, released: { count: number }) {
  return new AcpRuntimeLauncher({
    definition: {
      ...fakeDefinition,
      async prepareLaunch(context) {
        return {
          command: process.execPath,
          args: [FAKE_AGENT],
          env: buildChildEnvironment({ set: { RUN_TMP: context.tmpDir, HOOK: context.browserHook ?? "" } }),
        };
      },
    },
    installer: {
      acquire: () => ({
        runtimeDir: stateDir,
        asset: { url: "", sha256: "", archiveBytes: 0, members: [], executable: "", args: [] },
        version: "1",
        release: () => {
          released.count += 1;
        },
      }),
    } as never,
    stateDir,
    tmpRoot: path.join(stateDir, "tmp"),
    ledger,
    browserUrlMarker: "__MARK__",
  });
}

test("each process gets its own temp directory, a ledger entry and a lease, all released on dispose", async () => {
  const stateDir = tempDir();
  const ledger = new AcpPidLedger(path.join(stateDir, "processes.json"));
  const released = { count: 0 };
  const launched = await launcher(stateDir, ledger, released).launch("chat", stateDir);
  const runDirs = readdirSync(path.join(stateDir, "tmp"));
  assert.equal(runDirs.length, 1);
  assert.match(runDirs[0]!, /^run-/u);
  assert.deepEqual(ledger.snapshot().map((entry) => entry.pid), [launched.process.pid]);
  await launched.dispose();
  await launched.dispose();
  assert.equal(released.count, 1, "the lease is released exactly once");
  assert.deepEqual(readdirSync(path.join(stateDir, "tmp")), []);
  assert.deepEqual(ledger.snapshot(), []);
});

test("the browser hook prints the URL instead of opening anything", async () => {
  const stateDir = tempDir();
  const ledger = new AcpPidLedger(path.join(stateDir, "processes.json"));
  const launched = await launcher(stateDir, ledger, { count: 0 }).launch("auth", stateDir);
  const hook = path.join(stateDir, "hooks", "capture-browser-url.sh");
  assert.ok(existsSync(hook));
  assert.match(readFileSync(hook, "utf8"), /printf '%s%s\\n' '__MARK__' "\$1" >&2/u);
  await launched.dispose();
});

test("sweep removes temp directories a crashed run left behind", async () => {
  const stateDir = tempDir();
  const ledger = new AcpPidLedger(path.join(stateDir, "processes.json"));
  mkdirSync(path.join(stateDir, "tmp", "run-abandoned"), { recursive: true });
  mkdirSync(path.join(stateDir, "tmp", "keep-me"), { recursive: true });
  await launcher(stateDir, ledger, { count: 0 }).sweep();
  assert.deepEqual(readdirSync(path.join(stateDir, "tmp")), ["keep-me"]);
});
