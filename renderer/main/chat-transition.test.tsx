// Guards the chat-switch rendering contract. Switching chats used to remount the
// whole pane, which threw away ScrollArea's measured chrome and scroll position
// and read as blank -> overlapping -> snap. These assertions keep the transition
// state-driven instead of mount-driven.

// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "./bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Outlet, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installAppendedChatSnapshot, queryKeys } from "../lib/queries.js";
import type { Chat } from "../lib/types.js";
import { WorkspaceProvider } from "../lib/workspace-context";
import { WorkspaceTerminalProvider } from "../components/terminal-drawer";
import { EnvironmentPanelProvider } from "../components/environment-panel";
import { CommandSystemProvider } from "../lib/command-system";
import { TooltipProvider } from "../components/ui";
import { RoutedBotPanelProvider } from "./bots/bot-panel-context";

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

function chatReadResponse(id: string) {
  return {
    chat: {
      id,
      title: `Chat ${id}`,
      messages: [{ id: `message-${id}`, role: "user", content: `Hello from chat ${id}`, createdAt: 1 }],
      createdAt: 1,
      updatedAt: 1,
    },
    imageArtifactRecoveryPending: false,
    imageArtifactRecoveryUnavailable: false,
    reconciliation: null,
  };
}

/** Mounts the real routed ChatPane at `/chat/<chatId>` behind the fake IPC bridge. */
async function mountRoutedChatPane(
  chatId: string,
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
) {
  // The app router is a module singleton whose scroll restoration reads these
  // window globals while it is created, so load it after exposing them.
  const globals = globalThis as Record<string, unknown>;
  const win = window as unknown as Record<string, unknown>;
  globals.history = win.history;
  globals.location = win.location;
  for (const key of ["addEventListener", "removeEventListener", "dispatchEvent"]) {
    globals[key] = (win[key] as (...args: unknown[]) => unknown).bind(window);
  }
  const { router, queryClient } = await import("./router");

  installBotTestIpc({
    "chats:get": (id) => chatReadResponse(String(id)),
    "chats:list": () => [],
    "chats:markRead": () => true,
    "chats:activitySnapshot": () => null,
    "chats:todoSnapshot": () => null,
    "chats:contextPressure": () => null,
    "workspaces:list": () => [],
    "workspaces:externalEditors": () => [],
    "providers:list": () => [],
    "pullRequests:list": () => [],
    "pullRequests:pending": () => [],
    "pullRequests:current": () => null,
    "remote:getPendingApproval": () => null,
    "remote:getPendingQuestion": () => null,
    "settings:get": () => null,
    "shortcut:get": () => null,
    "tts:status": () => null,
    "app:renderer-ready": () => null,
    ...handlers,
  });

  // Keep the real chat route (the component that decides ChatPane's key) and
  // swap only the app shell around it for the providers ChatPane reads.
  const routes = router.routesById as unknown as Record<string, { options: { component?: unknown } }>;
  routes.__root__.options.component = function ChatPaneProviders() {
    return (
      <WorkspaceProvider>
        <WorkspaceTerminalProvider>
          <EnvironmentPanelProvider>
            <RoutedBotPanelProvider>
              <CommandSystemProvider>
                <Outlet />
              </CommandSystemProvider>
            </RoutedBotPanelProvider>
          </EnvironmentPanelProvider>
        </WorkspaceTerminalProvider>
      </WorkspaceProvider>
    );
  };
  routes["/chatLayout"].options.component = Outlet;

  router.history.push(`/chat/${chatId}`);
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { router, queryClient };
}

test("question countdown stays singular across chat updates and is removed after answering", async () => {
  let prompt = {
    version: 1 as const,
    promptId: "question-1",
    streamId: "stream-question-1",
    toolCallId: "call-question-1",
    source: "remote" as const,
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
    questions: [{
      header: "URL",
      question: "Where should the monitor connect?",
      multiSelect: false,
      options: [{ label: "Set later", description: "Use a placeholder for now." }],
    }],
  };
  let answers = 0;
  const { queryClient } = await mountRoutedChatPane("chat-a", {
    "remote:getPendingQuestion": () => ({ ...prompt }),
    "remote:respondQuestionFromHost": () => {
      answers += 1;
      return { status: "answered" };
    },
  });
  const countdowns = () => screen.queryAllByText(/Aiden continues on its own in /u);
  const refreshQuestion = async () => {
    await act(async () => {
      emitBotTestNotification("remote:approval-changed", { chatId: "chat-a" });
    });
  };
  try {
    await waitFor(() => assert.equal(countdowns().length, 1));
    const answer = screen.getByRole("button", { name: /Set later/u });
    await act(async () => { fireEvent.click(answer); });
    for (let update = 0; update < 6; update += 1) {
      await refreshQuestion();
      assert.equal(countdowns().length, 1, "A chat update must not append another countdown");
      assert.ok(screen.getByRole("button", { name: /Set later/u }) === answer);
      assert.equal(answer.getAttribute("aria-pressed"), "true", "Updates preserve the selected answer");
    }
    await act(async () => { fireEvent.keyDown(answer, { key: "Enter", metaKey: true }); });
    await waitFor(() => assert.equal(answers, 1));
    assert.equal(countdowns().length, 0, "Answering removes every countdown");
    assert.ok(screen.queryByRole("button", { name: "Close questionnaire" }) === null);

    prompt = { ...prompt, promptId: "question-2", toolCallId: "call-question-2" };
    await refreshQuestion();
    assert.equal(countdowns().length, 1, "A later question starts with one countdown");
    const nextAnswer = screen.getByRole("button", { name: /Set later/u });
    assert.equal(nextAnswer.getAttribute("aria-pressed"), "false", "A new prompt resets the selection");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Type your own answer/u }));
    });
    const customAnswer = screen.getByRole("textbox", { name: /Custom answer for/u }) as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(customAnswer, { target: { value: "https://monitor.local" } }); });
    await refreshQuestion();
    assert.equal(countdowns().length, 1);
    assert.ok(screen.getByRole("textbox", { name: /Custom answer for/u }) === customAnswer);
    assert.equal(customAnswer.value, "https://monitor.local", "Updates preserve a typed custom answer");

    prompt = { ...prompt, promptId: "question-3", toolCallId: "call-question-3" };
    await refreshQuestion();
    assert.equal(countdowns().length, 1, "Replacing an open prompt removes the old countdown");
    assert.ok(!customAnswer.isConnected, "A replacement prompt does not inherit the custom draft");
    assert.equal(screen.getByRole("button", { name: /Set later/u }).getAttribute("aria-pressed"), "false");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Close questionnaire" }));
    });
    await waitFor(() => assert.equal(answers, 2));
    assert.equal(countdowns().length, 0, "Dismissing the question removes its countdown");
  } finally {
    cleanup();
    queryClient.clear();
  }
});

test("switching chats keeps the routed ChatPane mounted and shows the new chat", async () => {
  const { router, queryClient } = await mountRoutedChatPane("chat-a");
  try {
    screen.getByText("Hello from chat chat-a");
    const title = screen.getByRole("heading", { level: 1 });
    assert.equal(title.textContent, "Chat chat-a");

    await act(async () => {
      await router.navigate({ to: "/chat/$chatId", params: { chatId: "chat-b" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    screen.getByText("Hello from chat chat-b");
    // Boolean oracles: a failing assert on a happy-dom node inspects the whole DOM graph.
    assert.ok(screen.queryByText("Hello from chat chat-a") === null);
    // A remount (for example `key={chatId}`) replaces every DOM node the pane
    // owns, which blanks the transcript chrome on each switch.
    assert.ok(
      screen.getByRole("heading", { level: 1 }) === title,
      "Switching chats must update the mounted pane rather than remount it",
    );
    assert.ok(title.isConnected);
    assert.equal(title.textContent, "Chat chat-b");
  } finally {
    cleanup();
    queryClient.clear();
  }
});

test("picking a model in one chat leaves other chats and the new-chat model alone", async () => {
  const provider = {
    id: "acme",
    kind: "openai-compatible",
    label: "Acme Cloud",
    baseUrl: "https://acme.invalid/v1",
    models: ["app-model", "model-a", "model-b"],
    needsKey: false,
    hasKey: true,
  };
  const chatModels: Record<string, string> = { "chat-a": "model-a", "chat-b": "model-a" };
  const setModelCalls: unknown[][] = [];
  // When set, the next chat read answers with what was stored when it started,
  // but only once released.
  let holdNextRead = false;
  let releaseHeldRead: (() => void) | undefined;
  localStorage.setItem("aiden-agent.providerId", "acme");
  localStorage.setItem("aiden-agent.model", "app-model");
  const { router, queryClient } = await mountRoutedChatPane("chat-a", {
    "chats:get": (id) => {
      const response = chatReadResponse(String(id));
      const snapshot = {
        ...response,
        chat: { ...response.chat, providerId: "acme", model: chatModels[String(id)] },
      };
      if (!holdNextRead) return snapshot;
      holdNextRead = false;
      return new Promise((resolve) => {
        releaseHeldRead = () => resolve(snapshot);
      });
    },
    "chats:setModel": (...args) => {
      setModelCalls.push(args);
      const [id, , model] = args as [string, string, string];
      chatModels[id] = model;
      return { ...chatReadResponse(id).chat, providerId: "acme", model };
    },
    "providers:list": () => [provider],
    "settings:get": () => ({}),
    "models:info": () => ({}),
    "modelPace:summaries": () => ({}),
  });
  const trigger = () => screen.getByRole("button", { name: /^Selected model: .*Choose a model\.$/u });
  try {
    await waitFor(() => assert.match(trigger().getAttribute("aria-label") ?? "", /Model A/iu));

    await act(async () => { fireEvent.click(trigger()); });
    const optionB = await waitFor(() => {
      const option = screen.queryAllByRole("option").find((row) => row.textContent?.includes("Model B"));
      assert.ok(option);
      return option;
    });
    // A read of chat A that started before the pick answers after it is saved.
    holdNextRead = true;
    void queryClient.refetchQueries({ queryKey: queryKeys.chat("chat-a"), exact: true });
    await waitFor(() => assert.ok(releaseHeldRead));
    await act(async () => { fireEvent.click(optionB); });
    await waitFor(() => assert.deepEqual(setModelCalls, [["chat-a", "acme", "model-b"]]));
    await act(async () => {
      releaseHeldRead?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await waitFor(() => assert.match(trigger().getAttribute("aria-label") ?? "", /Model B/iu));
    assert.equal(queryClient.getQueryData<Chat>(queryKeys.chat("chat-a"))?.model, "model-b");
    assert.equal(localStorage.getItem("aiden-agent.model"), "app-model", "new chats keep their model");

    await act(async () => {
      await router.navigate({ to: "/chat/$chatId", params: { chatId: "chat-b" } });
    });
    await waitFor(() => screen.getByText("Hello from chat chat-b"));
    await waitFor(() => assert.match(trigger().getAttribute("aria-label") ?? "", /Model A/iu));
    assert.equal(setModelCalls.length, 1, "opening another chat changes no model");
  } finally {
    cleanup();
    queryClient.clear();
    localStorage.removeItem("aiden-agent.providerId");
    localStorage.removeItem("aiden-agent.model");
  }
});

test("a refused follow-up side question keeps the card and the typed text", async () => {
  const { queryClient } = await mountRoutedChatPane("chat-a", {
    "chats:btwStart": () => {
      throw new Error("The side question could not start.");
    },
  });
  try {
    // A completed side question is on screen with its follow-up box.
    await act(async () => {
      emitBotTestNotification("chats:btw-event", {
        version: 1,
        type: "started",
        chatId: "chat-a",
        requestId: "btw-1",
        sequence: 0,
        question: "What does this do?",
        hasHistory: false,
        contextTrimmed: false,
      });
      emitBotTestNotification("chats:btw-event", {
        version: 1,
        type: "terminal",
        chatId: "chat-a",
        requestId: "btw-1",
        sequence: 1,
        status: "completed",
        answer: "It parses the config.",
        contextTrimmed: false,
      });
    });
    const followUp = screen.getByLabelText("Ask a follow-up side question") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(followUp, { target: { value: "And the defaults?" } });
    });
    await act(async () => {
      fireEvent.keyDown(followUp, { key: "Enter" });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // main refused the start: the card, the earlier answer and the unsent text all remain.
    const after = screen.queryByLabelText("Ask a follow-up side question") as HTMLTextAreaElement | null;
    assert.ok(after !== null, "The side-question card must stay mounted after a refused follow-up");
    assert.equal(after.value, "And the defaults?");
    assert.equal(after.disabled, false);
    assert.ok(screen.queryByText("It parses the config.") !== null);
  } finally {
    cleanup();
    queryClient.clear();
  }
});

async function showCompletedSideQuestion(chatId: string, requestId: string, answer: string) {
  await act(async () => {
    emitBotTestNotification("chats:btw-event", {
      version: 1,
      type: "started",
      chatId,
      requestId,
      sequence: 0,
      question: `Question in ${chatId}`,
      hasHistory: false,
      contextTrimmed: false,
    });
    emitBotTestNotification("chats:btw-event", {
      version: 1,
      type: "terminal",
      chatId,
      requestId,
      sequence: 1,
      status: "completed",
      answer,
      contextTrimmed: false,
    });
  });
}

async function askFollowUp(text: string) {
  const followUp = screen.getByLabelText("Ask a follow-up side question") as HTMLTextAreaElement;
  await act(async () => {
    fireEvent.change(followUp, { target: { value: text } });
  });
  await act(async () => {
    fireEvent.keyDown(followUp, { key: "Enter" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

test("a late refusal from the previous chat cannot restore its side question into the next chat", async () => {
  const starts = new Map<string, { reject: (error: Error) => void }>();
  const { router, queryClient } = await mountRoutedChatPane("chat-a", {
    "chats:btwStart": (request) =>
      new Promise((_resolve, reject) => {
        starts.set((request as { chatId: string }).chatId, { reject });
      }),
  });
  try {
    await showCompletedSideQuestion("chat-a", "btw-a", "Answer from chat A.");
    await askFollowUp("A follow-up");
    assert.ok(starts.has("chat-a"));

    await act(async () => {
      await router.navigate({ to: "/chat/$chatId", params: { chatId: "chat-b" } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await showCompletedSideQuestion("chat-b", "btw-b", "Answer from chat B.");
    await askFollowUp("B follow-up");
    assert.ok(starts.has("chat-b"));

    await act(async () => {
      starts.get("chat-a")?.reject(new Error("The side question could not start."));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Chat chat-b");
    assert.ok(screen.queryByText("Answer from chat A.") === null, "Chat A's answer must not appear in chat B");
    const followUp = screen.queryByLabelText("Ask a follow-up side question") as HTMLTextAreaElement | null;
    // B's own start is still pending, so its card stays in the starting state.
    assert.ok(followUp === null || followUp.disabled, "Chat B's pending side question must stay pending");
  } finally {
    cleanup();
    queryClient.clear();
  }
});

test("chat pane hides the generic tool phase when a chronological row owns it", () => {
  const pane = source("./chat-pane.tsx");
  assert.match(pane, /toolVisible:\s*chronologicalLiveRows\?\.some\(\(row\) => row\.kind === "activity"[\s\S]*?step\.status === "running"/u);
  assert.match(pane, /resolveVisibleAgentActivity\(timelineActivity/u);
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
  assert.match(pane, /autoScrollResetKey=\{chatId\}/u);
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
  assert.match(worktree, /The worktree was created, but Aiden could not open its new chat/u);
  assert.match(worktree, /createChatDraft\(workspace.id\)/u);
  assert.doesNotMatch(worktree, /chatsApi\.create\(/u);
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
  const start = handleSend.indexOf("runGeneration(messageTurnId)");
  assert.ok(append >= 0 && start > append);
  assert.match(handleSend, /if \(!started\.ok && mountedRef\.current[^)]*\)\s*\{\s*setError/u);
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
  assert.match(pane, /Settings → About → Diagnostics and choose Reveal/iu);
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
  assert.match(sidebar, /newAgentDisabled=\{!activeId \|\| appendReconciliationRequired\}/u);
  assert.match(sidebar, /Aiden could not create a chat/u);
  assert.match(sidebar, /list\.length === 0 && appendReconciliationRequired/u);
  assert.match(sidebar, /workspaceSwitchBlocked \|\| appendReconciliationRequired/u);
  assert.match(
    sidebar,
    /const openChat[\s\S]*?catch \(error\)[\s\S]*?Aiden could not open that chat/u,
  );
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

  // The key is load-bearing: Composer holds this state with no chatId reset,
  // including a one-time seed owned by that exact renderer draft.
  const composerSource = source("../components/composer.tsx");
  assert.match(composerSource, /const \[draft, dispatchDraft\] = React\.useReducer/u);
  assert.match(composerSource, /text: restoredText/u);
  assert.match(composerSource, /loadComposerDraft\(chatId\)\.text/u);
  assert.match(
    composerSource,
    /const \[attachments, setAttachments\] = React\.useState<Attachment\[\]>\(\[\]\)/u,
  );
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

test("revisited generations expose Stop and queue/steer without admitting a second turn early", () => {
  const pane = source("./chat-pane.tsx");
  const send = between(pane, "const handleSend = React.useCallback(", "const handleStop = React.useCallback");
  const stop = between(pane, "const handleStop = React.useCallback", "const { queue: messageQueue");
  // The visibility rule is now tested behaviorally in chat-terminal-sync.test.ts:
  // "a saved reply hides an own run, but a mirrored run only by its own reply"
  assert.match(pane, /isGenerating=\{isGenerating \|\| isStartingGeneration \|\| Boolean\(visibleDetachedProjection\)\}/u);
  assert.match(pane, /canStopGeneration=\{\(canStopGeneration \|\| Boolean\(visibleDetachedProjection\)\) && !isStoppingGeneration\}/u);
  // Stop closes busy admission synchronously, before React re-renders.
  assert.match(pane, /if \(handleStop\(\)\) stopRequestedRef\.current = true;/u);
  assert.match(pane, /stoppingGeneration=\{isStoppingGeneration\}/u);
  const queueAdmission = between(pane, "const queueMessage = React.useCallback(", "const steerMessage = React.useCallback(");
  assert.match(queueAdmission, /if \(stopRequestedRef\.current\) \{\s*throw new Error/u);
  assert.ok(queueAdmission.indexOf("stopRequestedRef.current") < queueAdmission.indexOf("messageQueue.add("));
  assert.match(stop, /if \(visibleDetachedProjection && !generationRef\.current && !isStoppingGeneration\)/u);
  assert.match(stop, /chatControl\.cancel\(streamId\)/u);
  assert.match(pane, /if \(!detachedGenerationDraining && !generationRef\.current\) setIsStoppingGeneration\(false\)/u);
  assert.match(send, /if \(detachedGenerationDraining\) \{\s*throw new Error/u);
  assert.match(pane, /enabled:\s*!draft\s*&&\s*ready\s*&&\s*!isGenerating[\s\S]*?!detachedGenerationDraining/u);
});

test("a pre-append assistant read cannot hide controls for the newer user turn", async () => {
  const pane = source("./chat-pane.tsx");
  const send = between(pane, "const handleSend = React.useCallback(", "const handleStop = React.useCallback");
  const install = send.indexOf("await installAppendedChatSnapshot(qc, chatId, updated)");
  const start = send.indexOf("runGeneration(messageTurnId)");
  assert.ok(install >= 0 && start > install);

  const queryClient = new QueryClient();
  const chatId = "chat-read-race";
  const assistantTail = {
    id: chatId,
    messages: [{ id: "previous", role: "assistant", content: "Previous answer", createdAt: 1 }],
  } as Chat;
  const appendedTurn = {
    ...assistantTail,
    messages: [
      ...assistantTail.messages,
      { id: "current", role: "user", content: "Current prompt", createdAt: 2 },
    ],
  } as Chat;
  let resolveOldRead!: (chat: Chat) => void;
  const oldRead = queryClient.fetchQuery({
    queryKey: queryKeys.chat(chatId),
    queryFn: () => new Promise<Chat>((resolve) => { resolveOldRead = resolve; }),
  });

  await Promise.resolve();
  await installAppendedChatSnapshot(queryClient, chatId, appendedTurn);
  resolveOldRead(assistantTail);
  await assert.rejects(oldRead);
  const cached = queryClient.getQueryData<Chat>(queryKeys.chat(chatId));
  assert.equal(cached?.messages[cached.messages.length - 1]?.role, "user");
  queryClient.clear();
});

test("root recovery reconciles missed detached terminals against authoritative activity", () => {
  const root = source("./root-view.tsx");
  const recovery = between(
    root,
    "const reconcileInactiveOwners = (payload: unknown) => {",
    "}, [reconcileDetachedLifecycleChat]);",
  );
  assert.match(recovery, /parseChatActivitySnapshot\(payload\)/u);
  assert.match(recovery, /pendingDetachedLifecycleChats\(\)/u);
  assert.match(recovery, /!activeChatIds\.has\(owner\.chatId\)/u);
  assert.ok(
    recovery.indexOf('onNotification("chats:activity-changed"') < recovery.indexOf(".activitySnapshot()"),
    "Recovery must subscribe before its bootstrap snapshot",
  );
  assert.match(root, /captureDetachedLifecycleChat\(owner\)/u);
  assert.match(root, /clearInactiveDetachedLifecycleChat\(captured, new Set\(snapshot\.activeChatIds\)\)/u);
  assert.match(root, /subscribeChatSettlements[\s\S]{0,180}reconcileDetachedLifecycleChat\(settlement\)/u);
});

test("every ordinary new-agent entry opens a draft without eager creation", () => {
  for (const file of ["./chat-layout.tsx", "./root-view.tsx", "./chat-pane.tsx", "../components/chat-sidebar.tsx"]) {
    const implementation = source(file);
    assert.match(implementation, /createChatDraft\(/u, file);
    assert.doesNotMatch(implementation, /chatsApi\s*\.create\(/u, file);
  }
});

test("first-message promotion seeds the real cache before releasing draft state without navigation", () => {
  const pane = source("./chat-pane.tsx");
  const send = between(pane, "const handleSend = React.useCallback(", "const handleStop = React.useCallback");
  assert.match(pane, /useChat\(draft \? undefined : chatId\)/u);
  assert.match(send, /chatsApi\.createWithFirstMessage\(/u);
  const seed = send.indexOf("await installAppendedChatSnapshot(qc, chatId, updated)");
  const promote = send.indexOf("finishChatDraftSend(chatId, true)");
  const ownerGuard = send.indexOf("(firstDraft && (!mountedRef.current || chatIdRef.current !== chatId))");
  const start = send.indexOf("runGeneration(messageTurnId)");
  assert.ok(seed >= 0 && promote > seed && ownerGuard > promote && start > ownerGuard);
  assert.match(send, /await chatsApi\.abandonTurn\(chatId, messageTurnId\)/u);
  assert.doesNotMatch(send, /navigate\(/u);
  assert.match(pane, /enabled:\s*!draft &&\s*ready/u);
});


test("ordinary sends retain their generation-intent guard while draft promotion also checks its view owner", () => {
  const pane = source("./chat-pane.tsx");
  const send = between(pane, "const handleSend = React.useCallback(", "const handleStop = React.useCallback");
  assert.match(send, /if \(\s*generationIntentRef\.current !== generationIntent \|\|\s*\(firstDraft && \(!mountedRef\.current \|\| chatIdRef\.current !== chatId\)\)\s*\) \{/u);
  assert.doesNotMatch(send, /if \(!mountedRef\.current \|\| chatIdRef\.current !== chatId \|\| generationIntentRef\.current/u);
});

function failedChatResponse(id: string, category: string) {
  const response = chatReadResponse(id);
  response.chat.messages.push({
    id: `failure-${id}`,
    role: "assistant",
    content: "",
    createdAt: 2,
    providerFailure: { version: 1, category, attempts: 1, retryExhausted: false },
  } as (typeof response.chat.messages)[number]);
  return response;
}

for (const compacted of [false, true]) {
  test(`a failure-card compaction that settles (${compacted ? "compacted" : "not compacted"}) after leaving the chat leaves the next chat alone`, async () => {
    let settleCompaction!: (result: unknown) => void;
    const appended: string[] = [];
    const { router, queryClient } = await mountRoutedChatPane("chat-a", {
      "chats:get": (id) => failedChatResponse(String(id), id === "chat-a" ? "context_window" : "network"),
      "chats:compact": () => new Promise((resolve) => { settleCompaction = resolve; }),
      "chats:appendMessage": (chatId) => {
        appended.push(String(chatId));
        throw new Error("The follow-up could not be saved.");
      },
    });
    try {
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Compact and try again" }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await act(async () => {
        await router.navigate({ to: "/chat/$chatId", params: { chatId: "chat-b" } });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const tryAgain = await screen.findByRole("button", { name: "Try again" });
      assert.equal((tryAgain as HTMLButtonElement).disabled, false, "Chat B must not inherit chat A's pending action");

      await act(async () => {
        settleCompaction(compacted ? { compacted: true } : { compacted: false, reason: "already_compact" });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.deepEqual(appended, [], "Chat A's follow-up must not be sent from chat B's pane");
      assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Chat chat-b");
      const after = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
      assert.equal(after.disabled, false);
    } finally {
      cleanup();
      queryClient.clear();
    }
  });
}

test("a pending failure-card compaction keeps its chat busy while another chat starts one", async () => {
  const compactions: string[] = [];
  const { router, queryClient } = await mountRoutedChatPane("chat-a", {
    "chats:get": (id) => failedChatResponse(String(id), "context_window"),
    "chats:compact": (chatId) => {
      compactions.push(String(chatId));
      return new Promise(() => undefined);
    },
  });
  const visit = async (chatId: string) => {
    await act(async () => {
      await router.navigate({ to: "/chat/$chatId", params: { chatId } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const compactButton = async () =>
    (await screen.findByRole("button", { name: "Compact and try again" })) as HTMLButtonElement;
  try {
    await act(async () => {
      fireEvent.click(await compactButton());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await visit("chat-b");
    assert.equal((await compactButton()).disabled, false);
    await act(async () => {
      fireEvent.click(await compactButton());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await visit("chat-a");
    assert.equal((await compactButton()).disabled, true, "Chat A's compaction is still running");
    assert.deepEqual(compactions, ["chat-a", "chat-b"]);
  } finally {
    cleanup();
    queryClient.clear();
  }
});

test("a pending Resume in one chat leaves another interrupted chat's Resume usable", async () => {
  let rejectAppend!: (error: Error) => void;
  const { router, queryClient } = await mountRoutedChatPane("chat-a", {
    "chats:replyInterrupted": () => true,
    "chats:appendMessage": () => new Promise((_resolve, reject) => { rejectAppend = reject; }),
  });
  const resume = async () => (await screen.findByRole("button", { name: "Resume" })) as HTMLButtonElement;
  try {
    await act(async () => {
      fireEvent.click(await resume());
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    await act(async () => {
      await router.navigate({ to: "/chat/$chatId", params: { chatId: "chat-b" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal((await resume()).disabled, false, "Chat B must not inherit chat A's pending Resume");
    await act(async () => {
      rejectAppend(new Error("The follow-up could not be saved."));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.equal(screen.getByRole("heading", { level: 1 }).textContent, "Chat chat-b");
    assert.equal((await resume()).disabled, false);
  } finally {
    cleanup();
    queryClient.clear();
  }
});
