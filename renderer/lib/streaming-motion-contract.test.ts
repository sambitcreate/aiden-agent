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

test("inline streaming text fades without baseline movement or blur", () => {
  const styles = source("../styles.css");
  const inlineKeyframes = between(
    styles,
    "@keyframes aiden-streaming-unit-in",
    "@keyframes aiden-streaming-block-in",
  );
  assert.match(inlineKeyframes, /opacity:\s*0/u);
  assert.match(inlineKeyframes, /opacity:\s*1/u);
  assert.doesNotMatch(inlineKeyframes, /\b(?:top|transform|filter)\s*:/u);

  const blockKeyframes = between(
    styles,
    "@keyframes aiden-streaming-block-in",
    "@keyframes aiden-reasoning-surface-in",
  );
  assert.match(blockKeyframes, /translateY\(4px\)/u);
  assert.doesNotMatch(blockKeyframes, /\bfilter\s*:/u);
});

test("stream completion no longer overlaps a second Markdown tree", () => {
  const component = source("../components/streaming-markdown-reveal.tsx");
  const codeBlock = source("../components/code-block.tsx");
  const styles = source("../styles.css");
  assert.match(component, /advanceStreamingRevealSchedule/u);
  assert.doesNotMatch(component, /streaming-reveal-(?:source|final|handoff)/u);
  assert.doesNotMatch(styles, /streaming-reveal-(?:source|final|handoff)/u);
  assert.doesNotMatch(codeBlock, /JSON\.parse/u);
});

test("streaming and persisted messages reserve the same action and timeline shell", () => {
  const bubble = source("../components/message-bubble.tsx");
  const list = source("../components/message-list.tsx");
  assert.doesNotMatch(bubble, /streaming-cursor/u);
  assert.match(bubble, /streaming && !streamComplete \? "invisible" : ""/u);

  const transientShell = between(
    list,
    "{timeline || liveSubagents.length > 0 || streamingReasoning || streamingText ? (",
    "<AgentActivityTransition",
  );
  assert.match(transientShell, /<ActivityFeed timeline=\{timeline\} \/>/u);
  assert.match(
    transientShell,
    /<SubagentChips runs=\{liveSubagents\} onOpen=\{onOpenSubagent\} \/>/u,
  );
});

test("main and subagent activity share Aiden's orb wrapper", () => {
  const orb = source("../components/aiden-orb.tsx");
  const list = source("../components/message-list.tsx");
  const subagents = source("../components/subagent-chips.tsx");

  assert.match(orb, /import \{\s*ThinkingOrb,/u);
  assert.match(orb, /paused=\{appearance\.paused \|\| !active\}/u);
  assert.match(list, /import \{ AidenOrb \} from "\.\/aiden-orb"/u);
  assert.match(subagents, /import \{ AidenOrb \} from "\.\/aiden-orb"/u);
  assert.doesNotMatch(list, /from "thinking-orbs"/u);
});

test("reasoning keeps its status and disclosure without a brain glyph", () => {
  const reasoning = source("../components/reasoning-block.tsx");
  assert.doesNotMatch(reasoning, /\bBrainCircuit\b/u);
  assert.match(reasoning, /active \? "Thinking…" : "Thinking"/u);
  assert.match(reasoning, /<ChevronRight/u);
  assert.match(reasoning, /aria-expanded=\{expanded\}/u);
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
  assert.match(errorCleanup, /setHasUnpersistedResponse\(Boolean\(partial && !updatedChat\)\)/u);
});
