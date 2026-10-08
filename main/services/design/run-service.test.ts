import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { DesignRunChangedEvent, DesignRunRequest } from "../../../renderer/shared/design/types.js";
import type { ChatGenerationOwner } from "../chat-generation-owner.js";
import { createChatStore } from "../chat-store-core.js";
import type { ChatTurnLease } from "../chat-turn-admission.js";
import { writeJsonAtomic } from "../durable-fs.js";
import { createGenerationHarness } from "../generation-harness.js";
import { resolveGenerationProfile } from "../generation-profile.js";
import type { PiAgentRuntimeHarness } from "../pi-agent-runtime-harness.js";
import { PiCompactionSessionStore } from "../pi-compaction-session-store.js";
import { PiRuntimeEffectStore } from "../pi-runtime-effect-store.js";
import { convertToLlm } from "../pi-legacy-harness.js";
import { reconcileChatScopedStores } from "../startup-chat-reconciliation.js";
import { createDesignChatPort } from "./chat-port.js";
import { DesignRunService, type DesignGenerationOptions, type DesignRunStartInput } from "./run-service.js";
import { DesignProjectStore, type DesignProjectStoreOptions } from "./store.js";

const page = (label: string) => `<main><h1>${label}</h1></main>`;
const render = (title: string, html = page(title)) => fauxToolCall("render_artifact", { title, html });
const turn = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const explore = (count: 2 | 3 | 4): DesignRunRequest => ({ op: "explore", count, creativeRange: "balanced", aspects: [] });
const MODEL_A = { providerId: "openrouter", model: "model-a" };
/** A provider request that only ends when the run is aborted (Stop or a crash). */
const untilAborted: FauxResponseStep = (_context, options) =>
  new Promise((_resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) reject(new Error("aborted"));
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
const owner: ChatGenerationOwner = {
  id: 7,
  documentId: "doc-1",
  isDestroyed: () => false,
  send: () => {},
  onInvalidated: () => () => {},
};

function startInput(projectId: string, request: DesignRunRequest): DesignRunStartInput {
  return {
    owner,
    projectId,
    streamId: `stream-${Math.random().toString(36).slice(2)}`,
    request,
    prompt: "A calm pricing page",
    chips: [],
    providerId: "openrouter",
    model: "model-a",
  };
}

/** A Resume repeats the resumed run's request, carries no brief and leaves the model to the service. */
function resumeInput(projectId: string, runId: string): DesignRunStartInput {
  return {
    owner,
    projectId,
    streamId: `stream-${Math.random().toString(36).slice(2)}`,
    request: { op: "explore", count: 3, creativeRange: "balanced", aspects: [], resumeRunId: runId },
    prompt: "",
    chips: [],
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * A stand-in for llmClient: one turn lease per chat, a real harness per run, and
 * the effect-recovery read llmClient makes before it builds the prompt (every
 * effect it returns would become a Pi "do not repeat" boundary).
 */
function fakeGeneration(
  responses: FauxResponseStep[],
  options: {
    failStart?: Error;
    failAfterAccept?: Error;
    effects?: Pick<PiRuntimeEffectStore, "listEffectsNeedingRecoveryByChat">;
  } = {},
) {
  const core = createFauxCore({ provider: `aiden-design-run-${Math.random().toString(36).slice(2)}` });
  core.setResponses(responses);
  const busy = new Set<string>();
  const harnesses: PiAgentRuntimeHarness[] = [];
  const stopped = new WeakSet<PiAgentRuntimeHarness>();
  const runs: Promise<void>[] = [];
  const state = { starts: 0, crashed: false, recoveryAtStart: [] as number[] };
  let pendingInitFailure = options.failAfterAccept;
  return {
    core,
    state,
    beginChatTurn(chatId: string, turnId: string, ownerId: string): ChatTurnLease | null {
      if (busy.has(chatId)) return null;
      busy.add(chatId);
      let active = true;
      const cleanups: Array<() => void> = [];
      const release = () => {
        if (!active) return;
        active = false;
        busy.delete(chatId);
        for (const cleanup of cleanups.splice(0)) cleanup();
      };
      return {
        chatId,
        ownerId,
        turnId,
        isActive: () => active,
        reserveAppendPayload: () => {},
        reserveSkillPreparation: () => {},
        prepareSkillInvocation: () => {},
        settleAsyncWork: () => {},
        onReleased: (cleanup) => {
          cleanups.push(cleanup);
        },
        release,
      };
    },
    async start(_streamId: string, params: { chatId: string }, _owner: ChatGenerationOwner, run: DesignGenerationOptions) {
      state.starts += 1;
      if (options.failStart) throw options.failStart;
      if (options.effects) {
        state.recoveryAtStart.push((await options.effects.listEffectsNeedingRecoveryByChat(params.chatId)).length);
      }
      run.onTurnAccepted();
      if (pendingInitFailure) {
        // llmClient accepts the turn before it resolves credentials, the model and the
        // harness; an initialization failure then releases its lease and throws.
        const failure = pendingInitFailure;
        pendingInitFailure = undefined;
        busy.delete(params.chatId);
        throw failure;
      }
      const profile = resolveGenerationProfile(
        { owner: { kind: "design-project", projectId: run.designRun.projectId } },
        run,
      );
      const harness = createGenerationHarness(profile, {
        convertToLlm,
        streamFn: core.streamSimple,
        initialState: { systemPrompt: "", thinkingLevel: "off", tools: [], messages: [], model: core.getModel() },
        extensions: [run.designRun.extension],
      });
      harnesses.push(harness);
      // llmClient's outcome: chat:cancel is "cancelled", an error response or a throw is "failed".
      const settle = (outcome: "completed" | "failed") => {
        if (!state.crashed) run.designRun.onSettled(stopped.has(harness) ? "cancelled" : outcome);
      };
      runs.push(
        harness
          .prompt("A calm pricing page")
          .then(
            () => {
              const last = harness.state.messages[harness.state.messages.length - 1];
              settle(last?.role === "assistant" && last.stopReason === "error" ? "failed" : "completed");
            },
            () => settle("failed"),
          )
          .finally(() => busy.delete(params.chatId)),
      );
      return true;
    },
    async settled() {
      await Promise.all(runs);
    },
    /** chat:cancel: the in-flight runs end and settle as cancelled. */
    stop() {
      for (const harness of harnesses) {
        stopped.add(harness);
        harness.abort();
      }
    },
    /** Process death: the in-flight runs end and nothing settles. */
    crash() {
      state.crashed = true;
      for (const harness of harnesses) harness.abort();
    },
  };
}

type FixtureOptions = { failStart?: Error; failAfterAccept?: Error; io?: DesignProjectStoreOptions["io"] };

async function fixture(t: TestContext, responses: FauxResponseStep[], options: FixtureOptions = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-run-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const chatDir = path.join(root, "chats");
  const designDir = path.join(root, "design-projects");
  const effectsDir = path.join(root, "pi-runtime-effects");
  await fs.mkdir(chatDir);
  await fs.mkdir(effectsDir);
  const chatStore = createChatStore(async () => chatDir);
  const chats = createDesignChatPort({ chatStore, remove: (chatId) => chatStore.remove(chatId) });
  let counter = 0;
  const newId = () => `id-${(counter += 1)}`;
  const events: DesignRunChangedEvent[] = [];
  /** One app process on this disk: project store, effect store, model and service. */
  const open = async (nextResponses: FauxResponseStep[], extra: FixtureOptions = {}) => {
    const store = new DesignProjectStore({
      root: async () => designDir,
      chats,
      newId,
      ...(extra.io ? { io: extra.io } : {}),
    });
    await store.initialize();
    const effects = new PiRuntimeEffectStore({ root: () => effectsDir });
    await effects.initialize();
    const generation = fakeGeneration(nextResponses, {
      effects,
      ...(extra.failStart ? { failStart: extra.failStart } : {}),
      ...(extra.failAfterAccept ? { failAfterAccept: extra.failAfterAccept } : {}),
    });
    const service = new DesignRunService({
      store,
      chats,
      effects,
      generation,
      notifyRunChanged: (event) => events.push(event),
      newId,
    });
    return { store, effects, generation, service };
  };
  const first = await open(responses, options);
  /** A relaunch after a crash: everything is reopened from disk with a fresh model. */
  const relaunch = (nextResponses: FauxResponseStep[]) => open(nextResponses);
  return { root, chatDir, designDir, chatStore, chats, events, newId, relaunch, ...first };
}

/** Explore 3: "Calm" is accepted and the second request is in flight. */
async function exploreUntilSecondRequest(f: Awaited<ReturnType<typeof fixture>>) {
  const project = await f.store.create({ title: "Pricing" });
  const first = await f.service.start(startInput(project.id, explore(3)));
  await waitFor(() => f.store.get(project.id)?.runs[first.runId!]?.revisionIds.length === 1, "the first design");
  await waitFor(() => f.generation.core.state.callCount === 2, "the second request");
  return { project, runId: first.runId! };
}

test("an Explore run accepts N designs, ends without a summary request and publishes them", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), turn(render("Bold")), turn(render("Dense")), fauxAssistantMessage("Summary.")]);
  const project = await f.store.create({ title: "Pricing" });
  const result = await f.service.start(startInput(project.id, explore(3)));
  assert.equal(result.accepted, true);
  assert.deepEqual([result.outputCap, result.model], [3, MODEL_A], "what the cost disclosure names");
  await f.generation.settled();
  await f.service.drain();
  const snapshot = f.store.get(project.id)!;
  assert.equal(snapshot.runs[result.runId!]!.status, "complete");
  assert.deepEqual(Object.values(snapshot.screens).map((screen) => screen.title).sort(), ["Bold", "Calm", "Dense"]);
  assert.ok(Object.values(snapshot.revisions).every((revision) => revision.state === "published" && revision.model.model === "model-a"));
  assert.equal(f.generation.core.state.callCount, 3);
  assert.equal(f.generation.core.getPendingResponseCount(), 1);
  assert.equal(f.events[f.events.length - 1]?.status, "complete");
  const chat = await f.chatStore.get(snapshot.chatId);
  assert.deepEqual(chat?.messages.map((message) => [message.role, message.content]), [["user", "A calm pricing page"]]);
});

test("the context budget refuses a run before any chat write or provider request", async (t) => {
  const big = `<main>${"x".repeat(150 * 1024)}</main>`;
  const f = await fixture(t, [turn(render("Big", big), render("Small")), fauxAssistantMessage("unused")]);
  const project = await f.store.create();
  await f.service.start(startInput(project.id, explore(2)));
  await f.generation.settled();
  await f.service.drain();
  const snapshot = f.store.get(project.id)!;
  const bigScreen = Object.values(snapshot.screens).find((screen) => screen.title === "Big")!;
  const callsBefore = f.generation.core.state.callCount;
  const messagesBefore = (await f.chatStore.get(snapshot.chatId))!.messages.length;
  const refused = await f.service.start(
    startInput(project.id, { op: "refine", screenId: bigScreen.id, baseRevisionId: bigScreen.activeRevisionId }),
  );
  assert.equal(refused.accepted, false);
  assert.match(refused.error ?? "", /too large/u);
  assert.equal(refused.runId, undefined);
  assert.equal(f.generation.core.state.callCount, callsBefore);
  assert.equal(f.generation.state.starts, 1);
  assert.equal((await f.chatStore.get(snapshot.chatId))!.messages.length, messagesBefore);
  assert.equal(Object.keys(f.store.get(project.id)!.runs).length, 1);
});

test("restart publishes an in-flight run's accepted designs as partial k/N and sends no provider request", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), untilAborted]);
  const { project, runId } = await exploreUntilSecondRequest(f);
  f.generation.crash();

  const next = await f.relaunch([fauxAssistantMessage("must never be requested")]);
  const snapshot = next.store.get(project.id)!;
  const run = snapshot.runs[runId]!;
  assert.deepEqual([run.status, run.endReason], ["partial", "interrupted"]);
  assert.equal(snapshot.revisions[run.revisionIds[0]!]!.state, "published");
  const set = snapshot.directionSets[run.directionSetId!]!;
  assert.deepEqual([set.screenIds.length, set.requestedCount], [1, 3], "k/N");
  assert.equal(next.store.list()[0]!.health, "interrupted");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(next.generation.state.starts, 0);
  assert.equal(next.generation.core.state.callCount, 0);
  assert.equal(f.generation.core.state.callCount, 2, "the crashed run sent nothing after the crash");
});

test("Resume after a restart sends one request turn for N − k, lists the k titles and completes the set", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), untilAborted]);
  const { project, runId } = await exploreUntilSecondRequest(f);
  f.generation.crash();

  let seen = "";
  const next = await f.relaunch([
    (context) => {
      seen = JSON.stringify(context.messages);
      return turn(render("Bold"), render("Dense"));
    },
    fauxAssistantMessage("unused"),
  ]);
  const resumed = await next.service.start(resumeInput(project.id, runId));
  assert.equal(resumed.accepted, true);
  assert.notEqual(resumed.runId, runId, "a Resume is a new run");
  assert.deepEqual([resumed.outputCap, resumed.model], [2, MODEL_A], "N − k, on the set's model by default");
  await next.generation.settled();
  await next.service.drain();

  assert.equal(next.generation.state.starts, 1);
  assert.equal(next.generation.core.state.callCount, 1, "one request turn");
  assert.match(seen, /Existing directions/u);
  assert.match(seen, /1\. \\"Calm\\"/u);
  assert.match(seen, /explore 2 more/u);
  const snapshot = next.store.get(project.id)!;
  assert.equal(snapshot.runs[resumed.runId!]!.status, "complete");
  assert.deepEqual([snapshot.runs[runId]!.status, snapshot.runs[runId]!.endReason], ["partial", "interrupted"]);
  const set = snapshot.directionSets[snapshot.runs[runId]!.directionSetId!]!;
  assert.deepEqual(set.screenIds.map((id) => snapshot.screens[id]!.title), ["Calm", "Bold", "Dense"]);
  assert.ok(Object.values(snapshot.revisions).every((revision) => revision.model.model === "model-a"));
  assert.equal(next.store.list()[0]!.health, "ok");
  const chat = await f.chatStore.get(snapshot.chatId);
  assert.deepEqual(
    chat?.messages.map((message) => [message.role, message.content]),
    [["user", "A calm pricing page"], ["user", "A calm pricing page"]],
    "the Resume turn repeats the brief on the same hidden chat",
  );
});

test("a Resume after a crash-dispatched render_artifact gets no do-not-repeat boundary", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), untilAborted]);
  const { project, runId } = await exploreUntilSecondRequest(f);
  // llmClient's effect ledger recorded a render_artifact dispatch whose result the crash lost.
  const operation = {
    operationId: "operation-1",
    runId: "pi-run-1",
    sessionId: `session-${project.chatId}`,
    chatId: project.chatId,
    lane: "foreground" as const,
    contributionRevision: 0,
  };
  const effect = {
    ...operation,
    effectId: "effect-1",
    turnId: "turn-render",
    toolCallId: "call-lost",
    toolName: "render_artifact",
    replay: "never" as const,
    arguments: { title: "Bold" },
  };
  await f.effects.startOperation(operation);
  await f.effects.prepareEffect(effect);
  await f.effects.markEffectDispatchStarted({ effectId: "effect-1", operationId: "operation-1", runId: "pi-run-1", chatId: project.chatId });
  f.generation.crash();

  const next = await f.relaunch([turn(render("Bold"), render("Dense")), fauxAssistantMessage("unused")]);
  assert.equal((await next.effects.listEffectsNeedingRecoveryByChat(project.chatId)).length, 1, "the restart left it unresolved");
  const resumed = await next.service.start(resumeInput(project.id, runId));
  assert.equal(resumed.accepted, true);
  await next.generation.settled();
  await next.service.drain();
  assert.deepEqual(next.generation.state.recoveryAtStart, [0], "the manifest, not the effect ledger, decides what Resume renders");
  assert.equal(next.store.get(project.id)!.runs[resumed.runId!]!.status, "complete");
});

test("Stop after k designs publishes them as partial k/N and sends nothing more", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), untilAborted, turn(render("never"))]);
  const { project, runId } = await exploreUntilSecondRequest(f);
  f.generation.stop();
  await f.generation.settled();
  await f.service.drain();
  const snapshot = f.store.get(project.id)!;
  const run = snapshot.runs[runId]!;
  assert.deepEqual([run.status, run.endReason], ["partial", "stopped"]);
  assert.equal(snapshot.revisions[run.revisionIds[0]!]!.state, "published");
  assert.equal(snapshot.directionSets[run.directionSetId!]!.screenIds.length, 1, "k = 1 of N = 3");
  assert.equal(f.generation.core.state.callCount, 2);
  assert.equal(f.generation.core.getPendingResponseCount(), 1);
  assert.equal(f.events[f.events.length - 1]?.status, "partial");
});

test("a provider error after k designs ends partial, and Resume completes the set", async (t) => {
  const f = await fixture(t, [
    turn(render("Calm")),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" }),
    turn(render("Bold"), render("Dense")),
    fauxAssistantMessage("unused"),
  ]);
  const project = await f.store.create();
  const first = await f.service.start(startInput(project.id, explore(3)));
  await f.generation.settled();
  await f.service.drain();
  const failed = f.store.get(project.id)!.runs[first.runId!]!;
  assert.deepEqual([failed.status, failed.endReason], ["partial", "provider_failed"]);

  const resumed = await f.service.start(resumeInput(project.id, first.runId!));
  assert.deepEqual([resumed.accepted, resumed.outputCap], [true, 2]);
  await f.generation.settled();
  await f.service.drain();
  const snapshot = f.store.get(project.id)!;
  assert.equal(snapshot.runs[resumed.runId!]!.status, "complete");
  assert.equal(snapshot.directionSets[failed.directionSetId!]!.screenIds.length, 3);
  assert.equal(f.generation.core.state.callCount, 3);
});

test("two concurrent Resumes of one run admit exactly one", async (t) => {
  const f = await fixture(t, [
    turn(render("Calm")),
    untilAborted,
    turn(render("Bold"), render("Dense")),
    fauxAssistantMessage("unused"),
  ]);
  const { project, runId } = await exploreUntilSecondRequest(f);
  f.generation.stop();
  await f.generation.settled();
  await f.service.drain();
  const startsBefore = f.generation.state.starts;
  const results = await Promise.all([
    f.service.start(resumeInput(project.id, runId)),
    f.service.start(resumeInput(project.id, runId)),
  ]);
  assert.deepEqual(results.map((result) => result.accepted).sort(), [false, true]);
  assert.equal(f.generation.state.starts - startsBefore, 1);
  await f.generation.settled();
  await f.service.drain();
  const snapshot = f.store.get(project.id)!;
  assert.equal(Object.keys(snapshot.runs).length, 2);
  assert.equal(snapshot.directionSets[snapshot.runs[runId]!.directionSetId!]!.screenIds.length, 3);
  assert.equal(f.generation.core.state.callCount, 3);
});

test("a crash between a revision file and the manifest leaves k unchanged, and Resume asks for N − k", async (t) => {
  const power = { failNext: false, dead: false, crash: () => {} };
  const f = await fixture(
    t,
    [
      turn(render("Calm")),
      () => {
        power.failNext = true;
        return turn(render("Bold"));
      },
      untilAborted,
    ],
    {
      io: {
        writeManifest: async (target, value, options) => {
          if (power.dead) throw new Error("process gone");
          if (power.failNext) {
            power.dead = true;
            power.crash();
            throw new Error("power lost");
          }
          await writeJsonAtomic(target, value, options);
        },
      },
    },
  );
  power.crash = () => f.generation.crash();
  const project = await f.store.create();
  const first = await f.service.start(startInput(project.id, explore(3)));
  await waitFor(() => power.dead, "the lost commit");
  const revisions = path.join(f.designDir, project.id, "revisions");
  assert.equal((await fs.readdir(revisions)).length, 2, "Bold's file landed before the commit point");

  const next = await f.relaunch([turn(render("Bold"), render("Dense")), fauxAssistantMessage("unused")]);
  assert.equal((await fs.readdir(revisions)).length, 1, "the orphan is collected");
  const run = next.store.get(project.id)!.runs[first.runId!]!;
  assert.deepEqual([run.status, run.endReason, run.revisionIds.length], ["partial", "interrupted", 1]);
  const resumed = await next.service.start(resumeInput(project.id, first.runId!));
  assert.equal(resumed.outputCap, 2, "the lost design is asked for again, never counted twice");
  await next.generation.settled();
  await next.service.drain();
  const snapshot = next.store.get(project.id)!;
  assert.deepEqual(
    snapshot.directionSets[run.directionSetId!]!.screenIds.map((id) => snapshot.screens[id]!.title),
    ["Calm", "Bold", "Dense"],
  );
});

test("a design chat stays out of listings and keeps its compaction journal across restart", async (t) => {
  const f = await fixture(t, []);
  const project = await f.store.create();
  const compactionRoot = path.join(f.root, "pi-compaction-sessions");
  await fs.mkdir(compactionRoot, { mode: 0o700 });
  const journal = await new PiCompactionSessionStore({ root: async () => compactionRoot }).openChat(project.chatId);
  await journal.appendMessage({ role: "user", content: "keep this design context", timestamp: 1 });

  const restartedChats = createChatStore(async () => f.chatDir);
  assert.equal((await restartedChats.listRegular()).some((chat) => chat.id === project.chatId), false);
  const kept = await reconcileChatScopedStores(restartedChats, [
    new PiCompactionSessionStore({ root: async () => compactionRoot }),
  ]);
  assert.equal(kept.has(project.chatId), true);
  assert.equal(await new PiCompactionSessionStore({ root: async () => compactionRoot }).hasChatHistory(project.chatId), true);
});

test("a second run on a busy project is refused without a provider request", async (t) => {
  const f = await fixture(t, [fauxAssistantMessage("unused")]);
  const project = await f.store.create();
  assert.ok(f.generation.beginChatTurn(project.chatId, "other-turn", "doc-2"));
  const refused = await f.service.start(startInput(project.id, explore(2)));
  assert.equal(refused.accepted, false);
  assert.match(refused.error ?? "", /already has a design run/u);
  assert.equal(f.generation.state.starts, 0);
  assert.deepEqual(f.store.get(project.id)!.runs, {});
});

test("a provider start that fails before accepting the turn records a failed run and frees the chat", async (t) => {
  const f = await fixture(t, [], { failStart: new Error("The selected model is unavailable.") });
  const project = await f.store.create();
  const result = await f.service.start(startInput(project.id, explore(2)));
  assert.equal(result.accepted, false);
  assert.match(result.error ?? "", /model is unavailable/u);
  assert.equal(f.store.get(project.id)!.runs[result.runId!]!.status, "failed");
  assert.equal(f.events[f.events.length - 1]?.status, "failed");
  assert.ok(f.generation.beginChatTurn(project.chatId, "next-turn", "doc-1"));
});

test("a start that fails after accepting the turn records a failed run, and the next run is admitted", async (t) => {
  const f = await fixture(t, [turn(render("Calm")), turn(render("Bold"))], {
    failAfterAccept: new Error("No credentials for openrouter."),
  });
  const project = await f.store.create();
  const failed = await f.service.start(startInput(project.id, explore(2)));
  assert.match(failed.error ?? "", /No credentials/u);
  const afterFailure = f.store.get(project.id)!;
  assert.equal(afterFailure.runs[failed.runId!]!.status, "failed");
  assert.deepEqual(afterFailure.directionSets, {}, "an empty direction set is not left behind");
  assert.deepEqual(f.events[f.events.length - 1], {
    projectId: project.id,
    runId: failed.runId,
    status: "failed",
    acceptedRevisionIds: [],
  });

  const next = await f.service.start(startInput(project.id, explore(2)));
  assert.equal(next.accepted, true, next.error);
  await f.generation.settled();
  await f.service.drain();
  assert.equal(f.store.get(project.id)!.runs[next.runId!]!.status, "complete");
});

test("the chat port finds a project's hidden chats by owner and never lists another project's", async (t) => {
  const f = await fixture(t, []);
  const project = await f.store.create();
  const other = await f.store.create();
  assert.deepEqual(await f.chats.ownedChatIds(project.id), [project.chatId]);
  assert.deepEqual(await f.chats.ownedChatIds(other.id), [other.chatId]);
  assert.deepEqual(await f.chats.ownedChatIds("no-such-project"), []);
});
