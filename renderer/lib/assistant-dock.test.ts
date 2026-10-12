import assert from "node:assert/strict";
import test from "node:test";
import { ASSISTANT_AUTOMATION_DRAFT, onAssistantAutomationComposerRequested, requestAssistantAutomationComposer } from "./assistant-dock.js";

test("automation entry point seeds a bounded sentence the user can complete", () => {
  assert.equal(ASSISTANT_AUTOMATION_DRAFT, "Create an automation that ");
  assert.equal(ASSISTANT_AUTOMATION_DRAFT.length < 80, true);
});

test("schedule suggestions pass editable text to chat and stop after unsubscribe", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  try {
    const drafts: string[] = [];
    const unsubscribe = onAssistantAutomationComposerRequested((draft) => drafts.push(draft));
    requestAssistantAutomationComposer();
    requestAssistantAutomationComposer("Summarize my workspace each Friday at 4 PM.");
    unsubscribe();
    requestAssistantAutomationComposer("Must not open a second draft");
    assert.deepEqual(drafts, ["Create an automation that ", "Summarize my workspace each Friday at 4 PM."]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
