import assert from "node:assert/strict";
import { test } from "node:test";
import { chatToolOffers, chatTurnToolRefusal, type ChatToolSurface, type ChatTurnAudience } from "./chat-turn-tool-policy.js";
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
  for (const name of ["hooks", "computer_use", "form_fill", "workspace_artifact", "render_artifact", "render_ui", "read_file"]) {
    assert.equal(refuse(name), undefined, name);
  }
});

test("an unattended follow-up refuses what needs someone watching, and says why", () => {
  const refuse = chatTurnToolRefusal(
    { ...workspace, usageSource: UNATTENDED_FOLLOW_UP_GENERATION.usageSource },
    { ...attended, unattended: UNATTENDED_FOLLOW_UP_GENERATION.unattended },
  );
  for (const name of ["hooks", "computer_use", "form_fill"]) {
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
});

test("inline visuals On request draw only in a /visualize turn", () => {
  const plain = chatTurnToolRefusal(workspace, { ...attended, inlineVisuals: "on_request" });
  assert.match(plain("render_ui") ?? "", /not available in this turn.*\/visualize/su);
  assert.match(plain("render_artifact") ?? "", /not available in this turn.*\/visualize/su);
  const visualize = chatTurnToolRefusal(workspace, { ...attended, inlineVisuals: "on_request", visualize: true });
  assert.equal(visualize("render_ui"), undefined);
  assert.equal(visualize("render_artifact"), undefined);
});
