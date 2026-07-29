// Guards the chat-switch rendering contract. Switching chats used to remount the
// whole pane, which threw away ScrollArea's measured chrome and scroll position
// and read as blank -> overlapping -> snap. These assertions keep the transition
// state-driven instead of mount-driven.

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

test("chat route renders ChatPane without remounting it per chatId", () => {
  const router = source("./router.tsx");
  const route = between(router, "const chatRoute = createRoute({", "});");

  assert.match(route, /<ChatPane chatId=\{chatId\} \/>/u);
  assert.doesNotMatch(
    route,
    /<ChatPane[^>]*\bkey=/u,
    "Keying ChatPane by chatId remounts the pane and blanks the transcript on every switch",
  );
});

test("chat pane owns its own per-chat reset instead of relying on a remount", () => {
  const pane = source("./chat-pane.tsx");

  // Cancels in-flight generation for the outgoing chat.
  assert.match(pane, /generationRef\.current\?\.cancel\("lifecycle"\)/u);

  const reset = between(pane, "// Reset transient state when switching chats.", "}, [chatId]);");
  for (const setter of [
    "setStreamingText(null)",
    "setStreamingReasoning(null)",
    "setStreamComplete(false)",
    "setGenerationTimeline(null)",
    "setLiveSubagents([])",
    "setError(null)",
    "setApprovals([])",
  ]) {
    assert.ok(reset.includes(setter), `chatId reset must clear ${setter}`);
  }
});

test("per-chat reset runs before paint so no frame carries the outgoing chat", () => {
  const pane = source("./chat-pane.tsx");
  const reset = between(pane, "// Reset transient state when switching chats.", "}, [chatId]);");

  assert.match(
    reset,
    /React\.useLayoutEffect\(\(\) => \{/u,
    "A passive effect would let the new chatId paint with the previous chat's stream",
  );
});

test("leaving a chat releases its Environment subagent owner before paint", () => {
  const pane = source("./chat-pane.tsx");

  assert.match(
    pane,
    /React\.useLayoutEffect\(\(\) => \{\s*if \(!effectiveWorkspaceId\) return;\s*return \(\) => environmentPanel\.releaseSubagents\(chatId, effectiveWorkspaceId\)/u,
  );
  assert.match(pane, /\[chatId, effectiveWorkspaceId, environmentPanel\.releaseSubagents\]/u);
});

test("a stale send cannot clear the next chat's starting-generation guard", () => {
  const pane = source("./chat-pane.tsx");
  const handleSend = between(
    pane,
    "const handleSend = React.useCallback(",
    "const handleStop = React.useCallback",
  );

  assert.match(
    handleSend,
    /mountedRef\.current &&\s*chatIdRef\.current === chatId &&\s*generationIntentRef\.current === generationIntent/u,
  );
  assert.match(handleSend, /setIsStartingGeneration\(false\)/u);
  assert.doesNotMatch(
    handleSend,
    /finally \{\s*setIsStartingGeneration\(false\)/u,
    "An obsolete append must not clear a newer chat's busy ownership.",
  );
});

test("composer stays keyed so drafts and attachments do not leak between chats", () => {
  const pane = source("./chat-pane.tsx");
  const composer = between(pane, "<Composer", "readinessMessage=");
  assert.match(composer, /key=\{chatId\}/u);

  // The key is load-bearing: Composer holds this state with no chatId reset.
  const composerSource = source("../components/composer.tsx");
  assert.match(composerSource, /const \[text, setText\] = React\.useState\(""\)/u);
  assert.match(
    composerSource,
    /const \[attachments, setAttachments\] = React\.useState<Attachment\[\]>\(\[\]\)/u,
  );
});

test("scroll area settles scroll position before paint, not a frame later", () => {
  const ui = source("../components/ui.tsx");
  const scrollArea = between(ui, "export function ScrollArea(", "type DialogProps");
  const effect = between(
    scrollArea,
    'if (autoScrollToBottom && atBottomRef.current) scrollToBottom("auto");',
    "resizeObserver.observe(element);",
  );

  const syncIndex = effect.indexOf("\n    update();");
  const frameIndex = effect.indexOf("requestAnimationFrame(update)");
  assert.notEqual(syncIndex, -1, "ScrollArea must run update() synchronously in the layout effect");
  assert.notEqual(frameIndex, -1, "The post-paint frame should remain for late layout");
  assert.ok(syncIndex < frameIndex, "The synchronous settle must precede the rAF pass");
});

test("scroll area still pads the viewport for its overlaid chrome", () => {
  const ui = source("../components/ui.tsx");
  const scrollArea = between(ui, "export function ScrollArea(", "type DialogProps");

  // Toolbar and footer are absolutely positioned, so the viewport must reserve
  // their measured height or the composer overlaps the transcript.
  assert.match(
    scrollArea,
    /style=\{\{ paddingTop: toolbarHeight, paddingBottom: footerHeight \}\}/u,
  );
  assert.match(scrollArea, /ref=\{toolbarRef\}[^>]*absolute inset-x-0 top-0/u);
  assert.match(scrollArea, /ref=\{footerRef\}[^>]*absolute inset-x-0 bottom-0/u);
});

test("sidebar prefetches a chat before the click so the pane does not blank", () => {
  const sidebar = source("../components/chat-sidebar.tsx");

  assert.match(sidebar, /const prefetchChat = React\.useCallback\(/u);
  assert.match(
    sidebar,
    /qc\.prefetchQuery\(\{\s*queryKey: queryKeys\.chat\(id\),\s*queryFn: \(\) => chatsApi\.get\(id\),/u,
  );
  assert.match(sidebar, /onPointerEnter=\{\(\) => prefetchChat\(chat\.id\)\}/u);
  assert.match(sidebar, /onFocus=\{\(\) => prefetchChat\(chat\.id\)\}/u);
});
