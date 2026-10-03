import assert from "node:assert/strict";
import test from "node:test";
import {
  AppControlsService,
  appControlRevision,
  type AppControlState,
  type StoredAppOperation,
  type AppControlContext,
} from "./app-controls-core.js";
import {
  parseAppControlPanels,
  parseAppControlOperation,
} from "../../renderer/shared/app-controls.js";
import { readAidenHelp } from "./aiden-app-knowledge.js";

function fixture() {
  const state: AppControlState = {
    settings: { memoryEnabled: true },
    workspace: { id: "work", name: "Project", memoryEnabled: true },
  };
  let durable: StoredAppOperation[] = [];
  let commits = 0,
    current = true,
    crash = false;
  const service = new AppControlsService({
    read: async () => structuredClone(state),
    loadOperations: async () => structuredClone(durable),
    saveOperations: async (items) => {
      durable = structuredClone(items);
    },
    onChanged() {},
    commit: async (op, context) => {
      if (!context.isCurrent()) throw new Error("revoked");
      commits++;
      if (crash) throw new Error("interrupted publication");
      state.settings.memoryEnabled = op.value as boolean;
    },
  });
  const context: AppControlContext = {
    actor: "user",
    workspaceId: "work",
    target: "This desktop",
    humanGesture: true,
    isCurrent: () => current,
  };
  const operation = () => ({
    control: "memory.enabled",
    value: false,
    expectedRevision: appControlRevision(state, "memory.enabled"),
    operationId: "first",
  });
  return {
    state,
    service,
    context,
    operation,
    commits: () => commits,
    revoke: () => {
      current = false;
    },
    crash: () => {
      crash = true;
    },
  };
}
test("viewing controls and restoring descriptors never writes preferences", async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot("memory", f.context);
  assert.deepEqual(
    snapshot.rows.map((row) => [row.label, row.value, row.scope]),
    [
      ["Memory", true, "This desktop"],
      ["Workspace memory", true, "Workspace — Project"],
    ],
  );
  const panel = { version: 1, id: "panel", topic: "memory", fallback: "Memory controls" };
  assert.equal(parseAppControlPanels([panel])?.[0].id, "panel");
  assert.equal(f.commits(), 0);
});
test("a duplicate operation returns its durable result without flipping again", async () => {
  const f = fixture(),
    operation = f.operation();
  assert.equal((await f.service.apply(operation, f.context)).status, "applied");
  assert.equal(f.state.settings.memoryEnabled, false);
  assert.equal((await f.service.apply(operation, f.context)).status, "applied");
  assert.equal(f.commits(), 1);
  assert.equal(
    (
      await f.service.apply(
        {
          operationId: operation.operationId,
          expectedRevision: operation.expectedRevision,
          value: operation.value,
          control: operation.control,
        },
        f.context,
      )
    ).status,
    "applied",
  );
  assert.equal(f.commits(), 1);
  await assert.rejects(f.service.apply({ ...operation, value: true }, f.context), /already used/u);
});
test("unknown effects retain intent and cannot run again after interrupted publication", async () => {
  const f = fixture(),
    operation = f.operation();
  f.crash();
  await assert.rejects(f.service.apply(operation, f.context), /interrupted/u);
  assert.equal((await f.service.apply(operation, f.context)).status, "outcome_unknown");
  assert.equal(f.commits(), 1);
});
test("stale revisions, revoked owners and read-only device grants deny effects", async () => {
  const f = fixture(),
    operation = f.operation();
  f.state.settings.memoryEnabled = false;
  await assert.rejects(f.service.apply(operation, f.context), /Settings changed/u);
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, allowedControls: new Set() }),
    /not authorized/u,
  );
  f.revoke();
  await assert.rejects(f.service.apply(f.operation(), f.context), /no longer available/u);
  assert.equal(f.commits(), 0);
});
test("Ask policy and enablement require a human gesture independently of workspace access", async () => {
  const f = fixture();
  f.state.settings.appControlPolicy = "ask";
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, humanGesture: false }),
    /confirmation/u,
  );
  f.state.settings.appControlPolicy = "safe";
  f.state.settings.memoryEnabled = false;
  await assert.rejects(
    f.service.apply({ ...f.operation(), value: true }, { ...f.context, humanGesture: false }),
    /confirmation/u,
  );
  f.state.settings.appControlPolicy = "disabled";
  assert.ok(
    (await f.service.snapshot("memory", f.context)).rows.every((row) => row.disabledReason),
  );
  await assert.rejects(f.service.apply(f.operation(), f.context), /not authorized/u);
});
test("paired clients need current serving-owner consent even with a valid control", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, remote: true }),
    /Paired-host/u,
  );
  assert.equal(f.commits(), 0);
});
test("portable profile rejects executable or malformed descriptors and operations", () => {
  const panel = { version: 1, id: "id", topic: "memory", fallback: "Help" };
  assert.equal(parseAppControlPanels([{ ...panel, on: { mount: "execute" } }]), undefined);
  assert.equal(parseAppControlPanels([panel, panel]), undefined);
  assert.equal(
    parseAppControlPanels(Array.from({ length: 5 }, (_, n) => ({ ...panel, id: String(n) }))),
    undefined,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "provider.key",
        value: "secret",
        expectedRevision: "r",
        operationId: "o",
      }),
    /Invalid/u,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "memory.enabled",
        value: "false",
        expectedRevision: "r",
        operationId: "o",
      }),
    /boolean/u,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "appearance.mode",
        value: "script",
        expectedRevision: "r",
        operationId: "o",
      }),
    /Unsupported/u,
  );
});
test("offline product help is bounded and cannot read arbitrary paths", () => {
  const help = readAidenHelp("how-agents-work");
  assert.equal(help.topics.length, 1);
  assert.ok(help.topics[0].text.includes("Pi"));
  assert.equal(readAidenHelp("unknown product topic").topics.length, 0);
  assert.throws(() => readAidenHelp("../../secrets"), /topic/u);
  assert.throws(() => readAidenHelp("a".repeat(257)), /topic/u);
});

test("authorization is rechecked after the durable intent and unknown policy fails closed", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    f.service.apply(f.operation(), {
      ...f.context,
      authorize: async () => {
        if (++checks === 2) throw new Error("authority changed");
      },
    }),
    /authority changed/,
  );
  assert.equal(f.commits(), 0);
  assert.equal((await f.service.apply(f.operation(), f.context)).status, "outcome_unknown");
  const unknown = fixture();
  unknown.state.settings.appControlPolicy = "future-policy" as "safe";
  await assert.rejects(
    unknown.service.apply(unknown.operation(), unknown.context),
    /not authorized/,
  );
});
