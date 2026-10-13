import assert from "node:assert/strict";
import test from "node:test";
import {
  activateComputerUseStream,
  activatedComputerUseStreamIds,
  cancelComputerUseAndSettle,
  ComputerUseGenerationGate,
} from "./generation-gate.js";
import {
  computerUseReadinessReady,
  reduceComputerUseRefreshState,
} from "../../../renderer/lib/computer-use-readiness.js";

test("closing the global gate invalidates old activation snapshots", () => {
  const gate = new ComputerUseGenerationGate();
  const before = gate.snapshot();
  assert.equal(gate.isCurrent(before), true);
  gate.close();
  assert.equal(gate.isCurrent(before), false);
  assert.equal(gate.isCurrent(gate.snapshot()), true);
});

test("global close selects only streams that used Computer Use, not every stream offered it", () => {
  const gate = new ComputerUseGenerationGate();
  const snapshot = gate.snapshot();
  const offered: { computerUse: unknown; computerUseActivated?: boolean } = { computerUse: { close: () => {} } };
  const used: { computerUse: unknown; computerUseActivated?: boolean } = { computerUse: { close: () => {} } };
  assert.equal(activateComputerUseStream(gate, snapshot, used), true);
  const ids = activatedComputerUseStreamIds(
    new Map<string, { computerUse?: unknown; computerUseActivated?: boolean }>([
      ["ordinary", {}],
      ["offered", offered],
      ["used", used],
    ]),
  );
  assert.deepEqual(ids, ["used"]);
});

test("a stream cannot start using Computer Use after a disable closed the gate", () => {
  const gate = new ComputerUseGenerationGate();
  const snapshot = gate.snapshot();
  gate.close();
  const entry: { computerUseActivated?: boolean } = {};
  assert.equal(activateComputerUseStream(gate, snapshot, entry), false);
  assert.equal(entry.computerUseActivated, undefined);
  assert.equal(activateComputerUseStream(gate, gate.snapshot(), undefined), false);
});

test("the disable path cancels a stream that called computer_use and spares one that never did", async () => {
  const gate = new ComputerUseGenerationGate();
  const closed: string[] = [];
  const entry = (id: string) => ({
    computerUse: { closeAndSettle: async () => { closed.push(id); } },
    completion: Promise.resolve(),
  });
  const active = new Map<string, ReturnType<typeof entry> & { computerUseActivated?: boolean }>([
    ["chatting", entry("chatting")],
    ["computing", entry("computing")],
  ]);
  const initializations = new Map([["starting", entry("starting")]]);
  assert.equal(activateComputerUseStream(gate, gate.snapshot(), active.get("computing")), true);
  const cancelled: string[] = [];

  await cancelComputerUseAndSettle({
    gate,
    initializations: () => initializations,
    active: () => active,
    cancel: (id) => {
      cancelled.push(id);
      active.delete(id);
    },
    timeoutMs: 1000,
  });

  assert.deepEqual(cancelled, ["computing"]);
  assert.deepEqual(closed, ["computing"]);
  assert.equal(active.has("chatting"), true);
  // The spared stream can no longer start Computer Use under the closed gate.
  assert.equal(activateComputerUseStream(gate, 0, active.get("chatting")), false);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cancel-and-settle waits for driver closure, generation completion and owner-map removal", async () => {
  const driver = deferred();
  const generation = deferred();
  const active = new Map([["cu", { computerUseActivated: true, computerUse: { closeAndSettle: () => driver.promise }, completion: generation.promise }]]);
  const gate = new ComputerUseGenerationGate();
  const snapshot = gate.snapshot();
  const cancellations: string[] = [];
  let settled = false;
  const done = cancelComputerUseAndSettle({ gate, initializations: () => new Map(), active: () => active,
    cancel: (id) => { cancellations.push(id); }, timeoutMs: 1000,
  }).then(() => { settled = true; });
  assert.equal(gate.isCurrent(snapshot), false);
  assert.deepEqual(cancellations, ["cu"]);
  active.clear();
  generation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "removed maps and completed generation do not prove the driver settled");
  driver.resolve();
  await done;
  assert.equal(settled, true);
});

test("cancel-and-settle rejects timeout and teardown errors rather than authorizing deletion", async () => {
  for (const close of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("driver failed"))]) {
    const active = new Map([["cu", { computerUseActivated: true, computerUse: { closeAndSettle: close } }]]);
    await assert.rejects(cancelComputerUseAndSettle({ gate: new ComputerUseGenerationGate(),
      initializations: () => new Map(), active: () => active, cancel: () => { active.clear(); }, timeoutMs: 10,
    }), /model was not removed/);
  }
});
