import assert from "node:assert/strict";
import test from "node:test";
import { createStarterWorkflow } from "../shared/create-images/schema.js";
import {
  deferWorkflowAutosaveControllerDisposal,
  WorkflowAutosaveController,
} from "./workflow-autosave-core.js";

function workflow() {
  return createStarterWorkflow({
    workflowId: "workflow-1",
    promptNodeId: "prompt-1",
    generationNodeId: "generate-1",
    outputNodeId: "output-1",
    promptEdgeId: "edge-1",
    outputEdgeId: "edge-2",
    now: "2026-08-11T12:00:00.000Z",
  });
}

test("autosave does not republish an unchanged saved canvas snapshot", () => {
  const initial = workflow();
  const controller = new WorkflowAutosaveController(initial, {
    delayMs: 60_000,
    save: async (request) => ({ status: "saved", workflow: request.workflow }),
  });
  const states: string[] = [];
  controller.subscribe((status) => states.push(status.state));

  controller.update(structuredClone(initial));

  assert.deepEqual(states, ["saved"]);
  assert.equal(controller.status().state, "saved");
});

test("autosave serializes edits that arrive while an earlier revision is in flight", async () => {
  const requests: Array<{ expectedRevision: number; workflow: ReturnType<typeof workflow> }> = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = new WorkflowAutosaveController(workflow(), {
    delayMs: 60_000,
    now: () => "2026-08-11T12:01:00.000Z",
    save: async (request) => {
      requests.push(request);
      if (requests.length === 1) await firstGate;
      return { status: "saved", workflow: request.workflow };
    },
  });
  const first = workflow();
  first.title = "First edit";
  controller.update(first);
  const flush = controller.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = structuredClone(first);
  second.title = "Second edit";
  controller.update(second);
  releaseFirst?.();
  await flush;
  assert.deepEqual(
    requests.map((request) => request.expectedRevision),
    [1, 2],
  );
  assert.equal(controller.status().state, "saved");
  assert.equal(controller.status().workflow.title, "Second edit");
});

test("development effect replay cancels deferred disposal without disabling autosave", async () => {
  const initial = workflow();
  const requests: Array<{ workflow: ReturnType<typeof workflow> }> = [];
  const controller = new WorkflowAutosaveController(initial, {
    delayMs: 60_000,
    save: async (request) => {
      requests.push(structuredClone(request));
      return { status: "saved", workflow: request.workflow };
    },
  });

  const cancelReplayCleanup = deferWorkflowAutosaveControllerDisposal(controller);
  cancelReplayCleanup();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  const edited = structuredClone(initial);
  const prompt = edited.nodes.find((node) => node.type === "prompt");
  assert.ok(prompt && prompt.type === "prompt");
  prompt.data.text = "make this yellow please";
  controller.update(edited);

  const status = await controller.flush();
  assert.equal(status.state, "saved");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.workflow.nodes.find((node) => node.type === "prompt")?.data.text,
    "make this yellow please",
  );
});

test("autosave stops on CAS conflict and preserves the renderer draft", async () => {
  const initial = workflow();
  const current = { ...initial, revision: 2, title: "Other writer" };
  const controller = new WorkflowAutosaveController(initial, {
    delayMs: 60_000,
    save: async () => ({
      status: "conflict",
      expectedRevision: 1,
      currentRevision: 2,
      current,
    }),
  });
  controller.update({ ...initial, title: "My draft" });
  const status = await controller.flush();
  assert.equal(status.state, "conflict");
  assert.equal(status.workflow.title, "My draft");
  assert.equal(status.state === "conflict" ? status.current.title : "", "Other writer");
});

test("a mounted controller keeps its original CAS baseline across a remote query refresh", async () => {
  const initial = workflow();
  const remote = { ...structuredClone(initial), revision: 2, title: "Remote query refresh" };
  let observedExpectedRevision: number | undefined;
  const controller = new WorkflowAutosaveController(initial, {
    delayMs: 60_000,
    save: async (request) => {
      observedExpectedRevision = request.expectedRevision;
      return {
        status: "conflict",
        expectedRevision: request.expectedRevision,
        currentRevision: remote.revision,
        current: remote,
      };
    },
  });

  // A query refresh may observe `remote`, but the still-mounted canvas must not
  // replace its controller or adopt that revision as the local draft's baseline.
  controller.update({ ...structuredClone(initial), title: "Preserved local draft" });
  const result = await controller.flush();
  assert.equal(observedExpectedRevision, 1);
  assert.equal(result.state, "conflict");
  assert.equal(result.workflow.title, "Preserved local draft");
  assert.equal(result.state === "conflict" ? result.current.title : "", remote.title);
});

test("edits made after a conflict remain in the preserved draft and retry candidate", async () => {
  const initial = workflow();
  const local = (title: string) => ({ ...structuredClone(initial), title });
  const remote = { ...structuredClone(initial), title: "Remote change", revision: 2 };
  const requests: Array<{
    expectedRevision: number;
    workflow: ReturnType<typeof workflow>;
  }> = [];
  let rejectFirst = true;
  const controller = new WorkflowAutosaveController(initial, {
    delayMs: 60_000,
    now: () => "2026-08-11T12:03:00.000Z",
    save: async (request) => {
      requests.push(structuredClone(request));
      if (rejectFirst) {
        rejectFirst = false;
        return {
          status: "conflict",
          expectedRevision: request.expectedRevision,
          currentRevision: remote.revision,
          current: remote,
        };
      }
      return { status: "saved", workflow: request.workflow };
    },
  });

  controller.update(local("First local edit"));
  assert.equal((await controller.flush()).state, "conflict");
  controller.update(local("Newest local edit"));
  const blocked = controller.status();
  assert.equal(blocked.state, "conflict");
  assert.equal(blocked.workflow.title, "Newest local edit");

  const retried = await controller.retry();
  assert.equal(retried.state, "saved");
  const lastRequest = requests[requests.length - 1];
  assert.equal(lastRequest?.workflow.title, "Newest local edit");
  assert.equal(lastRequest?.expectedRevision, initial.revision);
});
