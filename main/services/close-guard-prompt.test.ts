import assert from "node:assert/strict";
import { test } from "node:test";
import { closeGuardDiscardPrompt, closeGuardSavingPrompt } from "./close-guard-prompt.js";

test("unsaved design canvas work is named as the canvas, not as the open file", () => {
  const prompt = closeGuardDiscardPrompt({ dirty: ["design"], saving: [] }, undefined, "close");
  assert.equal(prompt.title, "Discard unsaved changes?");
  assert.equal(prompt.message, "The design canvas has changes that have not been saved.");
  assert.equal(prompt.detail, "Closing Aiden will permanently discard those changes.");
  assert.deepEqual(prompt.buttons, ["Keep Editing", "Discard Changes and Close"]);

  const saving = closeGuardSavingPrompt({ dirty: [], saving: ["design"] }, "reload");
  assert.equal(saving.title, "Design canvas save in progress");
  assert.equal(saving.message, "Wait for the design canvas to finish saving before reloading.");
});

test("every surface holding unsaved work is named, the open file first", () => {
  const prompt = closeGuardDiscardPrompt(
    { dirty: ["design", "images", "editor"], saving: [], imagesLabel: "Moodboard" },
    "src/app.ts",
    "reload",
  );
  assert.equal(
    prompt.message,
    "“src/app.ts”, the image workflow “Moodboard” and the design canvas have edits that have not been saved.",
  );
  assert.equal(prompt.title, "Discard unsaved edits?");
  assert.deepEqual(prompt.buttons, ["Keep Editing", "Discard Edits and Reload"]);

  assert.equal(
    closeGuardDiscardPrompt({ dirty: ["images", "design"], saving: [] }, undefined, "close").message,
    "The image workflow and the design canvas have changes that have not been saved.",
  );
});

test("work from no named surface is the Files editor's, as its IPC path reports none", () => {
  assert.equal(closeGuardDiscardPrompt(undefined, "notes.md", "close").message, "“notes.md” has edits that have not been saved.");
  assert.equal(closeGuardDiscardPrompt({ dirty: [], saving: [] }, undefined, "close").message, "The open file has edits that have not been saved.");
  const saving = closeGuardSavingPrompt(undefined, "close");
  assert.equal(saving.title, "File save in progress");
  assert.equal(saving.message, "Wait for the open file to finish saving before closing Aiden.");
  assert.equal(
    closeGuardSavingPrompt({ dirty: [], saving: ["images"], imagesLabel: "Shots" }, "close").message,
    "Wait for the image workflow “Shots” to finish saving before closing Aiden.",
  );
});
