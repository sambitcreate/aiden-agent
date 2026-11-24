import assert from "node:assert/strict";
import test from "node:test";
import { turnThinkingLevel, type SavedThinkingPreference } from "./turn-thinking-level.js";

const off = (level: SavedThinkingPreference["level"]): SavedThinkingPreference => ({ supported: false, level });
const on = (level: SavedThinkingPreference["level"]): SavedThinkingPreference => ({ supported: true, level });

test("a chat's own level is sent over the model's saved level", () => {
  const saved = { google: off("low"), codex: off("low"), anthropic: on("medium"), provider: off("low") };
  assert.equal(turnThinkingLevel("max", saved), "max");
  assert.equal(turnThinkingLevel(null, saved), "medium", "a cleared level falls back to the saved one");
  assert.equal(turnThinkingLevel(undefined, saved), "medium");
});

test("without a chat level the first family that supports the model supplies its saved level", () => {
  assert.equal(
    turnThinkingLevel(undefined, { google: on("high"), codex: on("low"), anthropic: on("medium"), provider: on("off") }),
    "high",
  );
  assert.equal(
    turnThinkingLevel(undefined, { google: off("high"), codex: on("xhigh"), anthropic: on("medium"), provider: on("off") }),
    "xhigh",
  );
  assert.equal(
    turnThinkingLevel(undefined, { google: off("high"), codex: off("low"), anthropic: off("medium"), provider: on("low") }),
    "low",
  );
});

test("a model no family supports sends no level unless the chat chose one", () => {
  const none = { google: off("high"), codex: off("low"), anthropic: off("medium"), provider: off("low") };
  assert.equal(turnThinkingLevel(undefined, none), undefined);
  assert.equal(turnThinkingLevel("high", none), "high", "main clamps a level the model cannot use");
});
