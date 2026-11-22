import assert from "node:assert/strict";
import { test } from "node:test";
import {
  argIs, chatToolOffers, offersChildChats, screenedPromptAnswersPerson, chatTurnArgsToolRefusal, chatTurnAudienceFor, chatTurnToolRefusal, declaresAppTools, declaresWindowTools, firstTurnToolRefusal, windowlessChatTurn,
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

test("a check-back is set only in a turn the person started; list and cancel work in every turn", () => {
  const cases: Array<[string, ChatTurnAudienceOptions, boolean]> = [
    // label, the turn's options, may set
    ["a turn in the chat's window", {}, true],
    ["a phone- or paired-Mac-sent turn", { visualAudience: "remote" }, true],
    ["an unattended follow-up (a check-back firing)", { ...UNATTENDED_FOLLOW_UP_GENERATION }, false],
    ["an owed turn answering a notice, with no window", { windowless: true }, false],
    ["an owed turn answering the person's queued message", { windowless: true, answersPerson: true }, true],
    ["an unattended follow-up never counts as the person's", { ...UNATTENDED_FOLLOW_UP_GENERATION, windowless: true, answersPerson: true }, false],
    ["a goal round", { goalRound: true }, false],
  ];
  for (const [label, options, maySet] of cases) {
    // Run the way a turn runs them: the name-only refusal first, then the args-aware one.
    const turn = chatTurnAudienceFor(options, {});
    const refuse = firstTurnToolRefusal([chatTurnToolRefusal(workspace, turn), chatTurnArgsToolRefusal(turn)]);
    const reason = refuse("check_back", { action: "set", in_minutes: 10, note: "look again" });
    if (maySet) assert.equal(reason, undefined, label);
    else assert.match(reason ?? "", /^check_back cannot set a check-back in this turn: Aiden started it/u, label);
    assert.equal(refuse("check_back", { action: "list" }), undefined, label);
    assert.equal(refuse("check_back", { action: "cancel", id: "cb_1" }), undefined, label);
    // The same arguments on another tool are not this rule's business.
    assert.equal(refuse("wake_up", { action: "set" }), undefined, label);
  }
  // Arguments the model sent malformed are left for the tool's own validation.
  const woken = chatTurnArgsToolRefusal(chatTurnAudienceFor({ unattended: true }, {}));
  assert.equal(woken("check_back", null), undefined);
  assert.equal(woken("check_back", ["set"]), undefined);
});

test("child_chats starts chats only in a turn the person started; its other actions work in every turn", () => {
  const cases: Array<[string, ChatTurnAudienceOptions, boolean]> = [
    // label, the turn's options, may start
    ["a turn in the chat's window", {}, true],
    ["a phone- or paired-Mac-sent turn", { visualAudience: "remote" }, true],
    ["an unattended follow-up (a woken lead)", { ...UNATTENDED_FOLLOW_UP_GENERATION }, false],
    ["an owed turn with no window", { windowless: true }, false],
    ["a goal round", { goalRound: true }, false],
  ];
  for (const [label, options, mayStart] of cases) {
    const turn = chatTurnAudienceFor(options, {});
    const refuse = firstTurnToolRefusal([chatTurnToolRefusal(workspace, turn), chatTurnArgsToolRefusal(turn)]);
    const reason = refuse("child_chats", { action: "start", chats: [{ title: "Docs", task: "Update the docs" }] });
    if (mayStart) assert.equal(reason, undefined, label);
    else assert.match(reason ?? "", /^child_chats cannot start chats in this turn: starting chats needs the person here/u, label);
    for (const action of ["list", "read", "wait", "send", "stop"]) {
      assert.equal(refuse("child_chats", { action, chat_id: "c1", chat_ids: ["c1"], text: "go on" }), undefined, `${label}: ${action}`);
    }
  }
});

test("an args-aware rule is one row: a tool, which turns, which arguments and a reason", () => {
  const refuse = chatTurnArgsToolRefusal(chatTurnAudienceFor({ goalRound: true }, {}), [
    { tool: "subagent", turns: (turn) => turn.goalRound === true, args: argIs("execution", "background"), reason: "no background helpers in a goal round" },
  ]);
  assert.equal(refuse("subagent", { execution: "background" }), "no background helpers in a goal round");
  assert.equal(refuse("subagent", { execution: "foreground" }), undefined);
  assert.equal(refuse("subagent", {}), undefined);
  const attended = chatTurnArgsToolRefusal(chatTurnAudienceFor({}, {}), [
    { tool: "subagent", turns: (turn) => turn.goalRound === true, args: argIs("execution", "background"), reason: "x" },
  ]);
  assert.equal(attended("subagent", { execution: "background" }), undefined, "the rule applies only to the turns it names");
});

test("a queued turn answers the person only when its screened prompt is the person's own message", () => {
  const messages = [
    { id: "person", role: "user" },
    { id: "notice", role: "user", notice: { version: 1, source: "check_back", tone: "info", title: "Check-back", summary: "Now" } },
    { id: "reply", role: "assistant" },
  ];
  assert.equal(screenedPromptAnswersPerson(messages, { messageId: "person" }), true);
  // A notice wakes the chat; it is not the person asking.
  assert.equal(screenedPromptAnswersPerson(messages, { messageId: "notice" }), false);
  assert.equal(screenedPromptAnswersPerson(messages, { messageId: "reply" }), false);
  assert.equal(screenedPromptAnswersPerson(messages, { messageId: "gone" }), false);
  assert.equal(screenedPromptAnswersPerson(messages, undefined), false);
});

test("child_chats is offered to a workspace chat nobody started, never to a started chat, an unreadable one or an outside app's turn", () => {
  const offer = {
    followThroughAvailable: true,
    workspace: true,
    lineage: {},
    enabled: true,
    hostSupports: true,
  };
  assert.equal(offersChildChats(offer), true);
  assert.equal(
    offersChildChats({ ...offer, lineage: { startedBy: { version: 1, kind: "chat", chatId: "lead-1", at: 1 } } }),
    false,
    "a started chat can't start chats",
  );
  assert.equal(offersChildChats({ ...offer, lineage: undefined }), false, "a chat whose record can't be read");
  assert.equal(offersChildChats({ ...offer, excludedToolNames: new Set(["child_chats"]) }), false, "an outside MCP app's turn");
  assert.equal(offersChildChats({ ...offer, excludedToolNames: new Set(["ask_user_question"]) }), true);
  assert.equal(offersChildChats({ ...offer, enabled: false }), false);
  assert.equal(offersChildChats({ ...offer, workspace: false }), false);
});
