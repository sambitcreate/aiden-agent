import assert from "node:assert/strict";
import test from "node:test";
import {
  activatedComputerUseStreamIds,
  ChatComputerUseMutationGate,
  ComputerUseGenerationGate,
} from "./generation-gate.js";
import {
  composerSubmissionAllowed,
  computerUseReadinessReady,
  computerUseControlState,
  reduceComputerUseRefreshState,
} from "../../../renderer/lib/computer-use-control.js";

test("closing the global gate invalidates old activation snapshots", () => {
  const gate = new ComputerUseGenerationGate();
  const before = gate.snapshot();
  assert.equal(gate.isCurrent(before), true);
  gate.close();
  assert.equal(gate.isCurrent(before), false);
  assert.equal(gate.isCurrent(gate.snapshot()), true);
});

test("global close selects only streams with an activated Computer Use controller", () => {
  const ids = activatedComputerUseStreamIds(
    new Map([
      ["ordinary", {}],
      ["computer", { computerUse: { close: () => {} } }],
    ]),
  );
  assert.deepEqual(ids, ["computer"]);
});

test("a per-chat setting lease excludes generation start until released", () => {
  const gate = new ChatComputerUseMutationGate();
  const release = gate.tryBegin("chat-1", false);
  assert.ok(release);
  assert.equal(gate.isChanging("chat-1"), true);
  assert.equal(gate.tryBegin("chat-1", false), null);
  assert.equal(gate.tryBegin("busy", true), null);
  release();
  assert.equal(gate.isChanging("chat-1"), false);
});

test("an unavailable per-chat control remains keyboard reachable and reports aria-disabled", () => {
  assert.deepEqual(computerUseControlState({ enabled: false, ready: false, busy: false }), {
    disabled: false,
    ariaDisabled: true,
  });
  assert.deepEqual(computerUseControlState({ enabled: false, ready: true, busy: true }), {
    disabled: true,
    ariaDisabled: false,
  });
});

test("Enter-key submission and the Send button share the Computer Use save gate", () => {
  const base = {
    ready: true,
    isGenerating: false,
    sending: false,
    permissionSaving: false,
    gitOperationBusy: false,
    attaching: false,
  };
  assert.equal(composerSubmissionAllowed({ ...base, computerUseSaving: false }), true);
  assert.equal(composerSubmissionAllowed({ ...base, computerUseSaving: true }), false);
});

test("a fresh direct or background-query status clears a stale manual-retry error", () => {
  const failed = reduceComputerUseRefreshState(
    { refreshing: true, error: null },
    { type: "failed", error: "helper failed" },
  );
  assert.deepEqual(failed, { refreshing: false, error: "helper failed" });
  assert.deepEqual(reduceComputerUseRefreshState(failed, { type: "succeeded" }), {
    refreshing: false,
    error: null,
  });
});

test("a failed status query overrides stale cached readiness", () => {
  assert.equal(computerUseReadinessReady(true, false), true);
  assert.equal(computerUseReadinessReady(true, true), false);
});
