import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  SUBAGENT_PACKAGED_SOAK_CHAT_PATH,
  SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME,
  SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH,
  SUBAGENT_PACKAGED_SOAK_ENV,
  SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH,
  SUBAGENT_PACKAGED_SOAK_QUIT_FINALIZATION_GRACE_MS,
  SubagentPackagedSoakQuitFinalizationTimeout,
  SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX,
  canWriteSubagentPackagedSoakQuitReceipt,
  createSubagentPackagedSoakReceipt,
  expectedSubagentPackagedSoakReceiptPhase,
  loadSubagentPackagedSoakSession,
  parseSubagentPackagedSoakControl,
  parseSubagentPackagedSoakReceipt,
  requiresSubagentPackagedSoakFailureExit,
  subagentPackagedSoakAction,
  tryFinalizeSubagentPackagedSoakQuitReceipt,
  writeSubagentPackagedSoakReceipt,
} from "./subagent-packaged-soak-core.js";

const nonce = "a".repeat(43);
const metrics = {
  starts: 1,
  completions: 0,
  failures: 0,
  timeouts: 0,
  peakConcurrency: 1,
  cleanupFailures: 0,
};

async function root(t: test.TestContext): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), SUBAGENT_PACKAGED_SOAK_ROOT_PREFIX));
  await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

async function writeControl(rootPath: string, control: unknown): Promise<string> {
  const controlPath = path.join(rootPath, SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME);
  await fs.writeFile(controlPath, JSON.stringify(control), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(controlPath, 0o600);
  return controlPath;
}

function input(controlPath: string, extra: Partial<Parameters<typeof loadSubagentPackagedSoakSession>[0]> = {}) {
  return {
    isPackaged: true,
    argv: ["Aiden Agent", `${SUBAGENT_PACKAGED_SOAK_CONTROL_SWITCH}=${controlPath}`],
    environment: { [SUBAGENT_PACKAGED_SOAK_ENV]: "1" },
    temporaryDirectory: os.tmpdir(),
    ...extra,
  };
}

test("packaged soak remains disabled unless the packaged and environment gates are both present", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 1,
    mode: "user_stop",
  });

  assert.equal(
    await loadSubagentPackagedSoakSession(input(controlPath, { isPackaged: false })),
    undefined,
  );
  assert.equal(
    await loadSubagentPackagedSoakSession(input(controlPath, { environment: {} })),
    undefined,
  );
});

test("a packaged soak session accepts only a private one-shot control beneath the system temp root", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 7,
    mode: "navigate",
  });
  const session = await loadSubagentPackagedSoakSession(input(controlPath));
  assert.ok(session);
  assert.equal(session.control.mode, "navigate");
  assert.equal(session.control.cycle, 7);
  assert.equal(session.root, await fs.realpath(rootPath));
  assert.equal(session.receiptPath, path.join(session.root, "receipt.json"));
});

test("control parsing rejects arbitrary fields, weak nonces, and invalid modes", () => {
  for (const value of [
    {},
    { version: 1, nonce, cycle: 1, mode: "user_stop", extra: true },
    { version: 1, nonce: "short", cycle: 1, mode: "user_stop" },
    { version: 1, nonce, cycle: 0, mode: "user_stop" },
    { version: 1, nonce, cycle: 1, mode: "javascript" },
  ]) {
    assert.throws(() => parseSubagentPackagedSoakControl(value));
  }
});

test("the session loader rejects non-private controls and roots", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 1,
    mode: "quit",
  });
  await fs.chmod(controlPath, 0o644);
  await assert.rejects(loadSubagentPackagedSoakSession(input(controlPath)));

  await fs.chmod(controlPath, 0o600);
  await fs.chmod(rootPath, 0o755);
  await assert.rejects(loadSubagentPackagedSoakSession(input(controlPath)));
});

test("the fixed action map exposes no caller-provided script or navigation path", () => {
  assert.deepEqual(subagentPackagedSoakAction("user_stop"), { kind: "renderer_stop" });
  assert.deepEqual(subagentPackagedSoakAction("navigate"), {
    kind: "main_navigate",
    path: SUBAGENT_PACKAGED_SOAK_NAVIGATION_PATH,
  });
  assert.deepEqual(subagentPackagedSoakAction("quit"), { kind: "normal_quit" });
  assert.equal(SUBAGENT_PACKAGED_SOAK_CHAT_PATH, "/chat/subagent-soak");
});

test("receipts are aggregate-only, fixed to the action mode, and create-new", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 3,
    mode: "user_stop",
  });
  const session = await loadSubagentPackagedSoakSession(input(controlPath));
  assert.ok(session);

  const receipt = await writeSubagentPackagedSoakReceipt(session, metrics);
  assert.deepEqual(receipt, {
    version: 1,
    nonce,
    cycle: 3,
    mode: "user_stop",
    phase: "settled",
    metrics,
  });
  const stat = await fs.lstat(session.receiptPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.deepEqual(parseSubagentPackagedSoakReceipt(JSON.parse(await fs.readFile(session.receiptPath, "utf8"))), receipt);
  await assert.rejects(writeSubagentPackagedSoakReceipt(session, metrics));
});

test("receipt contracts require metrics and model-mode-specific final phases", () => {
  const quitControl = { version: 1 as const, nonce, cycle: 2, mode: "quit" as const };
  assert.equal(expectedSubagentPackagedSoakReceiptPhase("quit"), "action_dispatched");
  assert.equal(expectedSubagentPackagedSoakReceiptPhase("navigate"), "settled");
  assert.deepEqual(createSubagentPackagedSoakReceipt(quitControl, metrics), {
    ...quitControl,
    phase: "action_dispatched",
    metrics,
  });
  assert.throws(() =>
    parseSubagentPackagedSoakReceipt({
      ...quitControl,
      phase: "settled",
      metrics,
    }),
  );
  assert.throws(() =>
    parseSubagentPackagedSoakReceipt({
      ...quitControl,
      phase: "action_dispatched",
      metrics: { starts: 1 },
    }),
  );
});

test("a quit receipt requires both the parent and child lifecycle to settle", () => {
  assert.equal(canWriteSubagentPackagedSoakQuitReceipt(true, true), true);
  assert.equal(canWriteSubagentPackagedSoakQuitReceipt(false, true), false);
  assert.equal(canWriteSubagentPackagedSoakQuitReceipt(true, false), false);
  assert.equal(canWriteSubagentPackagedSoakQuitReceipt(false, false), false);
});

test("only an unfinished packaged-soak session requires an immediate failure exit", () => {
  const session = {
    control: { version: 1 as const, nonce, cycle: 1, mode: "quit" as const },
    root: "/private/aiden-subagent-soak",
    temporaryDirectory: "/private",
    controlPath: "/private/aiden-subagent-soak/control.json",
    receiptPath: "/private/aiden-subagent-soak/receipt.json",
  };
  assert.equal(requiresSubagentPackagedSoakFailureExit(undefined, { status: "not_requested" }), false);
  assert.equal(requiresSubagentPackagedSoakFailureExit(session, { status: "written" }), false);
  assert.equal(
    requiresSubagentPackagedSoakFailureExit(session, { status: "lifecycle_unsettled" }),
    true,
  );
  assert.equal(requiresSubagentPackagedSoakFailureExit(session, { status: "timed_out" }), true);
  assert.equal(
    requiresSubagentPackagedSoakFailureExit(session, { status: "failed", error: new Error("write") }),
    true,
  );
});

test("quit receipt finalization contains metrics and receipt failures so forced shutdown can continue", async () => {
  const session = {
    control: { version: 1 as const, nonce, cycle: 1, mode: "quit" as const },
    root: "/private/aiden-subagent-soak",
    temporaryDirectory: "/private",
    controlPath: "/private/aiden-subagent-soak/control.json",
    receiptPath: "/private/aiden-subagent-soak/receipt.json",
  };
  for (const [stage, expectedCalls] of [
    ["flush", ["flush"]],
    ["snapshot", ["flush", "snapshot"]],
    ["write", ["flush", "snapshot", "write"]],
  ] as const) {
    const calls: string[] = [];
    const result = await tryFinalizeSubagentPackagedSoakQuitReceipt(session, true, true, {
      flushMetrics: async () => {
        calls.push("flush");
        if (stage === "flush") throw new Error("metrics flush rejected");
      },
      snapshotMetrics: async () => {
        calls.push("snapshot");
        if (stage === "snapshot") throw new Error("metrics snapshot rejected");
        return metrics;
      },
      writeReceipt: async () => {
        calls.push("write");
        if (stage === "write") throw new Error("receipt write rejected");
      },
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(calls, expectedCalls);
  }
});

test("quit receipt finalization bounds a never-settling metrics, snapshot, or receipt operation", async () => {
  const session = {
    control: { version: 1 as const, nonce, cycle: 1, mode: "quit" as const },
    root: "/private/aiden-subagent-soak",
    temporaryDirectory: "/private",
    controlPath: "/private/aiden-subagent-soak/control.json",
    receiptPath: "/private/aiden-subagent-soak/receipt.json",
  };
  assert.equal(SUBAGENT_PACKAGED_SOAK_QUIT_FINALIZATION_GRACE_MS, 5_000);
  for (const [stage, expectedCalls] of [
    ["flush", ["flush"]],
    ["snapshot", ["flush", "snapshot"]],
    ["write", ["flush", "snapshot", "write"]],
  ] as const) {
    const calls: string[] = [];
    let boundedOperations = 0;
    const result = await tryFinalizeSubagentPackagedSoakQuitReceipt(session, true, true, {
      flushMetrics: async () => {
        calls.push("flush");
        if (stage === "flush") return new Promise<never>(() => {});
      },
      snapshotMetrics: async () => {
        calls.push("snapshot");
        if (stage === "snapshot") return new Promise<never>(() => {});
        return metrics;
      },
      writeReceipt: async () => {
        calls.push("write");
        if (stage === "write") return new Promise<never>(() => {});
      },
      withinDeadline: async (operation) => {
        boundedOperations += 1;
        const timedOut =
          (stage === "flush" && boundedOperations === 1) ||
          (stage === "snapshot" && boundedOperations === 2) ||
          (stage === "write" && boundedOperations === 3);
        if (!timedOut) return operation();
        void operation().catch(() => undefined);
        throw new SubagentPackagedSoakQuitFinalizationTimeout();
      },
    });
    assert.equal(result.status, "timed_out");
    assert.deepEqual(calls, expectedCalls);
  }
});

test("the production quit finalization watchdog releases a hung metrics flush", async () => {
  const result = await tryFinalizeSubagentPackagedSoakQuitReceipt(undefined, true, true, {
    flushMetrics: async () => new Promise<never>(() => {}),
    snapshotMetrics: async () => metrics,
    writeReceipt: async () => {},
    timeoutMs: 5,
  });
  assert.deepEqual(result, { status: "timed_out" });
});

test("a timed-out production receipt writer loses publication authority before it can commit", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 1,
    mode: "quit",
  });
  const session = await loadSubagentPackagedSoakSession(input(controlPath));
  assert.ok(session);

  const result = await tryFinalizeSubagentPackagedSoakQuitReceipt(session, true, true, {
    flushMetrics: async () => {},
    snapshotMetrics: async () => metrics,
    writeReceipt: async (target, snapshot, publication) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      return writeSubagentPackagedSoakReceipt(target, snapshot, publication);
    },
    timeoutMs: 5,
  });

  assert.deepEqual(result, { status: "timed_out" });
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  await assert.rejects(
    fs.lstat(session.receiptPath),
    (caught: unknown) => (caught as { code?: unknown }).code === "ENOENT",
  );
  assert.deepEqual(await fs.readdir(session.root), [SUBAGENT_PACKAGED_SOAK_CONTROL_FILENAME]);
});

test("a post-commit receipt rejection still requires the packaged soak to fail", async (t) => {
  const rootPath = await root(t);
  const controlPath = await writeControl(rootPath, {
    version: 1,
    nonce,
    cycle: 1,
    mode: "quit",
  });
  const session = await loadSubagentPackagedSoakSession(input(controlPath));
  assert.ok(session);

  const result = await tryFinalizeSubagentPackagedSoakQuitReceipt(session, true, true, {
    flushMetrics: async () => {},
    snapshotMetrics: async () => metrics,
    writeReceipt: async (target, snapshot, publication) => {
      await writeSubagentPackagedSoakReceipt(target, snapshot, publication);
      throw new Error("post-commit verification rejected");
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(requiresSubagentPackagedSoakFailureExit(session, result), true);
});
