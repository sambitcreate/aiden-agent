import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  loadComposerDraft,
  saveComposerDraftText,
  stageComposerText,
  subscribeStagedComposerText,
} from "./composer-draft-store";

beforeEach(() => localStorage.clear());

test("staged text joins a closed chat's saved draft", () => {
  saveComposerDraftText("chat-a", "My own words");
  stageComposerText("chat-a", "Tell me more about B");
  assert.equal(loadComposerDraft("chat-a").text, "My own words\n\nTell me more about B");
});

test("a mounted composer receives staged text instead of storage", () => {
  const received: string[] = [];
  const unsubscribe = subscribeStagedComposerText("chat-b", (text) => received.push(text));
  stageComposerText("chat-b", "Drill into EMEA");
  stageComposerText("chat-other", "Elsewhere");
  unsubscribe();
  stageComposerText("chat-b", "After unmount");
  assert.deepEqual(received, ["Drill into EMEA"]);
  assert.equal(loadComposerDraft("chat-b").text, "After unmount");
  assert.equal(loadComposerDraft("chat-other").text, "Elsewhere");
});
