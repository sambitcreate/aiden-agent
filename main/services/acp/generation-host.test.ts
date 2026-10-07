import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";

import type { GenerationTimeline } from "../../../renderer/shared/generation-timeline.js";
import { GenerationTimelineProjector } from "../generation-timeline.js";
import type { ToolApprovalOutcome } from "../tool-approval.js";
import { canHostAcpHarness, createAcpGenerationHost, questionFor, type AcpGenerationHostOptions } from "./generation-host.js";

function setup(overrides: Partial<AcpGenerationHostOptions> = {}, outcome: ToolApprovalOutcome = "allowed", scope?: "once" | "chat") {
  let latest: GenerationTimeline | undefined;
  const timeline = new GenerationTimelineProjector("stream-1", (snapshot) => {
    latest = snapshot;
  });
  const prompts: Array<{ toolCallId: string; toolName: string; summary: string; scopes?: readonly string[] }> = [];
  const host = createAcpGenerationHost({
    chatId: "chat-1",
    streamId: "stream-1",
    label: "Google Antigravity",
    folderPath: "/work/project",
    scratchDir: "/scratch",
    permission: () => "ask",
    timeline,
    requestApproval: async (prompt) => {
      prompts.push(prompt);
      return outcome;
    },
    takeApprovalScope: () => scope,
    ...overrides,
  });
  return { host, prompts, timeline: () => latest };
}

const signal = new AbortController().signal;

test("native activity becomes labelled, persisted timeline steps", () => {
  const { host, timeline } = setup();
  host.activity.started("acp:s:1", "edit_file", { path: "src/app.ts" });
  host.activity.running("acp:s:1");
  host.activity.finished("acp:s:1", "completed", { kind: "file_line_changes", version: 1, additions: 3, deletions: 1 });
  host.activity.started("acp:s:2", "delete_file", { path: "old.ts" });
  host.activity.finished("acp:s:2", "failed");
  const steps = timeline()!.steps.filter((step) => step.kind === "tool");
  assert.deepEqual(
    steps.map((step) => step.kind === "tool" && [step.label, step.target, step.status, step.lineChanges]),
    [
      ["Edit file", "src/app.ts", "completed", { additions: 3, deletions: 1 }],
      ["Delete file", "old.ts", "failed", undefined],
    ],
  );
});

test("an approval waits on Aiden's card and maps the chosen scope to the agent's options", async () => {
  const once = setup(undefined, "allowed", "once");
  once.host.activity.started("acp:s:1", "run_command", {});
  const answer = await once.host.requestApproval(
    { toolCallId: "1", activityId: "acp:s:1", kind: "command", title: "npm test", paths: [], offersAlways: true },
    signal,
  );
  assert.equal(answer, "allow_once");
  assert.equal(once.prompts[0]?.toolName, "run_command");
  assert.equal(once.prompts[0]?.toolCallId, "call-1", "the card is keyed to the visible activity row");
  assert.deepEqual(once.prompts[0]?.scopes, ["once", "chat"]);
  assert.match(once.prompts[0]?.summary ?? "", /^Google Antigravity wants to run a command: npm test$/u);
  const first = once.timeline()?.steps[0];
  assert.equal(first?.kind === "tool" ? first.status : undefined, "running");

  const chat = setup(undefined, "allowed", "chat");
  assert.equal(
    await chat.host.requestApproval({ toolCallId: "2", kind: "file_change", title: "Edit", paths: ["a.ts"], warning: "Injected?", offersAlways: true }, signal),
    "allow_always",
  );
  assert.match(chat.prompts[0]?.summary ?? "", /Files: a\.ts\nWarning from Google Antigravity: Injected\?/u);

  assert.equal(await setup(undefined, "denied").host.requestApproval({ toolCallId: "3", kind: "command", title: "x", paths: [], offersAlways: false }, signal), "reject");
  assert.equal(await setup(undefined, "detached").host.requestApproval({ toolCallId: "4", kind: "command", title: "x", paths: [], offersAlways: false }, signal), "cancelled");
  assert.equal(setup(undefined, "denied").prompts[0]?.scopes, undefined);
});

test("agent questions use the question prompt; custom or skipped answers are no answer", async () => {
  const question = { title: "Which color?", options: [{ id: "r", label: "Red" }, { id: "b", label: "Blue" }] };
  const answers = [
    { response: { version: 1 as const, promptId: "p", cancelled: false, answers: [{ questionIndex: 0, kind: "option" as const, answer: "Blue" }] }, expected: "b" },
    { response: { version: 1 as const, promptId: "p", cancelled: false, answers: [{ questionIndex: 0, kind: "custom" as const, answer: "Green" }] }, expected: undefined },
    { response: { version: 1 as const, promptId: "p", cancelled: true, answers: [] }, expected: undefined },
  ];
  for (const { response, expected } of answers) {
    const { host } = setup({ requestQuestion: async () => response });
    assert.equal(await host.askQuestion!(question, signal), expected);
  }
  assert.equal(questionFor({ title: "Only one", options: [{ id: "a", label: "A" }] }), undefined);
  assert.equal(questionFor({ title: "Many", options: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id })) })?.options.length, 4);
});

test("tools the agent already has are not bridged; Aiden-only tools are", () => {
  const { host } = setup();
  const tool = (name: string) => ({ name, description: name, parameters: Type.Object({}) });
  assert.deepEqual(
    host.bridgeableTools([tool("run_command"), tool("edit_file"), tool("browser_open"), tool("todo"), tool("grep")]).map((entry) => entry.name),
    ["browser_open", "todo"],
  );
});

test("folderless or no-access chats give the agent a scratch directory and no file roots", () => {
  assert.deepEqual(setup().host.roots, ["/work/project"]);
  const folderless = setup({ folderPath: undefined }).host;
  assert.equal(folderless.cwd, "/scratch");
  assert.deepEqual(folderless.roots, []);
  assert.deepEqual(setup({ permission: () => "none" }).host.roots, []);
});

test("a context rebuild notice is a visible, completed activity row", () => {
  const { host, timeline } = setup();
  host.notice?.("rebuilt");
  const step = timeline()!.steps[0];
  assert.ok(step?.kind === "tool");
  assert.equal(step.label, "Started a fresh agent session from this chat");
  assert.equal(step.status, "completed");
});

test("only attended desktop chats may host an agent harness", () => {
  const attended = { rendererOwner: true, remoteOwner: false, bot: false, assistant: false };
  assert.equal(canHostAcpHarness(attended), true);
  assert.equal(canHostAcpHarness({ ...attended, usageSource: "chat", interactionSurface: "desktop" }), true);
  for (const blocked of [
    { rendererOwner: false },
    { remoteOwner: true },
    { bot: true },
    { assistant: true },
    { usageSource: "scheduled" },
    { interactionSurface: "telegram" },
  ]) {
    assert.equal(canHostAcpHarness({ ...attended, ...blocked }), false, JSON.stringify(blocked));
  }
});
