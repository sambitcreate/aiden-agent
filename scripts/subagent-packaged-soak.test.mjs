/* global AbortController, fetch, structuredClone */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";
import {
  appendSubagentPackagedSoakDiagnosticTail,
  assertSubagentPackagedSoakArtifactStable,
  formatSubagentPackagedSoakLoopbackEvidence,
  isSubagentPackagedSoakPackageProcess,
  parseSubagentPackagedSoakArguments,
  terminateLingeringSubagentPackagedSoakProcesses,
  verifySubagentPackagedSoakArtifact,
  waitForNoOwnedSubagentPackagedSoakProcesses,
  waitForSubagentPackagedSoakReceiptOrExit,
} from "./subagent-packaged-soak.mjs";
import {
  SUBAGENT_PACKAGED_SOAK_CHAT_ID,
  SUBAGENT_PACKAGED_SOAK_CONTEXT_LENGTH,
  SUBAGENT_PACKAGED_SOAK_MODEL_ID,
  SUBAGENT_PACKAGED_SOAK_PROVIDER_ID,
  assertCompletedSubagentPackagedSoakAggregate,
  assertSubagentPackagedSoakReceipt,
  createSubagentPackagedSoakAggregate,
  createSubagentPackagedSoakControl,
  createSubagentPackagedSoakReceipt,
  parseSubagentPackagedSoakControl,
  parseSubagentPackagedSoakReceipt,
  recordSubagentPackagedSoakCycle,
  soakCapabilityBaseUrl,
  soakChatCompletionPath,
  startSubagentPackagedSoakModel,
  subagentPackagedSoakFixture,
} from "./subagent-packaged-soak-core.mjs";

const nonce = "z".repeat(43);
const cleanMetrics = {
  starts: 1,
  completions: 0,
  failures: 0,
  timeouts: 0,
  peakConcurrency: 1,
  cleanupFailures: 0,
};

test("packaged soak arguments stay bounded and explicit", () => {
  assert.deepEqual(parseSubagentPackagedSoakArguments([]), {
    appPath: undefined,
    cycles: 100,
    help: false,
  });
  assert.deepEqual(parseSubagentPackagedSoakArguments(["--cycles", "3"]), {
    appPath: undefined,
    cycles: 3,
    help: false,
  });
  assert.throws(() => parseSubagentPackagedSoakArguments(["--cycles", "2"]));
  assert.throws(() => parseSubagentPackagedSoakArguments(["--cycles", "0"]));
  assert.throws(() => parseSubagentPackagedSoakArguments(["--anything"]));
});

test("packaged soak process ownership includes Electron helpers but excludes neighboring bundles", () => {
  const appPath = "/private/build/Aiden Agent.app";
  assert.equal(
    isSubagentPackagedSoakPackageProcess(
      appPath,
      "/private/build/Aiden Agent.app/Contents/Frameworks/Aiden Agent Helper (Renderer).app/Contents/MacOS/Aiden Agent Helper (Renderer) --type=renderer",
    ),
    true,
  );
  assert.equal(
    isSubagentPackagedSoakPackageProcess(
      appPath,
      "/private/build/Aiden Agent.app/Contents/Helpers/aiden-subagent-run-store --serve",
    ),
    true,
  );
  assert.equal(
    isSubagentPackagedSoakPackageProcess(
      appPath,
      "/private/build/Aiden Agent.app.backup/Contents/MacOS/Aiden Agent",
    ),
    false,
  );
  assert.equal(
    isSubagentPackagedSoakPackageProcess(appPath, "/bin/sh -c helper"),
    false,
  );
});

test("a normal cycle waits for a stable target-bundle process absence", async () => {
  const appPath = "/private/build/Aiden Agent.app";
  const renderer = {
    pid: 11,
    command:
      "/private/build/Aiden Agent.app/Contents/Frameworks/Aiden Agent Helper (Renderer).app/Contents/MacOS/Aiden Agent Helper (Renderer) --type=renderer",
  };
  const samples = [[], [renderer], [], []];
  let reads = 0;
  await waitForNoOwnedSubagentPackagedSoakProcesses(appPath, 1_000, {
    listPackageProcesses: async () => {
      reads += 1;
      return samples.shift() ?? [];
    },
    sleepFn: async () => {},
    now: () => 0,
  });
  assert.equal(reads, 4);
});

test("failure cleanup reaps every exact-bundle helper after a late process sample", async () => {
  const appPath = "/private/build/Aiden Agent.app";
  const renderer = {
    pid: 11,
    command:
      "/private/build/Aiden Agent.app/Contents/Frameworks/Aiden Agent Helper (Renderer).app/Contents/MacOS/Aiden Agent Helper (Renderer) --type=renderer",
  };
  const runStore = {
    pid: 12,
    command: "/private/build/Aiden Agent.app/Contents/Helpers/aiden-subagent-run-store --serve",
  };
  const neighboringApp = {
    pid: 13,
    command: "/private/build/Aiden Agent.app.backup/Contents/MacOS/Aiden Agent",
  };
  const samples = [[], [renderer, runStore, neighboringApp], [], []];
  const terminated = [];
  await terminateLingeringSubagentPackagedSoakProcesses(appPath, {
    timeoutMs: 1_000,
    listPackageProcesses: async () =>
      (samples.shift() ?? []).filter((processInfo) =>
        isSubagentPackagedSoakPackageProcess(appPath, processInfo.command),
      ),
    terminatePackageProcess: async (_target, processInfo) => {
      terminated.push(processInfo);
    },
    sleepFn: async () => {},
    now: () => 0,
  });
  assert.deepEqual(terminated, [renderer, runStore]);
});

test("the failure path reaps lingering exact-bundle processes after the main process", async () => {
  const source = await readFile(new URL("./subagent-packaged-soak.mjs", import.meta.url), "utf8");
  const failureCleanup = source.slice(
    source.indexOf("if (!completed) {"),
    source.indexOf("console.error(`Packaged subagent soak evidence was retained", source.indexOf("if (!completed) {")),
  );
  assert.match(failureCleanup, /terminateTrackedProcess\(aidenProcess\)/u);
  assert.match(failureCleanup, /terminateLingeringSubagentPackagedSoakProcesses\(appPath\)/u);
});

test("a normal packaged exit may contribute its just-written quit receipt", async () => {
  const receipt = { nonce, cycle: 3 };
  let calls = 0;
  const result = await waitForSubagentPackagedSoakReceiptOrExit({
    receiptPath: "/private/receipt.json",
    control: { nonce },
    childState: { promise: Promise.resolve({ code: 0, signal: null }) },
    deadline: Date.now() + 1_000,
    waitForReceiptFn: async () => {
      calls += 1;
      if (calls === 1) return new Promise(() => {});
      return receipt;
    },
  });
  assert.equal(result, receipt);
  assert.equal(calls, 2);
  let abnormalPollStopped = false;
  await assert.rejects(
    waitForSubagentPackagedSoakReceiptOrExit({
      receiptPath: "/private/receipt.json",
      control: { nonce },
      childState: { promise: Promise.resolve({ code: 1, signal: null }) },
      deadline: Date.now() + 1_000,
      waitForReceiptFn: async (_path, _control, _deadline, { signal } = {}) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        abnormalPollStopped = true;
        throw new Error("abnormal poll cancelled");
      },
    }),
    /exited before the soak receipt/u,
  );
  assert.equal(abnormalPollStopped, true);
});

test("a missing receipt after normal exit cancels the full-cycle poll before grace failure", async () => {
  let firstPollStopped = false;
  let calls = 0;
  await assert.rejects(
    waitForSubagentPackagedSoakReceiptOrExit({
      receiptPath: "/private/receipt.json",
      control: { nonce },
      childState: { promise: Promise.resolve({ code: 0, signal: null }) },
      deadline: Date.now() + 60_000,
      waitForReceiptFn: async (_path, _control, _deadline, { signal } = {}) => {
        calls += 1;
        if (calls === 1) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          firstPollStopped = true;
          throw new Error("full-cycle poll cancelled");
        }
        throw new Error("exit grace receipt missing");
      },
    }),
    /exit grace receipt missing/u,
  );
  assert.equal(calls, 2);
  assert.equal(firstPollStopped, true);
});

test("packaged soak failure diagnostics retain only aggregate loopback facts", () => {
  assert.equal(
    formatSubagentPackagedSoakLoopbackEvidence({
      parentToolCalls: 1,
      childStarts: 0,
      childAborts: 0,
      unexpectedRequests: 1,
    }),
    "loopback parent tool calls=1, child starts=0, child aborts=0, unexpected requests=1",
  );
  assert.equal(formatSubagentPackagedSoakLoopbackEvidence({ parentToolCalls: 1 }), null);
  assert.equal(
    formatSubagentPackagedSoakLoopbackEvidence({
      parentToolCalls: 1,
      childStarts: 0,
      childAborts: 0,
      unexpectedRequests: -1,
    }),
    null,
  );
});

test("packaged soak retains a bounded tail of disposable app diagnostics", () => {
  const prefix = "a".repeat(9_000);
  const tail = appendSubagentPackagedSoakDiagnosticTail(prefix, " latest diagnostic");
  assert.equal(tail.length, 8_192);
  assert.equal(tail.endsWith(" latest diagnostic"), true);
  assert.equal(appendSubagentPackagedSoakDiagnosticTail("first", " second"), "first second");
});

test("packaged soak binds every launch and the final report to its staged artifact", async () => {
  const artifact = {
    bundleIdentifier: "com.example.aiden",
    bundleVersion: "1",
    shortVersion: "1.0",
    cdHash: "a".repeat(40),
    appAsarSha256: "b".repeat(64),
  };
  let verified = 0;
  const dependencies = {
    verifyPackage: async () => {
      verified += 1;
    },
    getIdentity: async () => structuredClone(artifact),
  };

  assert.deepEqual(
    await verifySubagentPackagedSoakArtifact("/private/Aiden Agent.app", undefined, dependencies),
    artifact,
  );
  assert.equal(verified, 1);
  assert.deepEqual(
    await assertSubagentPackagedSoakArtifactStable("/private/Aiden Agent.app", artifact, dependencies),
    artifact,
  );
  assert.equal(verified, 2);
  let identityReads = 0;
  await assert.rejects(
    () =>
      assertSubagentPackagedSoakArtifactStable("/private/Aiden Agent.app", artifact, {
        verifyPackage: async () => {
          throw new Error("nested helper verification failed");
        },
        getIdentity: async () => {
          identityReads += 1;
          return structuredClone(artifact);
        },
      }),
    /nested helper verification failed/u,
  );
  assert.equal(identityReads, 0);
  await assert.rejects(
    () =>
      verifySubagentPackagedSoakArtifact("/private/Aiden Agent.app", artifact, {
        ...dependencies,
        getIdentity: async () => ({ ...artifact, appAsarSha256: "c".repeat(64) }),
      }),
    /appAsarSha256 mismatch/u,
  );
});

test("loopback capability routes require exact high-entropy URL-safe tokens", () => {
  assert.equal(
    soakCapabilityBaseUrl(43123, nonce),
    `http://127.0.0.1:43123/${nonce}/v1`,
  );
  assert.equal(soakChatCompletionPath(nonce), `/${nonce}/v1/chat/completions`);
  assert.throws(() => soakCapabilityBaseUrl(43123, "guessable"), /256 bits/u);
});

test("control and receipt records reject arbitrary payload fields and unsafe metrics", () => {
  const control = createSubagentPackagedSoakControl({ nonce, cycle: 1, mode: "user_stop" });
  assert.deepEqual(parseSubagentPackagedSoakControl(control), control);
  assert.throws(() => parseSubagentPackagedSoakControl({ ...control, path: "/private/value" }));

  const receipt = createSubagentPackagedSoakReceipt(control, cleanMetrics);
  assert.deepEqual(assertSubagentPackagedSoakReceipt(receipt, control), receipt);
  assert.throws(() =>
    parseSubagentPackagedSoakReceipt({
      ...receipt,
      metrics: { ...cleanMetrics, failures: -1 },
    }),
  );
  assert.throws(() =>
    assertSubagentPackagedSoakReceipt(
      { ...receipt, metrics: { ...cleanMetrics, starts: 2 } },
      control,
    ),
  );
  assert.throws(() =>
    assertSubagentPackagedSoakReceipt(
      { ...receipt, metrics: { ...cleanMetrics, completions: 1 } },
      control,
    ),
  );
  assert.throws(() =>
    assertSubagentPackagedSoakReceipt(
      { ...receipt, metrics: { ...cleanMetrics, failures: 1 } },
      control,
    ),
  );
});

test("the fixture seeds current split config with a real eligible workspace", () => {
  const fixture = subagentPackagedSoakFixture({
    port: 43123,
    capability: nonce,
    workspacePath: "/private/tmp/disposable-workspace",
    now: 123,
  });
  const provider = fixture.portableConfig.providers[0];
  assert.equal(provider?.id, SUBAGENT_PACKAGED_SOAK_PROVIDER_ID);
  assert.equal("models" in provider, false);
  assert.equal(fixture.providerModelCache.byProvider[SUBAGENT_PACKAGED_SOAK_PROVIDER_ID]?.models?.[0], SUBAGENT_PACKAGED_SOAK_MODEL_ID);
  assert.equal(
    fixture.providerModelCache.byProvider[SUBAGENT_PACKAGED_SOAK_PROVIDER_ID]?.modelMetadata?.[
      SUBAGENT_PACKAGED_SOAK_MODEL_ID
    ]?.contextLength,
    SUBAGENT_PACKAGED_SOAK_CONTEXT_LENGTH,
  );
  assert.ok(SUBAGENT_PACKAGED_SOAK_CONTEXT_LENGTH >= 128_000);
  assert.equal(fixture.localConfig.seeded, true);
  assert.equal(fixture.localConfig.workspaces[0]?.permission, "full");
  assert.equal(fixture.chat.id, SUBAGENT_PACKAGED_SOAK_CHAT_ID);
  assert.equal(fixture.chat.workspaceId, fixture.localConfig.workspaces[0]?.id);
});

test("the loopback fixture emits one parent subagent call and observes child cancellation", async () => {
  const model = await startSubagentPackagedSoakModel({ capability: nonce });
  try {
    const endpoint = `http://127.0.0.1:${model.port}${soakChatCompletionPath(nonce)}`;
    const parent = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: [{ type: "function", function: { name: "subagent" } }] }),
    });
    assert.equal(parent.status, 200);
    assert.match(await parent.text(), /"name":"subagent"/u);

    const abort = new AbortController();
    const child = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: [{ type: "function", function: { name: "read_file" } }] }),
      signal: abort.signal,
    });
    assert.equal(child.status, 200);
    await model.childStarted;
    abort.abort();
    await model.childAborted;
    assert.deepEqual(model.evidence(), {
      parentToolCalls: 1,
      childStarts: 1,
      childAborts: 1,
      unexpectedRequests: 0,
    });
  } finally {
    await model.close();
  }
});

test("aggregate output retains only privacy-safe totals and verified package identity", () => {
  const aggregate = createSubagentPackagedSoakAggregate({
    cycles: 3,
    artifact: {
      bundleIdentifier: "com.example.aiden",
      bundleVersion: "1",
      shortVersion: "1.0",
      cdHash: "a".repeat(40),
      appAsarSha256: "b".repeat(64),
    },
  });
  for (const [cycle, mode] of ["user_stop", "navigate", "quit"].entries()) {
    const control = createSubagentPackagedSoakControl({ nonce: String(cycle).padStart(43, "x"), cycle: cycle + 1, mode });
    recordSubagentPackagedSoakCycle(aggregate, {
      receipt: createSubagentPackagedSoakReceipt(control, cleanMetrics),
      requestAborts: 1,
    });
  }
  assert.deepEqual(assertCompletedSubagentPackagedSoakAggregate(aggregate), aggregate);
  assert.equal("nonce" in aggregate, false);
  assert.equal("workspacePath" in aggregate, false);

  assert.throws(() =>
    createSubagentPackagedSoakAggregate({
      cycles: 2,
      artifact: aggregate.artifact,
    }),
  );
  assert.throws(() =>
    createSubagentPackagedSoakAggregate({
      cycles: 3,
      artifact: {},
    }),
  );

  const duplicatedAbort = structuredClone(aggregate);
  duplicatedAbort.requestAborts += 1;
  assert.throws(() => assertCompletedSubagentPackagedSoakAggregate(duplicatedAbort));

  const duplicatedStart = structuredClone(aggregate);
  duplicatedStart.starts += 1;
  assert.throws(() => assertCompletedSubagentPackagedSoakAggregate(duplicatedStart));

  const missingArtifactIdentity = structuredClone(aggregate);
  missingArtifactIdentity.artifact.cdHash = "";
  assert.throws(() => assertCompletedSubagentPackagedSoakAggregate(missingArtifactIdentity));
});
