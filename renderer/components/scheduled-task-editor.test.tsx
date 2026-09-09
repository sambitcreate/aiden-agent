import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("scheduled task editor offers an explicit App default and pins provider/model on choice", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(editor, /App default \(follows your selection\)/u);
  assert.match(editor, /value=\{draft\.providerId \?\? APP_DEFAULT_PROVIDER_CHOICE\}/u);
  assert.match(editor, /providerId: undefined, model: undefined/u);
  assert.match(editor, /usableProviders\.map\(/u);
  assert.match(editor, /scheduledTaskProviderModelOptions\(/u);
  assert.match(editor, /providerModelOptions\.models\.map\(/u);
  assert.match(editor, /disabled=\{assistantOwned\}/u);
});

test("provider guardrail is a soft inline warning only for LLM tasks without a provider", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(editor, /scheduledTaskProviderGuardrail\(/u);
  assert.match(editor, /providerGuardrail \?/u);
  assert.match(
    editor,
    /rounded-control bg-status-warning-surface px-2\.5 py-1\.5 text-small text-status-warning/u,
  );
  assert.doesNotMatch(
    editor,
    /bg-status-warning-surface px-2\.5 py-1\.5 text-small text-status-warning[^"]*(?:border|ring|outline)/u,
  );
  assert.match(editor, /No provider pinned\./u);
});

test("the Model select stays bound to the helper's pinned model and never re-filters its options", () => {
  const editor = source("./scheduled-task-editor.tsx");
  assert.match(
    editor,
    /value=\{providerModelOptions\.model \?\? ""\}/u,
    "the Select value is the helper's pinned (possibly hidden) model",
  );
  assert.match(editor, /providerModelOptions\.models\.map\(/u);
  assert.match(
    editor,
    /scheduledTaskProviderModelOptions\(\s*pinnedProvider,/u,
    "the editor delegates pinned-model resolution to the shared helper",
  );
  assert.doesNotMatch(
    editor,
    /providerModelOptions\.models\.filter\(/u,
    "the editor must not re-filter the helper's prepended pinned-model list",
  );
  assert.match(
    editor,
    /current\.providerId === provider\.id \? current\.model : undefined/u,
    "a stale pinned model from another provider never leaks into the new provider",
  );
});