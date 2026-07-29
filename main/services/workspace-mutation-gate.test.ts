import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelWorkspaceGenerationsAndSettle,
  commitWithWorkspaceMutationAdmission,
  waitForWorkspaceGenerationSettlement,
  WorkspaceMutationGate,
} from "./workspace-mutation-gate.js";

test("workspace mutation gate closes admission until its owner releases it", () => {
  const gate = new WorkspaceMutationGate();
  assert.equal(gate.isChanging("workspace-1"), false);

  const release = gate.begin("workspace-1");
  assert.equal(gate.isChanging("workspace-1"), true);
  assert.equal(gate.isChanging("workspace-2"), false);
  assert.throws(() => gate.begin("workspace-1"), /already changing/u);

  release();
  release();
  assert.equal(gate.isChanging("workspace-1"), false);
});

test("beginning a mutation aborts every admitted operation and rejects new ones", () => {
  const gate = new WorkspaceMutationGate();
  const first = gate.admit("workspace-1");
  const second = gate.admit("workspace-1");

  const finishMutation = gate.begin("workspace-1");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.throws(() => gate.admit("workspace-1"), /workspace is changing/u);

  first.release();
  second.release();
  finishMutation();
  const after = gate.admit("workspace-1");
  assert.equal(after.signal.aborted, false);
  after.release();
});

test("terminal-style commits cannot cross a mutation that begins during async validation", async () => {
  const gate = new WorkspaceMutationGate();
  let releaseValidation!: () => void;
  const validation = new Promise<void>((resolve) => {
    releaseValidation = resolve;
  });
  let wroteToPty = false;
  const write = commitWithWorkspaceMutationAdmission(
    gate,
    "workspace-1",
    async () => {
      await validation;
      return () => {
        wroteToPty = true;
      };
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishMutation = gate.begin("workspace-1");
  releaseValidation();

  await assert.rejects(write, /workspace is changing/u);
  assert.equal(wroteToPty, false);
  finishMutation();
});

test("workspace boundary settlement waits for a deferred generation cleanup", async () => {
  let busy = true;
  let release!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = () => {
      busy = false;
      resolve();
    };
  });
  let settled = false;
  const waiting = waitForWorkspaceGenerationSettlement({
    completions: () => [completion],
    isBusy: () => busy,
    timeoutMessage: "timed out",
    timeoutMs: 1_000,
  }).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await waiting;
  assert.equal(settled, true);
});

test("workspace boundary settlement fails closed when cleanup remains busy", async () => {
  await assert.rejects(
    waitForWorkspaceGenerationSettlement({
      completions: () => [],
      isBusy: () => true,
      timeoutMessage: "could not stop workspace",
      timeoutMs: 1,
    }),
    /could not stop workspace/u,
  );
});

test("workspace mutation cancels and drains initialization before its delayed chat read resolves", async () => {
  let releaseChatRead!: (workspaceId: string) => void;
  const chatRead = new Promise<string>((resolve) => {
    releaseChatRead = resolve;
  });
  const controller = new AbortController();
  const initializations = new Map<
    string,
    { workspaceId?: string; completion?: Promise<void> | null }
  >();
  const active = new Map<
    string,
    { workspaceId?: string; completion?: Promise<void> | null }
  >();
  const initialization = { workspaceId: undefined as string | undefined };
  initializations.set("stream-with-stale-renderer-hint", initialization);
  let runtimePreparationStarted = false;
  const initializing = (async () => {
    initialization.workspaceId = await chatRead;
    if (!controller.signal.aborted) {
      runtimePreparationStarted = true;
    }
    initializations.delete("stream-with-stale-renderer-hint");
  })();

  let settled = false;
  const mutation = cancelWorkspaceGenerationsAndSettle({
    workspaceId: "authoritative-workspace",
    initializations: () => initializations,
    active: () => active,
    cancel: () => {
      controller.abort(new Error("workspace mutation"));
    },
    abortChildren: () => undefined,
    hasChildren: () => false,
    timeoutMessage: "timed out",
    timeoutMs: 1_000,
  }).then(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.equal(settled, false);
  assert.equal(runtimePreparationStarted, false);

  releaseChatRead("authoritative-workspace");
  await initializing;
  await mutation;
  assert.equal(settled, true);
  assert.equal(runtimePreparationStarted, false);
});
