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

test("automation approvals reuse the app surface entrance motion", () => {
  const styles = source("../styles.css");
  assert.match(
    styles,
    /:root\[data-reduce-motion="false"\] \.assistant-automation-approval\[data-state="open"\][\s\S]*aiden-app-update-banner-in 150ms cubic-bezier\(0\.19, 1, 0\.22, 1\)/u,
  );
  assert.match(
    source("../components/assistant/assistant-computer-use-approval.tsx"),
    /data-state="open"[\s\S]*className="assistant-automation-approval/u,
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

test("the Live orb trigger has tactile motion and a reduced-motion override", () => {
  const styles = source("../styles.css");
  const trigger = between(styles, ".aiden-live-trigger {", ".aiden-live-trigger[data-kind");
  assert.match(trigger, /transition:/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\] \.aiden-live-trigger/u);
  assert.match(styles, /\.aiden-live-trigger:focus-visible/u);
  const orb = between(
    styles,
    '.aiden-live-trigger[data-kind="orb"] {',
    ".aiden-live-trigger:hover",
  );
  assert.match(orb, /background: transparent/u);
  assert.match(orb, /box-shadow: none/u);
  assert.match(styles, /\.aiden-live-trigger\[data-kind="orb"\]:focus-visible/u);
});

test("the dock has one trigger and no longer owns a competing composer", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  const styles = source("../styles.css");
  assert.match(dock, /data-kind=\{setupCompleted \? "orb" : "logo"\}/u);
  assert.match(dock, /AssistantLiveSetupDialog/u);
  assert.doesNotMatch(dock, /AssistantPanel|AssistantBubble|setDraft|textarea/u);
  assert.doesNotMatch(styles, /\.assistant-live-(?:entry|presence|orb|control|signal)/u);
  assert.doesNotMatch(styles, /\.assistant-dock-(?:panel|bubble)/u);
});

test("the hotkey waits for the central command listener and uses the dock command", () => {
  const dock = source("../components/assistant/assistant-dock.tsx");
  const commands = source("./command-system.tsx");
  const main = source("../../main/index.ts");
  const listener = commands.indexOf('onNotification<{ commandId?: unknown }>("app:command"');
  const readySignal = commands.indexOf("appApi.rendererReady()");
  const readinessWait = main.indexOf("await rendererReadiness.wait()");
  const assistantCommand = main.indexOf('commandId: "assistant.open"');
  assert.match(dock, /useCommand\("assistant\.open", openPanel, live\.visible\)/u);
  assert.doesNotMatch(dock, /interactionBlocked/u);
  assert.ok(listener >= 0 && readySignal > listener);
  assert.ok(readinessWait >= 0 && assistantCommand > readinessWait);
});

test("Scheduled Tasks remains a visible control surface for Live Computer Use", () => {
  const scheduledTasks = source("../components/scheduled-tasks-view.tsx");
  const dock = source("../components/assistant/assistant-dock.tsx");
  const root = source("../main/root-view.tsx");
  const chatPane = source("../main/chat-pane.tsx");
  const composer = source("../components/composer.tsx");
  assert.match(scheduledTasks, /Create with Aiden/u);
  assert.match(scheduledTasks, /Set up with controls/u);
  assert.match(scheduledTasks, /requestAssistantAutomationComposer/u);
  assert.match(scheduledTasks, /onCloseAutoFocus/u);
  assert.match(scheduledTasks, /event\.preventDefault\(\)/u);
  assert.match(root, /onAssistantAutomationComposerRequested/u);
  assert.match(root, /openNewChat\(ASSISTANT_AUTOMATION_DRAFT\)/u);
  assert.match(chatPane, /initialText=\{draft\?\.initialText\}/u);
  assert.match(composer, /text: initialText/u);
  assert.match(dock, /scheduledTasks/u);
  assert.match(
    source("../../main/services/gemini-live/service-main.ts"),
    /create or review scheduled tasks/u,
  );
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
