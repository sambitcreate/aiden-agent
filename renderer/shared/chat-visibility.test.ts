import assert from "node:assert/strict";
import test from "node:test";
import { chatRunRefusal, chatSurface, isUserVisibleChat, parseChatOwnerV1 } from "./chat-visibility.js";

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

test("a Bot identity cannot override ownership, and an Assistant workspace chat with a Bot stays a Bot", () => {
  assert.equal(chatSurface({ workspaceId: "workspace-1", botId: "bot-1", owner }), "feature");
  assert.equal(isUserVisibleChat({ botId: "bot-1", owner }), false);
  assert.equal(chatSurface({ workspaceId: "assistant", botId: "bot-1" }), "bot");
});

test("the owner project id is bounded to 128 characters and must start with a letter or digit", () => {
  const longest = `a${"b".repeat(127)}`;
  assert.deepEqual(parseChatOwnerV1({ kind: "design-project", projectId: longest }), {
    kind: "design-project",
    projectId: longest,
  });
  assert.deepEqual(parseChatOwnerV1({ kind: "design-project", projectId: "9a.b-c_d" }), {
    kind: "design-project",
    projectId: "9a.b-c_d",
  });
  for (const projectId of [".hidden", "-flag", "_under", "a/b", "a b", "a\nb", `a${"b".repeat(128)}`]) {
    assert.equal(
      parseChatOwnerV1({ kind: "design-project", projectId }),
      undefined,
      JSON.stringify(projectId),
    );
  }
});

test("a feature-owned chat is refused as an ordinary agent run, with the retired-feature message", () => {
  const message = "This conversation belongs to a feature that is no longer available.";
  assert.equal(chatRunRefusal({ workspaceId: "workspace-1", owner }), message);
  // Ownership still wins when the chat also names the Assistant workspace.
  assert.equal(chatRunRefusal({ workspaceId: "assistant", owner }), message);
});

test("ordinary, Assistant, Bot and legacy chats may run", () => {
  assert.equal(chatRunRefusal({ workspaceId: "workspace-1" }), null);
  assert.equal(chatRunRefusal({}), null);
  assert.equal(chatRunRefusal({ workspaceId: "assistant" }), null);
  assert.equal(chatRunRefusal({ workspaceId: "workspace-1", botId: "bot-1" }), null);
});

test("a malformed owner the parser rejects still refuses the run: fail closed", () => {
  // The store never loads such a chat (its meta fails validation), but the run
  // guard must not depend on that: any present owner refuses.
  for (const malformed of [{ kind: "bot", projectId: "project-1" }, { kind: "design-project" }, "design-project", null]) {
    assert.equal(parseChatOwnerV1(malformed), undefined, JSON.stringify(malformed));
    const chat = { workspaceId: "workspace-1", owner: malformed } as unknown as Parameters<typeof chatRunRefusal>[0];
    assert.notEqual(chatRunRefusal(chat), null, JSON.stringify(malformed));
  }
});
