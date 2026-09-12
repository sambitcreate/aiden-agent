// Source assertions over the Aiden dock's motion, in the style of
// streaming-motion-contract.test.ts: the animation lives in CSS, so the CSS is
// what the test reads.

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

test("the panel rises into place as it fades in", () => {
  const keyframes = between(
    source("../styles.css"),
    "@keyframes aiden-assistant-dock-in",
    "@keyframes aiden-assistant-dock-out",
  );
  assert.match(keyframes, /opacity:\s*0/u);
  assert.match(keyframes, /opacity:\s*1/u);
  // Positive Y start = below its resting place, so it travels upward. The dock
  // is bottom-anchored; a negative offset here would drop it in from above.
  assert.match(keyframes, /translateY\(8px\)/u);
  assert.match(keyframes, /translateY\(0\)/u);
});

test("automation approvals reuse the app surface entrance motion", () => {
  const styles = source("../styles.css");
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-automation-approval\[data-state="open"\][\s\S]*aiden-app-update-banner-in 150ms cubic-bezier\(0\.19, 1, 0\.22, 1\)/u,
  );
  assert.match(
    source("../components/assistant/assistant-automation-approval.tsx"),
    /className="assistant-automation-approval/u,
  );
});

test("scheduled task details reuse the reduced-motion-gated surface entrance", () => {
  const styles = source("../styles.css");
  const scheduledTasks = source("../components/scheduled-tasks-view.tsx");
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.scheduled-task-detail\[data-state="open"\][\s\S]*aiden-app-update-banner-in 150ms cubic-bezier\(0\.19, 1, 0\.22, 1\)/u,
  );
  assert.match(scheduledTasks, /className="scheduled-task-detail/u);
});

test("the panel settles downward as it fades out", () => {
  const keyframes = between(
    source("../styles.css"),
    "@keyframes aiden-assistant-dock-out",
    "@keyframes aiden-assistant-bubble-in",
  );
  assert.match(keyframes, /translateY\(0\)/u);
  assert.match(keyframes, /translateY\(6px\)/u);
  assert.match(keyframes, /opacity:\s*0/u);
});

test("both directions are gated on the app's reduce-motion switch", () => {
  const styles = source("../styles.css");
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-dock-panel\[data-state="open"\]/u,
  );
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-dock-panel\[data-state="closed"\]/u,
  );
});

test("the panel's exit timeout matches the CSS it waits on", () => {
  const styles = source("../styles.css");
  const rule = between(
    styles,
    ':root[data-reduce-motion="false"] .assistant-dock-panel[data-state="closed"]',
    "}",
  );
  const cssDuration = /(\d+)ms/u.exec(rule)?.[1];
  const dock = source("../components/assistant/assistant-dock.tsx");
  const jsDuration = /const PANEL_EXIT_MS = (\d+);/u.exec(dock)?.[1];
  assert.ok(cssDuration, "no duration in the closed-state rule");
  // Unmounting early truncates the exit; unmounting late leaves a dead panel
  // sitting over the composer. The two values have to move together.
  assert.equal(jsDuration, cssDuration);
});

test("the dock keeps the panel mounted while it animates out", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  assert.match(dock, /setTimeout\(\(\) => setPresent\(false\), PANEL_EXIT_MS\)/u);
  // Reduce Motion must skip the wait entirely rather than hold a static panel.
  assert.match(dock, /dataset\.reduceMotion === "true"/u);
});

test("the dock owns the draft so minimizing cannot discard it", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  const panel = source("../components/assistant/assistant-panel.tsx");
  assert.match(dock, /const \[draft, setDraft\] = React\.useState\(""\)/u);
  assert.match(dock, /draft=\{draft\}/u);
  assert.match(dock, /onDraftChange=\{setDraft\}/u);
  assert.doesNotMatch(panel, /const \[draft, setDraft\] = React\.useState/u);
});

test("opening the dock moves focus to its composer and minimizing restores focus", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  const panel = source("../components/assistant/assistant-panel.tsx");
  assert.match(dock, /inputRef\.current\?\.focus\(\)/u);
  assert.match(dock, /if \(priorFocus\?\.isConnected\) priorFocus\.focus\(\)/u);
  assert.match(dock, /else bubbleRef\.current\?\.focus\(\)/u);
  assert.match(panel, /ref=\{inputRef\}/u);
});

test("hovering a reply preview cannot remove its click target", () => {
  const bubble = source("../components/assistant/assistant-bubble.tsx");
  assert.doesNotMatch(bubble, /onMouseEnter/u);
  assert.match(bubble, /onClick=\{onOpen\}/u);
});

test("an empty conversation still surfaces its error", () => {
  const panel = source("../components/assistant/assistant-panel.tsx");
  const thread = source("../components/assistant/assistant-thread.tsx");
  assert.match(panel, /chat\.error/u);
  assert.match(panel, /role="alert"/u);
  assert.match(thread, /role="alert"/u);
});

test("the hotkey waits for the central command listener and uses the dock command", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  const commands = source("./command-system.tsx");
  const main = source("../../main/index.ts");
  const listener = commands.indexOf('onNotification<{ commandId?: unknown }>("app:command"');
  const readySignal = commands.indexOf("appApi.rendererReady()");
  const readinessWait = main.indexOf("await rendererReadiness.wait()");
  const assistantCommand = main.indexOf('commandId: "assistant.open"');
  assert.match(dock, /useCommandHandler\("assistant\.open", openPanel\)/u);
  assert.doesNotMatch(dock, /interactionBlocked/u);
  assert.ok(listener >= 0 && readySignal > listener);
  assert.ok(readinessWait >= 0 && assistantCommand > readinessWait);
});

test("Scheduled Tasks can open Aiden's composer without discarding an existing draft", () => {
  const scheduledTasks = source("../components/scheduled-tasks-view.tsx");
  const dock = source("../components/assistant/assistant-dock.tsx");
  assert.match(scheduledTasks, /Create with Aiden/u);
  assert.match(scheduledTasks, /Set up with controls/u);
  assert.match(scheduledTasks, /requestAssistantAutomationComposer/u);
  assert.match(scheduledTasks, /onCloseAutoFocus/u);
  assert.match(scheduledTasks, /event\.preventDefault\(\)/u);
  assert.match(dock, /onAssistantAutomationComposerRequested/u);
  assert.match(dock, /setDraft\(assistantAutomationDraft\)/u);
});

test("stopping during first-turn persistence keeps the composer blocked until adoption", () => {
  const chat = source("../components/assistant/use-assistant-chat.ts");
  const panel = source("../components/assistant/assistant-panel.tsx");
  assert.match(chat, /stoppedPersistingTurnRef\.current === turnRef\.current/u);
  assert.match(chat, /setTurnSaving\(true\)/u);
  assert.match(chat, /const ready =\s*modelReady &&\s*!conversationLoading &&\s*!turnSaving/u);
  assert.match(panel, /"turn-saving": "Saving conversation…"/u);
});

test("stopping an active generation waits for its terminal persistence event", () => {
  const chat = source("../components/assistant/use-assistant-chat.ts");
  const stop = between(chat, "const stop = React.useCallback", "return {");
  assert.match(stop, /setGenerationPhase\(nextPhase\)/u);
  assert.match(stop, /handle\.cancel\("user_stop"\)/u);
  assert.doesNotMatch(stop, /abandonTurn\("user_stop"\)/u);
  assert.ok(
    (chat.match(/setGenerationPhase\("idle"\)/gu)?.length ?? 0) >= 4,
    "done, error, persistence failure, and lifecycle resets settle the phase",
  );
  assert.match(chat, /if \(\s*!canChangeThread/u);
  assert.match(chat, /persistingTurnRef\.current !== null/u);
  assert.match(chat, /handleRef\.current/u);
  assert.doesNotMatch(between(chat, "onError: (message", "onApproval:"), /else fail\(message\)/u);
});

test("assistant notices use a collision-free monotonic marker", () => {
  const chat = source("../components/assistant/use-assistant-chat.ts");
  assert.match(chat, /noticeSequenceRef/u);
  assert.match(chat, /at: \+\+noticeSequenceRef\.current/u);
  assert.doesNotMatch(chat, /at: Date\.now\(\)/u);
});

test("the Assistant composer does not send an in-progress IME composition", () => {
  const panel = source("../components/assistant/assistant-panel.tsx");
  assert.match(panel, /!event\.nativeEvent\.isComposing/u);
});

test("streamed Assistant replies stay busy through the formatting handoff", () => {
  const thread = source("../components/assistant/assistant-thread.tsx");
  assert.match(thread, /role="log"/u);
  assert.match(thread, /aria-live="polite"/u);
  assert.match(thread, /aria-busy=\{streaming \|\| streamComplete\}/u);
});

test("every Assistant turn exposes its speaker without relying on bubble styling", () => {
  const thread = source("../components/assistant/assistant-thread.tsx");
  assert.match(thread, /message\.role === "user" \? "You" : "Aiden"/u);
  assert.match(thread, /<span className="sr-only">\{speaker\}: <\/span>/u);
});
