import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chatToolOffers, chatTurnAudienceFor, chatTurnToolRefusal, declaresAppTools, declaresWindowTools, firstTurnToolRefusal, windowlessChatTurn,
  type ChatToolSurface, type ChatTurnOwnerScope, type ChatTurnAudience, type ChatTurnAudienceOptions, type ChatTurnAudienceParams,
} from "./chat-turn-tool-policy.js";
import { UNATTENDED_FOLLOW_UP_GENERATION } from "./follow-through/notice-delivery.js";

const workspace: ChatToolSurface = { usageSource: "chat", bot: false, assistant: false, harnessProvider: false };
const attended: ChatTurnAudience = { unattended: false, remoteAudience: false, visualize: false };

test("the chat's declarations depend on the chat alone", () => {
  assert.deepEqual(chatToolOffers(workspace), { hooks: true });
  // Hooks belong to workspace chats; Bots, routines and Telegram never declare them.
  assert.deepEqual(chatToolOffers({ ...workspace, bot: true }), { hooks: false });
  assert.deepEqual(chatToolOffers({ ...workspace, usageSource: "schedule" }), { hooks: false });
  assert.deepEqual(chatToolOffers({ ...workspace, interactionSurface: "telegram" }), { hooks: false });
  assert.deepEqual(chatToolOffers({ ...workspace, excludedToolNames: new Set(["hooks"]) }), { hooks: false });
});

test("an attended turn on this computer refuses nothing", () => {
  const refuse = chatTurnToolRefusal(workspace, { ...attended, inlineVisuals: "automatic" });
  for (const name of ["hooks", "computer_use", "form_fill", "subagent", "ask_user_question", "workspace_artifact", "render_artifact", "render_ui", "read_file"]) {
    assert.equal(refuse(name), undefined, name);
  }
});

test("an unattended follow-up refuses what needs someone watching, and says why", () => {
  const refuse = chatTurnToolRefusal(
    { ...workspace, usageSource: UNATTENDED_FOLLOW_UP_GENERATION.usageSource },
    { ...attended, unattended: UNATTENDED_FOLLOW_UP_GENERATION.unattended },
  );
  for (const name of ["hooks", "computer_use", "form_fill", "subagent"]) {
    assert.match(refuse(name) ?? "", new RegExp(`^${name} is not available in this turn: nobody is watching this follow-up`, "u"), name);
  }
  assert.equal(refuse("workspace_artifact"), undefined, "a follow-up's artifact still shows on this computer");
  assert.equal(refuse("read_file"), undefined);
});

test("a turn from a paired device refuses what only this computer can show or approve", () => {
  const refuse = chatTurnToolRefusal(workspace, { ...attended, remoteAudience: true });
  assert.match(refuse("workspace_artifact") ?? "", /not available in this turn: the request came from a paired device/u);
  assert.match(refuse("hooks") ?? "", /not available in this turn.*paired device/su);
  for (const name of ["computer_use", "form_fill"]) {
    assert.match(refuse(name) ?? "", /not available in this turn: the request came from a paired device, and Computer Use is granted only on this computer/u, name);
  }
  assert.equal(refuse("ask_user_question"), undefined, "a device that shows question prompts answers them");
});

test("a paired device that cannot show question prompts has the question call refused", () => {
  const refuse = chatTurnToolRefusal(workspace, { ...attended, remoteAudience: true, questionPromptsUnavailable: true });
  assert.match(refuse("ask_user_question") ?? "", /^ask_user_question is not available in this turn: the paired device that sent it cannot show question prompts/u);
  assert.equal(refuse("read_file"), undefined);
});

test("inline visuals On request draw only in a /visualize turn", () => {
  const plain = chatTurnToolRefusal(workspace, { ...attended, inlineVisuals: "on_request" });
  assert.match(plain("render_ui") ?? "", /not available in this turn.*\/visualize/su);
  assert.match(plain("render_artifact") ?? "", /not available in this turn.*\/visualize/su);
  const visualize = chatTurnToolRefusal(workspace, { ...attended, inlineVisuals: "on_request", visualize: true });
  assert.equal(visualize("render_ui"), undefined);
  assert.equal(visualize("render_artifact"), undefined);
});

test("a generation's options and parameters decide which calls the turn refuses", () => {
  const names = ["hooks", "computer_use", "form_fill", "subagent", "ask_user_question", "workspace_artifact", "render_ui", "render_artifact", "read_file"];
  const cases: Array<{ label: string; options: ChatTurnAudienceOptions; params: ChatTurnAudienceParams; refused: string[] }> = [
    { label: "an attended turn on this computer", options: {}, params: {}, refused: [] },
    { label: "an unattended follow-up", options: { unattended: true }, params: {}, refused: ["hooks", "computer_use", "form_fill", "subagent"] },
    { label: "a paired device", options: { visualAudience: "remote" }, params: {}, refused: ["hooks", "computer_use", "form_fill", "workspace_artifact"] },
    {
      label: "a paired device that cannot show question prompts",
      options: { visualAudience: "remote", questionPromptsUnavailable: true }, params: {},
      refused: ["hooks", "computer_use", "form_fill", "ask_user_question", "workspace_artifact"],
    },
    { label: "inline visuals On request without /visualize", options: {}, params: { inlineVisuals: "on_request" }, refused: ["render_ui", "render_artifact"] },
    { label: "inline visuals On request with /visualize", options: {}, params: { inlineVisuals: "on_request", visualize: true }, refused: [] },
    { label: "automatic inline visuals", options: {}, params: { inlineVisuals: "automatic" }, refused: [] },
    {
      label: "a paired device with inline visuals On request",
      options: { visualAudience: "remote" }, params: { inlineVisuals: "on_request" },
      refused: ["hooks", "computer_use", "form_fill", "workspace_artifact", "render_ui", "render_artifact"],
    },
  ];
  for (const { label, options, params, refused } of cases) {
    const refuse = chatTurnToolRefusal(workspace, chatTurnAudienceFor(options, params));
    assert.deepEqual(names.filter((name) => refuse(name) !== undefined), refused, label);
  }
});

test("several turn refusals give the first reason that applies", () => {
  const late: Array<(name: string, args: unknown) => string | undefined> = [(name) => name === "a" ? "first" : undefined];
  const refuse = firstTurnToolRefusal(late);
  late.push((name) => name === "a" || name === "b" ? "second" : undefined);
  assert.equal(refuse("a", {}), "first");
  assert.equal(refuse("b", {}), "second", "a refusal added after the combination still applies");
  assert.equal(refuse("c", {}), undefined);
});

test("a chat turn main starts with no window refuses every call that needs one, including tools named later", () => {
  const windowOnlyToolNames = new Set<string>();
  const refuse = chatTurnToolRefusal(workspace, { ...chatTurnAudienceFor({ windowless: true }, {}), windowOnlyToolNames });
  for (const name of ["computer_use", "form_fill", "hooks", "ask_user_question", "todo", "advisor"]) {
    assert.match(refuse(name) ?? "", new RegExp(`^${name} is not available in this turn: .*no window owns it`, "u"), name);
  }
  assert.equal(refuse("browser_open"), undefined, "a runtime tool is refused once the turn names it");
  windowOnlyToolNames.add("browser_open");
  assert.match(refuse("browser_open") ?? "", /no window owns it/u);
  for (const name of ["read_file", "workspace_artifact", "subagent", "render_artifact"]) {
    assert.equal(refuse(name), undefined, name);
  }
});

test("only a workspace chat turn with no window and no paired device is windowless", () => {
  const owed: ChatTurnOwnerScope = { window: false, remote: false, usageSource: "chat", assistantMode: false, botBound: false };
  const cases: Array<[string, ChatTurnOwnerScope, boolean, boolean]> = [
    // label, scope, windowless, declares the window's tools
    ["an owed turn or a follow-up", owed, true, true],
    ["a turn in the chat's window", { ...owed, window: true }, false, true],
    ["a paired device's turn", { ...owed, remote: true }, false, false],
    ["a scheduled run", { ...owed, usageSource: "scheduled" }, false, false],
    ["a Telegram turn", { ...owed, interactionSurface: "telegram" }, false, false],
    ["an Assistant turn", { ...owed, assistantMode: true }, false, false],
    ["a Bot turn", { ...owed, botBound: true }, false, false],
  ];
  for (const [label, scope, windowless, declares] of cases) {
    assert.equal(windowlessChatTurn(scope), windowless, label);
    assert.equal(declaresWindowTools(scope), declares, label);
  }
});

test("Aiden's settings and scheduling tools are declared only for a turn a person can attend and that may schedule", () => {
  const owed: ChatTurnOwnerScope = { window: false, remote: false, usageSource: "chat", assistantMode: false, botBound: false };
  const may = { attendedAssistant: false, schedulingAllowed: true };
  const cases: Array<[string, ChatTurnOwnerScope, { attendedAssistant: boolean; schedulingAllowed: boolean }, boolean]> = [
    ["a turn in the chat's window", { ...owed, window: true }, may, true],
    ["a paired device's turn", { ...owed, remote: true }, may, true],
    // Declared like the window's turn, and every call refused.
    ["an owed turn or a follow-up", owed, may, true],
    ["a scheduled run with no window", { ...owed, usageSource: "scheduled" }, may, false],
    ["a turn that may not schedule", { ...owed, window: true }, { ...may, schedulingAllowed: false }, false],
    ["a Bot turn", { ...owed, window: true, botBound: true }, may, false],
    ["a Telegram turn", { ...owed, remote: true, interactionSurface: "telegram" }, may, false],
    ["an unattended Assistant turn", { ...owed, window: true, assistantMode: true }, may, false],
    ["an attended Assistant turn", { ...owed, window: true, assistantMode: true }, { ...may, attendedAssistant: true }, true],
  ];
  for (const [label, scope, turn, declares] of cases) assert.equal(declaresAppTools(scope, turn), declares, label);
});
