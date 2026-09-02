import assert from "node:assert/strict";
import test from "node:test";
import {
  agentReturnTarget,
  designProjectIdFromPath,
  parseRememberedDesignProject,
  parseShellMode,
  shellModeForPath,
} from "./shell-mode.js";

test("route authority selects Design without changing shared Profile mode", () => {
  assert.equal(shellModeForPath("/design", "agent"), "design");
  assert.equal(shellModeForPath("/design/project%3Aone", "agent"), "design");
  assert.equal(shellModeForPath("/chat/chat-one", "design"), "agent");
  assert.equal(shellModeForPath("/profile", "design"), "design");
  assert.equal(shellModeForPath("/profile", "agent"), "agent");
  assert.equal(parseShellMode("unknown"), "agent");
});

test("Agent restoration accepts only known shell destinations", () => {
  assert.equal(agentReturnTarget("/chat/chat-one"), "/chat/chat-one");
  assert.equal(agentReturnTarget("/scheduled"), "/scheduled");
  assert.equal(agentReturnTarget("/bots/bot-one/chat/chat-one"), "/bots/bot-one/chat/chat-one");
  assert.equal(agentReturnTarget("/bots/bot-one"), "/bots/bot-one");
  assert.equal(agentReturnTarget("/bots/bot-one/unknown"), "/");
  assert.equal(agentReturnTarget("/bots/%"), "/");
  assert.equal(agentReturnTarget("/design/project:one"), "/");
  assert.equal(agentReturnTarget("https://example.com"), "/");
});

test("Design restoration keeps one bounded project identity", () => {
  assert.equal(designProjectIdFromPath("/design/project%3Aone"), "project:one");
  assert.equal(designProjectIdFromPath("/design"), undefined);
  assert.equal(parseRememberedDesignProject("project:one"), "project:one");
  assert.equal(parseRememberedDesignProject("project/one"), undefined);
  assert.equal(parseRememberedDesignProject("%"), undefined);
  assert.equal(parseRememberedDesignProject("x".repeat(257)), undefined);
  assert.equal(parseRememberedDesignProject("ｅ"), undefined);
});
