import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `Missing ${start}`);
  assert.notEqual(endIndex, -1, `Missing ${end}`);
  return value.slice(startIndex, endIndex);
}

test("rich links keep anchor navigation and dismiss without fetching", () => {
  const richLink = source("../components/rich-link.tsx");
  assert.match(richLink, /<a[\s\S]*href=\{href\}/u);
  assert.doesNotMatch(richLink, /onClick=/u);
  assert.match(richLink, /event\.key === "Escape"/u);
  assert.match(richLink, /dismissedWhileFocusedRef\.current = true/u);
  assert.match(richLink, /if \(nextOpen && dismissedWhileFocusedRef\.current\) return/u);
  assert.match(richLink, /onFocus=/u);
  assert.match(richLink, /onBlur=/u);
  assert.doesNotMatch(richLink, /\b(?:fetch|window\.api|ipcRenderer)\b/u);
});

test("reasoning keeps its status and disclosure without a brain glyph", () => {
  const reasoning = source("../components/reasoning-block.tsx");
  assert.doesNotMatch(reasoning, /\bBrainCircuit\b/u);
  assert.match(reasoning, /active && "agent-thinking-shimmer"/u);
  assert.doesNotMatch(reasoning, /`\$\{label\}…`/u);
  assert.match(reasoning, /<ChevronRight/u);
  assert.match(reasoning, /aria-expanded=\{expanded\}/u);
});

test("local deployments receive a presentation-only reasoning switch", () => {
  const pane = source("../main/chat-pane.tsx");
  const control = source("../components/reasoning-visibility-control.tsx");
  assert.match(pane, /isLocalProviderDeployment\(selectedProvider\)/u);
  assert.match(pane, /settingsApi\.set\(\{\s*showLocalModelReasoning: visible,?\s*\}\)/u);
  assert.match(pane, /<ReasoningVisibilityControl/u);
  assert.match(control, /role="switch"/u);
  assert.match(control, /This changes presentation only/u);
});

test("a persistence error retains the only rendered partial response", () => {
  const pane = source("../main/chat-pane.tsx");
  assert.match(pane, /const isGenerating = streamingText !== null && !hasUnpersistedResponse/u);
  const errorCleanup = between(pane, "const partial = resolvedPartialContent.trim();", "setError(");
  assert.match(errorCleanup, /if \(!partial \|\| updatedChat\) \{\s*setStreamingText\(null\)/u);
  assert.match(
    errorCleanup,
    /if \(!partial \|\| updatedChat\) \{\s*setGenerationTimeline\(null\)/u,
  );
  assert.match(
    errorCleanup,
    /Boolean\(\(partial \|\| hasUnpersistedArtifact\) && !updatedChat\)/u,
  );
});
