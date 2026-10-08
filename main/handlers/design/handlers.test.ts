import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { IpcMainInvokeEvent } from "electron";
import type {
  DesignDeletePreview,
  DesignMutateResult,
  DesignProjectSnapshot,
  DesignProjectSummary,
  DesignRunStartResult,
} from "../../../renderer/shared/design/types.js";
import type { ChatGenerationOwner } from "../../services/chat-generation-owner.js";
import type { DesignRunStartInput } from "../../services/design/run-service.js";
import { DesignProjectStore } from "../../services/design/store.js";
import { DesignStoreError } from "../../services/design/store-core.js";
import { designStudioEnabled } from "../../services/studio/feature-flags.js";
import { registerDesignStudioHandlers } from "./registration.js";

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const activeEvent = { document: "active" } as unknown as IpcMainInvokeEvent;
const staleEvent = { document: "stale" } as unknown as IpcMainInvokeEvent;
const owner: ChatGenerationOwner = {
  id: 3,
  documentId: "3:1:main",
  isDestroyed: () => false,
  send: () => {},
  onInvalidated: () => () => {},
} as unknown as ChatGenerationOwner;

function assertOwner(event: IpcMainInvokeEvent): void {
  if (event !== activeEvent) throw new Error("Design Studio must be used from the active application document.");
}

const runPayload = (projectId: string) => ({
  projectId,
  streamId: "s-design-1",
  request: { op: "explore", count: 3, creativeRange: "balanced", aspects: ["layout"] },
  prompt: "A calm pricing page",
  chips: [],
  providerId: "openrouter",
  model: "model-a",
});

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chats = new Map<string, string>();
  let counter = 0;
  const store = new DesignProjectStore({
    root: async () => root,
    chats: {
      exists: async (chatId) => chats.has(chatId),
      create: async (chatId, projectId) => {
        chats.set(chatId, projectId);
      },
      remove: async (chatId) => {
        chats.delete(chatId);
      },
      ownedChatIds: async (projectId) => [...chats].filter(([, owned]) => owned === projectId).map(([id]) => id),
    },
    newId: () => `id-${(counter += 1)}`,
  });
  await store.initialize();
  const handlers = new Map<string, Listener>();
  const ipc = {
    handle: (channel: string, listener: Listener) => {
      if (handlers.has(channel)) throw new Error(`${channel} registered twice`);
      handlers.set(channel, listener);
    },
  };
  const runs: DesignRunStartInput[] = [];
  let runFailure: Error | undefined;
  const enabled = designStudioEnabled({ AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "1" });
  registerDesignStudioHandlers(enabled, ipc, () => ({
    projects: { store, assertOwner },
    runs: {
      runs: {
        start: async (input) => {
          if (runFailure) throw runFailure;
          runs.push(input);
          return { accepted: true, runId: "run-1" };
        },
      },
      generationOwner: (event) => {
        assertOwner(event);
        return owner;
      },
      assertOwner,
      preview: async ({ projectId, revisionId }) => ({
        src: `aiden-genui://preview/${"b".repeat(64)}`,
        title: `${projectId}:${revisionId}`,
      }),
      readSource: (projectId, revisionId) => store.readRevision(projectId, revisionId),
    },
  }));
  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler(event, ...args);
  };
  return {
    root,
    chats,
    store,
    handlers,
    runs,
    invoke,
    failNextRunWith(error: Error) {
      runFailure = error;
    },
  };
}

test("with Design Studio off no channel is registered and no dependency is built", () => {
  const registered: string[] = [];
  for (const environment of [{}, { AIDEN_EXPERIMENTAL_DESIGN_STUDIO: "0" }, { AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1" }]) {
    const built = registerDesignStudioHandlers(
      designStudioEnabled(environment),
      { handle: (channel: string) => void registered.push(channel) },
      () => assert.fail("Design dependencies are built only with the flag on"),
    );
    assert.equal(built, false);
  }
  assert.deepEqual(registered, []);
});

test("Design IPC registers ten channels under one prefix", async (t) => {
  const f = await fixture(t);
  const channels = [...f.handlers.keys()].sort();
  assert.equal(channels.length, 10);
  assert.ok(channels.every((channel) => channel.startsWith("designProjects:")));
});

test("projects round-trip through the handlers with compare-and-set", async (t) => {
  const f = await fixture(t);
  const created = (await f.invoke("designProjects:create", activeEvent, { title: "  Landing  " })) as DesignProjectSnapshot;
  assert.equal(created.title, "Landing");
  const listed = (await f.invoke("designProjects:list", activeEvent, {})) as DesignProjectSummary[];
  assert.deepEqual(listed.map((project) => project.id), [created.id]);
  assert.deepEqual(await f.invoke("designProjects:get", activeEvent, { projectId: created.id }), created);
  const stale = (await f.invoke("designProjects:mutate", activeEvent, {
    projectId: created.id, expectedRevision: created.revision + 5, op: { op: "rename", title: "Lost" },
  })) as DesignMutateResult;
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false ? stale.reason : undefined, "stale");
  const saved = (await f.invoke("designProjects:mutate", activeEvent, {
    projectId: created.id, expectedRevision: created.revision, op: { op: "rename", title: "Pricing" },
  })) as DesignMutateResult;
  assert.equal(saved.ok ? saved.snapshot.title : undefined, "Pricing");
  assert.deepEqual(await f.invoke("designProjects:previewDelete", activeEvent, { projectId: created.id }), {
    screens: 0, revisions: 0, bytes: 0, references: 0,
  } satisfies DesignDeletePreview);
  const copy = (await f.invoke("designProjects:duplicate", activeEvent, { projectId: created.id })) as DesignProjectSnapshot;
  assert.equal(copy.title, "Pricing copy");
  assert.equal(await f.invoke("designProjects:delete", activeEvent, { projectId: copy.id, expectedRevision: copy.revision }), undefined);
  assert.equal(f.store.get(copy.id), undefined);
});

test("a missing project comes back as a typed result, not a throw", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.invoke("designProjects:get", activeEvent, { projectId: "missing-1" }), {
    ok: false,
    reason: "not_found",
    message: "This design project no longer exists.",
  });
});

test("deleting or duplicating a project while it runs is refused busy", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await f.store.beginRun(project.id, {
    runId: "run-1", turnId: "turn-1", request: { op: "explore", count: 2, creativeRange: "balanced", aspects: [] },
  });
  const running = f.store.get(project.id)!;
  const deleted = (await f.invoke("designProjects:delete", activeEvent, {
    projectId: project.id, expectedRevision: running.revision,
  })) as { ok: boolean; reason?: string };
  assert.deepEqual([deleted.ok, deleted.reason], [false, "busy"]);
  const duplicate = (await f.invoke("designProjects:duplicate", activeEvent, { projectId: project.id })) as {
    ok: boolean;
    reason?: string;
  };
  assert.deepEqual([duplicate.ok, duplicate.reason], [false, "busy"]);
  assert.ok(f.store.get(project.id));
  assert.equal(f.store.get(project.id)!.revision, running.revision);
});

test("a stale delete is refused with a typed result and deletes nothing", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  assert.deepEqual(
    await f.invoke("designProjects:delete", activeEvent, { projectId: project.id, expectedRevision: project.revision + 1 }),
    { ok: false, reason: "stale", message: "This project changed. Review it again before deleting." },
  );
  assert.ok(f.store.get(project.id));
});

test("an unreadable project is deleted only with unreadable: true and removes its hidden chat", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "broken-1", "revisions"), { recursive: true });
  await fs.writeFile(path.join(f.root, "broken-1", "manifest.json"), "{ not json");
  await f.store.initialize();
  f.chats.set("hidden-chat-1", "broken-1");
  assert.deepEqual(await f.invoke("designProjects:previewDelete", activeEvent, { projectId: "broken-1" }), {
    screens: 0, revisions: 0, bytes: 0, references: 0, unreadable: true,
  });
  // The revision-checked delete cannot touch a project whose manifest is unknown.
  const refused = (await f.invoke("designProjects:delete", activeEvent, {
    projectId: "broken-1", expectedRevision: 1,
  })) as { ok: boolean; reason?: string };
  assert.deepEqual([refused.ok, refused.reason], [false, "not_found"]);
  await fs.stat(path.join(f.root, "broken-1"));
  assert.equal(await f.invoke("designProjects:delete", activeEvent, { projectId: "broken-1", unreadable: true }), undefined);
  await assert.rejects(fs.stat(path.join(f.root, "broken-1")), /ENOENT/u);
  assert.equal(f.chats.has("hidden-chat-1"), false);
});

test("malformed payloads are rejected before they reach the store or the run service", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const withoutModel: Record<string, unknown> = { ...runPayload(project.id) };
  delete withoutModel.providerId;
  delete withoutModel.model;
  const cases: Array<[string, unknown, RegExp]> = [
    ["designProjects:run", { ...runPayload(project.id), prompt: "   " }, /Invalid design prompt/u],
    ["designProjects:run", withoutModel, /Invalid provider id/u],
    ["designProjects:get", { projectId: "../escape" }, /Invalid project/u],
    ["designProjects:create", { title: "x".repeat(200) }, /Invalid project title/u],
    ["designProjects:mutate", { projectId: project.id, expectedRevision: 1, op: { op: "rename", title: "A", extra: 1 } }, /Invalid project change/u],
    ["designProjects:mutate", { projectId: project.id, expectedRevision: 0, op: { op: "rename", title: "A" } }, /Invalid project revision/u],
    ["designProjects:run", { ...runPayload(project.id), streamId: "bad id" }, /Invalid design stream/u],
    ["designProjects:run", { ...runPayload(project.id), thinkingLevel: "maximum" }, /Invalid thinking level/u],
    ["designProjects:run", { ...runPayload(project.id), providerId: "" }, /Invalid provider id/u],
    [
      "designProjects:run",
      { ...runPayload(project.id), chips: ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => ({ kind: "screen", screenId: id, revisionId: "r" })) },
      /Invalid design selection/u,
    ],
    ["designProjects:previewSrc", { projectId: project.id }, /Invalid Design request/u],
    ["designProjects:delete", { projectId: project.id, unreadable: true, expectedRevision: 1 }, /Invalid project delete/u],
    ["designProjects:delete", { projectId: project.id, unreadable: false }, /Invalid project delete/u],
  ];
  for (const [channel, payload, pattern] of cases) {
    await assert.rejects(f.invoke(channel, activeEvent, payload), pattern, channel);
  }
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get(project.id)!.revision, project.revision);
});

test("an inactive document can neither read nor change projects", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const calls: Array<[string, unknown]> = [
    ["designProjects:list", {}],
    ["designProjects:get", { projectId: project.id }],
    ["designProjects:mutate", { projectId: project.id, expectedRevision: project.revision, op: { op: "rename", title: "X" } }],
    ["designProjects:delete", { projectId: project.id, expectedRevision: project.revision }],
    ["designProjects:run", runPayload(project.id)],
    ["designProjects:previewSrc", { projectId: project.id, revisionId: "rev-1" }],
    ["designProjects:readSource", { projectId: project.id, revisionId: "rev-1" }],
  ];
  for (const [channel, payload] of calls) {
    await assert.rejects(f.invoke(channel, staleEvent, payload), /active application document/u, channel);
  }
  assert.equal(f.runs.length, 0);
  assert.equal(f.store.get(project.id)!.title, project.title);
});

test("a run carries the parsed request and the sender's generation owner", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const result = await f.invoke("designProjects:run", activeEvent, { ...runPayload(project.id), thinkingLevel: "high" });
  assert.deepEqual(result, { accepted: true, runId: "run-1" });
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0]!.owner, owner);
  assert.equal(f.runs[0]!.thinkingLevel, "high");
  assert.deepEqual(f.runs[0]!.request, { op: "explore", count: 3, creativeRange: "balanced", aspects: ["layout"] });
});

test("a store refusal while starting a run is shown as a run error, not thrown", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  f.failNextRunWith(new DesignStoreError("invalid", "This run no longer matches the project."));
  assert.deepEqual(await f.invoke("designProjects:run", activeEvent, runPayload(project.id)), {
    accepted: false,
    error: "This run no longer matches the project.",
  } satisfies DesignRunStartResult);
});

test("a Resume carries no brief of its own and may leave the model to the run service", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  const resume: Record<string, unknown> = {
    ...runPayload(project.id),
    request: { op: "explore", count: 3, creativeRange: "balanced", aspects: ["layout"], resumeRunId: "run-1" },
    prompt: "",
  };
  delete resume.providerId;
  delete resume.model;
  await f.invoke("designProjects:run", activeEvent, resume);
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.runs[0]!.request, resume.request);
  assert.deepEqual([f.runs[0]!.prompt, f.runs[0]!.providerId, f.runs[0]!.model], ["", undefined, undefined]);
  await assert.rejects(f.invoke("designProjects:run", activeEvent, { ...resume, prompt: "Try again" }), /Invalid design prompt/u);
  await assert.rejects(f.invoke("designProjects:run", activeEvent, { ...resume, thinkingLevel: "high" }), /Invalid provider id/u);
  const named = (await f.invoke("designProjects:run", activeEvent, { ...resume, providerId: "openrouter", model: "model-b" })) as {
    accepted: boolean;
  };
  assert.equal(named.accepted, true);
  assert.deepEqual([f.runs[1]!.providerId, f.runs[1]!.model], ["openrouter", "model-b"]);
});

test("readSource returns HTML only for a revision of that project", async (t) => {
  const f = await fixture(t);
  const project = await f.store.create();
  await f.store.beginRun(project.id, {
    runId: "run-1", turnId: "turn-1", request: { op: "explore", count: 2, creativeRange: "balanced", aspects: [] },
  });
  const { revisionId } = await f.store.acceptRunArtifact(project.id, "run-1", {
    toolCallId: "call-1", title: "Hero", html: "<main>Hero</main>", model: { providerId: "openrouter", model: "model-a" },
  });
  assert.deepEqual(await f.invoke("designProjects:readSource", activeEvent, { projectId: project.id, revisionId }), {
    html: "<main>Hero</main>",
    bytes: 17,
  });
  const other = await f.store.create();
  assert.deepEqual(await f.invoke("designProjects:readSource", activeEvent, { projectId: other.id, revisionId }), {
    ok: false,
    reason: "not_found",
    message: "That revision no longer exists.",
  });
});
