import assert from "node:assert/strict";
import test from "node:test";
import { chatSurface, isUserVisibleChat, parseChatOwnerV1 } from "./chat-visibility.js";

const owner = { kind: "design-project", projectId: "project-1" } as const;

test("feature ownership wins over every other chat identity", () => {
  assert.equal(chatSurface({ workspaceId: "workspace-1", owner }), "feature");
  assert.equal(chatSurface({ workspaceId: "assistant", owner }), "feature");
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1", owner }), false);
});

test("bots, the Assistant workspace and legacy chats keep their existing surfaces", () => {
  assert.equal(chatSurface({ workspaceId: "workspace-1" }), "regular");
  // Legacy chats without a workspace belong to the default workspace.
  assert.equal(chatSurface({}), "regular");
  assert.equal(chatSurface({ workspaceId: "assistant" }), "assistant");
  assert.equal(chatSurface({ workspaceId: "workspace-1", botId: "bot-1" }), "bot");
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1" }), true);
  assert.equal(isUserVisibleChat({ workspaceId: "assistant" }), false);
  assert.equal(isUserVisibleChat({ workspaceId: "workspace-1", botId: "bot-1" }), false);
});

test("the owner parser accepts only the exact design-project shape", () => {
  assert.deepEqual(parseChatOwnerV1(owner), owner);
  for (const value of [
    undefined,
    null,
    "design-project",
    [],
    { kind: "design-project" },
    { kind: "bot", projectId: "project-1" },
    { kind: "design-project", projectId: "" },
    { kind: "design-project", projectId: "../escape" },
    { kind: "design-project", projectId: "x".repeat(129) },
    { ...owner, extra: true },
  ]) {
    assert.equal(parseChatOwnerV1(value), undefined, JSON.stringify(value));
  }
});
