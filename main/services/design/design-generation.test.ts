import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createChatRunInputAdmission, type ChatRunInputGenerationRef } from "../chat-run-input-admission.js";
import { resolvePiAgentRuntimeStaticContributions } from "../pi-agent-runtime-harness.js";
import { appendPiMessages, PiCompactionSessionStore } from "../pi-compaction-session-store.js";
import { storedPiAssistantMessage } from "../pi-message-storage.js";
import { designGenerationWiring, designRunOutcome, type DesignGenerationEnd } from "./design-generation.js";
import { createDesignRenderExtension } from "./design-render-extension.js";
import type { DesignRunOutcome } from "./store-core.js";

const HTML = "<main><h1>Calm pricing</h1></main>";

function renderExtension() {
  return createDesignRenderExtension({
    request: { op: "explore", count: 2, creativeRange: "balanced", aspects: [] },
    cap: 2,
    contextText: "",
    existingTitles: [],
    accept: async () => ({ revisionId: "rev-1" }),
    revisionForToolCall: () => undefined,
  }).extension;
}

function renderTurn(): { message: AssistantMessage; callId: string } {
  const message = fauxAssistantMessage([fauxToolCall("render_artifact", { title: "Calm", html: HTML })], {
    stopReason: "toolUse",
  });
  const call = message.content.find((block) => block.type === "toolCall");
  assert.ok(call?.type === "toolCall");
  return { message, callId: call.id };
}

async function readTree(directory: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    parts.push(entry.isDirectory() ? await readTree(target) : await fs.readFile(target, "utf8"));
  }
  return parts.join("\n");
}

async function journalRoot(t: TestContext): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-design-journal-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "pi-compaction-sessions");
  await fs.mkdir(root, { mode: 0o700 });
  return root;
}

test("a design run's Pi journal keeps each render's call id and title on disk, never its HTML", async (t) => {
  const root = await journalRoot(t);
  const wiring = designGenerationWiring({ extension: renderExtension() }, appendPiMessages);
  const { message, callId } = renderTurn();
  const session = await new PiCompactionSessionStore({ root: async () => root }).openChat("chat-1");
  await wiring.journalAppend(session, [{ role: "user", content: "A calm pricing page", timestamp: 1 }, message], "visible-1");

  const persisted = await readTree(root);
  assert.equal(persisted.includes("<main>"), false, "no render HTML reaches the journal");
  assert.ok(persisted.includes(`[design html omitted: ${callId}]`));
  assert.ok(persisted.includes("Calm"), "the title stays for the next turn's context");
  assert.ok(persisted.includes("A calm pricing page"), "other messages are journaled unchanged");
  assert.ok(JSON.stringify(message).includes("<main>"), "the live message keeps its HTML");
});

test("the hidden chat's stored assistant message keeps the call id and title but no HTML", () => {
  const wiring = designGenerationWiring({ extension: renderExtension() }, appendPiMessages);
  const { message, callId } = renderTurn();
  const stored = JSON.stringify(storedPiAssistantMessage(wiring.storedAssistantMessage(message)));
  assert.equal(stored.includes("<main>"), false);
  assert.ok(stored.includes(`[design html omitted: ${callId}]`));
  assert.ok(stored.includes("Calm"));
});

test("a design run composes its render extension alone, under no Aiden system prompt", () => {
  const extension = renderExtension();
  const wiring = designGenerationWiring({ extension }, appendPiMessages);
  const composed = resolvePiAgentRuntimeStaticContributions(wiring.baseSystemPrompt, [], wiring.extensions);
  assert.equal(composed.systemPrompt, extension.systemPrompt?.trim(), "the design prompt is the whole prompt");
  assert.deepEqual(
    composed.tools.map((tool) => tool.name),
    ["render_artifact"],
  );
});

test("a design run's generation refuses steer and queued follow-ups", async () => {
  const wiring = designGenerationWiring({ extension: renderExtension() }, appendPiMessages);
  const appended: string[] = [];
  const generation: ChatRunInputGenerationRef = {
    chatId: "chat-1",
    owner: { documentId: "doc-1" },
    cancelRequested: false,
    inputClosed: wiring.inputClosed,
    agent: {
      queueAdmissionBlocked: () => undefined,
      queueSteer: () => assert.fail("a design run takes no steer"),
      queueFollowUp: () => assert.fail("a design run takes no follow-up"),
    },
  };
  const admission = createChatRunInputAdmission({
    active: new Map([["stream-1", generation]]),
    isChatDeleting: () => false,
    appendMessage: async (chatId) => {
      appended.push(chatId);
      throw new Error("nothing may be appended");
    },
    readChat: async () => null,
  });
  for (const mode of ["steer", "queue"] as const) {
    assert.deepEqual(
      await admission.admit({ streamId: "stream-1", mode, text: "make it blue", ownerDocumentId: "doc-1" }),
      { admitted: false, reason: "run_not_active", committed: false },
      mode,
    );
  }
  assert.deepEqual(appended, []);
});

test("a finished design generation reports the outcome its end reason needs", () => {
  const ended = (overrides: Partial<DesignGenerationEnd>): DesignGenerationEnd => ({
    runtimeKind: "completed",
    emergency: false,
    cancelled: false,
    persistenceFailed: false,
    ...overrides,
  });
  const cases: Array<[string, DesignGenerationEnd, DesignRunOutcome]> = [
    ["the model stopped on its own", ended({}), "completed"],
    ["a provider failure", ended({ runtimeKind: "provider_failed" }), "failed"],
    ["a failure in Aiden's runtime", ended({ runtimeKind: "host_failed" }), "host_failed"],
    ["an emergency context projection", ended({ emergency: true }), "host_failed"],
    ["a user Stop", ended({ runtimeKind: "app_cancelled", cancelled: true, cancellationOrigin: "user_stop" }), "cancelled"],
    [
      "an app quit",
      ended({ runtimeKind: "app_cancelled", cancelled: true, cancellationOrigin: "application_shutdown" }),
      "interrupted",
    ],
    ["a reply that could not be saved", ended({ persistenceFailed: true }), "host_failed"],
    [
      "a Stop whose partial reply could not be saved",
      ended({ runtimeKind: "app_cancelled", cancelled: true, cancellationOrigin: "user_stop", persistenceFailed: true }),
      "cancelled",
    ],
    ["a provider failure after a Stop", ended({ runtimeKind: "provider_failed", cancelled: true }), "failed"],
  ];
  for (const [label, input, expected] of cases) {
    assert.equal(designRunOutcome(input), expected, label);
  }
});
