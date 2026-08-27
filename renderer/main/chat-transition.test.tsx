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

  // Detaches only the outgoing chat's generation; main continues the work.
  assert.match(pane, /generationChatIdRef\.current === departingChatId/u);
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

test("chat-scoped transcript UI remounts so previews cannot cross navigation", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /<MessageList\s+key=\{chatId\}/u);
  assert.doesNotMatch(pane, /<ScrollArea[^>]*\bkey=\{chatId\}/u);
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

test("a completed chat copy cannot override newer navigation", () => {
  const pane = source("./chat-pane.tsx");
  const copy = between(pane, "const copyChat = React.useCallback(", "const exportChat");
  const awaitCopy = copy.indexOf("await chatsApi.copyVisibleHistory(");
  const staleGuard = copy.indexOf(
    "if (!mountedRef.current || chatIdRef.current !== sourceChatId) return;",
  );
  const navigate = copy.indexOf('await navigate({ to: "/chat/$chatId"');
  assert.ok(awaitCopy >= 0 && staleGuard > awaitCopy && navigate > staleGuard);
});

test("session navigation seeds caches, respects route intent, and restores destination focus", () => {
  const pane = source("./chat-pane.tsx");
  const copy = between(pane, "const copyChat = React.useCallback(", "const exportChat");
  assert.match(copy, /setQueryData<ChatMeta\[\]>/u);
  assert.match(copy, /requestAnimationFrame\(\(\) => composerRef\.current\?\.focus/u);
  const worktree = between(
    pane,
    "const createGitWorktree = React.useCallback(",
    "React.useEffect(() => {\n    environmentPanel.setCreateWorktreeHandler",
  );
  assert.match(worktree, /setQueryData<Workspace\[\]>/u);
  assert.match(worktree, /chatIdRef\.current !== sourceChatId/u);
  assert.match(worktree, /The worktree was created, but its chat could not be created/u);
  assert.match(worktree, /await navigate/u);
  assert.match(worktree, /requestAnimationFrame\(\(\) => composerRef\.current\?\.focus/u);
});

test("a committed append is not presented as unsent when generation start later fails", () => {
  const pane = source("./chat-pane.tsx");
  const handleSend = between(
    pane,
    "const handleSend = React.useCallback(",
    "const handleStop = React.useCallback",
  );
  const append = handleSend.indexOf("await chatsApi.appendMessage(");
  const start = handleSend.indexOf("await runGeneration(messageTurnId)");
  assert.ok(append >= 0 && start > append);
  assert.match(handleSend, /if \(!started\.ok && mountedRef\.current\) setError/u);
  assert.doesNotMatch(handleSend, /if \(!started\.ok\) throw/u);
});

test("an unpersisted image response blocks sends, copies, and the composer until deletion", () => {
  const pane = source("./chat-pane.tsx");
  const handleSend = between(
    pane,
    "const handleSend = React.useCallback(",
    "const handleStop = React.useCallback",
  );
  const copy = between(pane, "const copyChat = React.useCallback(", "const exportChat");

  assert.match(handleSend, /if \(imageArtifactRecoveryPending\)/u);
  assert.match(copy, /if \(imageArtifactRecoveryPending\)/u);
  assert.match(
    pane,
    /hasUnpersistedResponse \|\| chat\.data\?\.imageArtifactRecoveryPending === true/u,
  );
  assert.match(
    pane,
    /ready=\{\s*ready && !imageArtifactRecoveryPending && !imageArtifactRecoveryUnavailable\s*\}/u,
  );
  assert.match(pane, /Delete this chat to discard it/iu);
  assert.match(pane, /imageArtifactRecoveryUnavailable/u);
  assert.match(pane, /developer log to locate the staging file that needs repair/iu);
});

test("terminal chat snapshots reach cache before visual stream handoff awaits", () => {
  const pane = source("./chat-pane.tsx");
  const generation = between(
    pane,
    "const runGeneration = React.useCallback(",
    "const handleSend = React.useCallback(",
  );
  const done = between(generation, "onDone: async", "onError:");
  assert.ok(
    done.indexOf("qc.setQueryData(queryKeys.chat(chatId), updatedChat)") <
      done.indexOf("await waitForStreamHandoff"),
  );
  const error = generation.slice(generation.indexOf("onError:"));
  assert.ok(
    error.indexOf("qc.setQueryData(queryKeys.chat(chatId), updatedChat)") <
      error.indexOf("await waitForStreamHandoff"),
  );
});

test("a persisted provider failure replaces the transient stream error", () => {
  const pane = source("./chat-pane.tsx");
  const terminal = between(
    pane,
    "onError: (message, partialContent, finalTimeline, updatedChat, finalReasoning) => {",
    "messageTurnId,",
  );
  assert.match(terminal, /updatedChat\?\.messages\[updatedChat\.messages\.length - 1\]/u);
  assert.match(terminal, /\.providerFailure/u);
  assert.match(terminal, /persistedFailure\s*\? null/u);
});

test("an indeterminate append blocks retries until an application reload reconciles storage", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /isAppendReconciliationRequired\(appendError\)/u);
  assert.match(
    pane,
    /setAppendReconciliationRequiredChats\(\(current\) => new Set\(current\)\.add\(chatId\)\)/u,
  );
  assert.match(pane, /appendReconciliationRequiredChats\.has\(chatId\)/u);
  assert.match(pane, /Reload Aiden before sending another message/u);
  assert.doesNotMatch(
    between(pane, "// Reset transient state when switching chats.", "}, [chatId]);"),
    /setAppendReconciliationRequiredChats/u,
  );
});

test("append reconciliation is surfaced across route remounts and chat creation paths", () => {
  const root = source("./root-view.tsx");
  const layout = source("./chat-layout.tsx");
  const sidebar = source("../components/chat-sidebar.tsx");
  assert.match(root, /useAppendReconciliationRequired\(\)/u);
  assert.match(root, /duration: Infinity/u);
  assert.match(layout, /appendReconciliationRequired \?/u);
  assert.match(layout, /\.catch\(\(error: unknown\)/u);
  assert.match(sidebar, /disabled=\{!activeId \|\| appendReconciliationRequired\}/u);
  assert.match(sidebar, /Aiden could not create a chat/u);
  assert.match(sidebar, /list\.length === 0 && appendReconciliationRequired/u);
  assert.match(sidebar, /workspaceSwitchBlocked \|\| appendReconciliationRequired/u);
  assert.match(sidebar, /enterWorkspace\(id\)\.catch/u);
  const pane = source("./chat-pane.tsx");
  const worktreeGuard = pane.indexOf("if (documentAppendReconciliationRequired)");
  const worktreeMutation = pane.indexOf("gitApi.createWorktree(", worktreeGuard);
  assert.ok(worktreeGuard >= 0 && worktreeMutation > worktreeGuard);
  const scratchGuard = pane.indexOf(
    "if (documentAppendReconciliationRequired)",
    pane.indexOf("const createScratchWorkspace"),
  );
  const scratchMutation = pane.indexOf("workspacesApi.createScratch(", scratchGuard);
  assert.ok(scratchGuard >= 0 && scratchMutation > scratchGuard);
  assert.match(
    pane,
    /workspaceChangeBlockedReason=\{[\s\S]{0,180}documentAppendReconciliationRequired/u,
  );
  assert.match(
    pane,
    /documentAppendReconciliationRequired \|\| appendReconciliationRequiredChats/u,
  );
});

test("composer stays keyed so drafts and attachments do not leak between chats", () => {
  const pane = source("./chat-pane.tsx");
  const composer = between(pane, "<Composer", "readinessMessage=");
  assert.match(composer, /key=\{chatId\}/u);
  assert.match(pane, /slashPaletteBlocked=\{Boolean\(pending\)\}/u);

  // The key is load-bearing: Composer holds this state with no chatId reset.
  const composerSource = source("../components/composer.tsx");
  assert.match(composerSource, /const \[draft, dispatchDraft\] = React\.useReducer/u);
  assert.match(composerSource, /text: ""/u);
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

test("a revisited detached stream restores the responding window from its last text delta", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /detachedTextStreamingRemaining\(\s*detachedLastTextDeltaAt/u);
  assert.match(pane, /setTextStreaming\(true\)[\s\S]{0,240}setTextStreaming\(false\)/u);
  assert.match(
    pane,
    /streamingText:[\s\S]{0,180}detachedGenerationDraining[\s\S]{0,120}displayedStreamingText/u,
  );
});
