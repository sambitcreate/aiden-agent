import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { scheduledTaskProviderGuardrail } from "../lib/scheduled-task-view.js";
import type { Provider } from "../lib/types.js";
import { ScheduledTaskProviderWarning } from "./scheduled-task-editor.js";

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

test("provider guardrail is a soft inline warning only for LLM tasks that may not run", () => {
  const providers = [
    { id: "openai", label: "OpenAI", models: ["gpt-5.6"], hasKey: true, needsKey: true },
    { id: "antigravity", label: "Google Antigravity", models: ["gemini-3.8-flash"], hasKey: true, needsKey: true },
  ] as unknown as Provider[];
  const warning = (appDefault: string | undefined, pinned?: string) =>
    renderToStaticMarkup(
      <ScheduledTaskProviderWarning message={scheduledTaskProviderGuardrail("llm", pinned, appDefault, providers)} />,
    );

  // No app default at all.
  const absent = warning(undefined);
  assert.match(absent, /role="status"[^>]*>.*No provider pinned\. If no app default is available, this task cannot run\./u);
  // An agent-backed default exists but cannot run unattended; the warning says so by name.
  assert.match(
    warning("antigravity"),
    /No provider pinned, and the app default \(Google Antigravity\) runs only in chats you have open on this computer\. Pin a provider so this task can run\./u,
  );
  // A usable default, or a pinned provider, shows nothing.
  assert.equal(warning("openai"), "");
  assert.equal(warning(undefined, "openai"), "");
  // Status reads through a soft semantic fill, never a decorative border, ring or outline.
  const classes = absent.match(/class="([^"]*)"/u)?.[1] ?? "";
  assert.doesNotMatch(classes, /\b(?:border|ring|outline)\b/u);
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