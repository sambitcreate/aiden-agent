// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import type { Chat, Provider, Workspace } from "../lib/types";
import { applyChatMetadataUpdate } from "../shared/chat-metadata-update";
import { FloatingChatApp } from "./floating-chat-app";

const PROVIDERS: Provider[] = [
  {
    id: "lmstudio",
    kind: "openai",
    label: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    needsKey: false,
    hasKey: false,
    models: ["local-model"],
  },
];

const WORKSPACES: Workspace[] = [
  {
    id: "default",
    name: "No workspace",
    folderPath: "/tmp/nows",
    permission: "ask",
    noWorkspace: true,
    createdAt: 1,
    updatedAt: 10,
  },
  {
    id: "ws-project",
    name: "My App",
    folderPath: "/Users/dev/my-app",
    permission: "ask",
    createdAt: 1,
    updatedAt: 20,
  },
];

afterEach(() => cleanup());

function mountFloatingApp(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const calls = installBotTestIpc({
    "settings:get": () => ({
      lastProviderId: "lmstudio",
      lastModel: "local-model",
    }),
    "providers:list": () => PROVIDERS,
    "workspaces:list": () => WORKSPACES,
    "workspaces:createNoWorkspace": () => ({
      id: "nows-ephemeral-1",
      name: "No workspace",
      folderPath: "/tmp/nows-ephemeral-1",
      permission: "ask",
      noWorkspace: true,
      createdAt: 2,
      updatedAt: 2,
    }),
    "models:info": () => ({}),
    "modelPace:summaries": () => ({}),
    "modelInsights:status": () => ({ connected: false }),
    "quickChat:setMode": () => true,
    "quickChat:hide": () => true,
    "quickChat:suppressBlur": () => true,
    "quickChat:expandToMain": () => ({ ok: true }),
    "chats:createWithFirstMessage": (input: unknown) => {
      const req = input as {
        draftId: string;
        workspaceId: string;
        ephemeral?: true;
        message: { content: string };
      };
      return {
        id: req.draftId,
        workspaceId: req.workspaceId,
        ...(req.ephemeral ? { ephemeral: true as const } : {}),
        title: req.message.content,
        providerId: "lmstudio",
        model: "local-model",
        messages: [
          { id: "m-user-1", role: "user", content: req.message.content, createdAt: 10 },
        ],
        createdAt: 10,
        updatedAt: 10,
      } satisfies Chat;
    },
    "chats:promoteEphemeral": (chatId: unknown) => ({
      id: String(chatId),
      workspaceId: "nows-ephemeral-1",
      title: "Saved quick chat",
      providerId: "lmstudio",
      model: "local-model",
      messages: [
        { id: "m-user-1", role: "user", content: "Hello floating", createdAt: 10 },
      ],
      createdAt: 10,
      updatedAt: 12,
    }),
    "chat:start": (streamId: unknown) => ({
      streamId: String(streamId),
      accepted: true,
      started: true,
    }),
    "chat:cancel": () => true,
    ...overrides,
  });

  render(
    <QueryClientProvider client={qc}>
      <AppCapabilitiesProvider capabilities={DISABLED_APP_CAPABILITIES}>
        <TooltipProvider delayDuration={0}>
          <FloatingChatApp />
        </TooltipProvider>
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );

  return { calls, qc };
}

test("State 1 starter defaults to Temporary, omits Share screen, and morphs to State 2 modal on send", async () => {
  const { calls, qc } = mountFloatingApp();
  try {
    const input = await screen.findByTestId("quick-chat-input");
    assert.equal(screen.getByTestId("quick-chat-target-chip").textContent, "Temporary");
    // Explicitly verify Share screen is absent per user decision.
    assert.equal(screen.queryByText(/share screen/i), null);

    // Wait for model resolution so Send is enabled.
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Explain event loop" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });

    await waitFor(() => {
      assert.ok(screen.getByTestId("quick-chat-mini-modal"));
    });

    // Verified main window mode morph and ephemeral chat creation.
    assert.ok(
      calls.some((c) => c.channel === "quickChat:setMode" && c.args[0] === "modal"),
      "must switch window to modal mode on send",
    );
    const createCall = calls.find((c) => c.channel === "chats:createWithFirstMessage");
    assert.ok(createCall, "must persist ephemeral chat on first send");
    assert.equal((createCall.args[0] as { ephemeral?: boolean }).ephemeral, true);

    const startCall = calls.find((c) => c.channel === "chat:start");
    assert.ok(startCall, "must start generation");
    const streamId = String(startCall.args[0]);

    // Stream a complete paragraph delta so StreamingMarkdownReveal renders it live.
    await act(async () => {
      emitBotTestNotification("chat:delta", {
        streamId,
        delta: "The event loop coordinates tasks.\n\n",
      });
    });
    await waitFor(() => {
      assert.ok((document.body.textContent ?? "").includes("The event loop coordinates tasks."));
    });

    // Complete the stream and verify settled state before promoting.
    await act(async () => {
      emitBotTestNotification("chat:done", {
        streamId,
        fullContent: "The event loop coordinates tasks.",
      });
    });

    // Promote Temporary chat to regular Chats via the unified header status pill menu.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("quick-chat-status-pill"), { button: 0, ctrlKey: false });
    });
    const saveItem = await screen.findByTestId("quick-chat-save-btn");
    await act(async () => {
      fireEvent.click(saveItem);
    });
    assert.ok(calls.some((c) => c.channel === "chats:promoteEphemeral"));
  } finally {
    qc.clear();
  }
});

test("Expand mid-stream hands off cleanly and quickChat:handoff-complete resets to State 1 without cancelling", async () => {
  const { calls, qc } = mountFloatingApp();
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Stream then expand" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-mini-modal")));

    // Trigger Expand mid-stream.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-expand-modal"));
    });
    const expandCall = calls.find((c) => c.channel === "quickChat:expandToMain");
    assert.ok(expandCall, "must invoke quickChat:expandToMain");
    assert.equal((expandCall.args[0] as { kind: string }).kind, "chat");

    // When main confirms handoff-complete, floating resets to State 1 WITHOUT calling chat:cancel!
    await act(async () => {
      emitBotTestNotification("quickChat:handoff-complete", { kind: "chat", chatId: "any" });
    });
    await waitFor(() => {
      assert.ok(screen.getByTestId("quick-chat-stage-starter"));
    });
    assert.equal(
      calls.some((c) => c.channel === "chat:cancel"),
      false,
      "handoff-complete must NOT cancel the transferred stream",
    );
  } finally {
    qc.clear();
  }
});

test("createWithFirstMessage failure rolls back to State 1 and retrying Send succeeds cleanly", async () => {
  let attempt = 0;
  const { calls, qc } = mountFloatingApp({
    "chats:createWithFirstMessage": (input: unknown) => {
      attempt += 1;
      if (attempt === 1) throw new Error("Disk full");
      const req = input as {
        draftId: string;
        workspaceId: string;
        ephemeral?: true;
        message: { content: string };
      };
      return {
        id: req.draftId,
        workspaceId: req.workspaceId,
        ...(req.ephemeral ? { ephemeral: true as const } : {}),
        title: req.message.content,
        providerId: "lmstudio",
        model: "local-model",
        messages: [{ id: "m-1", role: "user", content: req.message.content, createdAt: 10 }],
        createdAt: 10,
        updatedAt: 10,
      } satisfies Chat;
    },
  });
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Retry this prompt" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    // Rolled back cleanly to State 1 starter with original text preserved.
    await waitFor(() => {
      assert.ok(screen.getByTestId("quick-chat-stage-starter"));
      assert.equal((screen.getByTestId("quick-chat-input") as HTMLTextAreaElement).value, "Retry this prompt");
    });

    // Retry Send -> uses createWithFirstMessage again (not appendMessage) and enters State 2.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-mini-modal")));
    assert.equal(calls.filter((c) => c.channel === "chats:createWithFirstMessage").length, 2);
    assert.equal(calls.filter((c) => c.channel === "chats:appendMessage").length, 0);
  } finally {
    qc.clear();
  }
});

test("rejected chat:start clears Thinking state and displays error, and Discard cancels + removes ephemeral chat", async () => {
  const { calls, qc } = mountFloatingApp({
    "chat:start": (streamId: unknown) => ({
      streamId: String(streamId),
      accepted: false,
      started: false,
      error: "Provider is busy.",
    }),
    "chats:remove": () => true,
  });
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Trigger rejection" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => {
      assert.ok((document.body.textContent ?? "").includes("Generation was rejected"));
    });
    assert.equal(screen.queryByTestId("quick-chat-stop-btn"), null);

    // Discard removes the ephemeral chat and resets to State 1 via the unified header status pill menu.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("quick-chat-status-pill"), { button: 0, ctrlKey: false });
    });
    const discardItem = await screen.findByTestId("quick-chat-discard-btn");
    await act(async () => {
      fireEvent.click(discardItem);
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-stage-starter")));
    assert.ok(calls.some((c) => c.channel === "chats:remove"));
  } finally {
    qc.clear();
  }
});

test("failed expandToMain unlocks Expand button and Stop clears queued follow-ups without auto-sending", async () => {
  let expandAttempts = 0;
  const { calls, qc } = mountFloatingApp({
    "quickChat:expandToMain": () => {
      expandAttempts += 1;
      return expandAttempts === 1 ? { ok: false } : { ok: true };
    },
    "chats:get": () => null,
  });
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "First turn" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-mini-modal")));

    // First expand fails -> button must unlock so user can retry.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-expand-modal"));
    });
    await waitFor(() => {
      assert.equal((screen.getByTestId("quick-chat-expand-modal") as HTMLButtonElement).disabled, false);
    });

    // Queue a follow-up while generating, then press Stop -> restores draft and does NOT auto-send.
    const modalInput = screen.getByTestId("quick-chat-input") as HTMLTextAreaElement;
    fireEvent.change(modalInput, { target: { value: "Queued follow-up" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => {
      assert.ok((document.body.textContent ?? "").includes("1 follow-up queued"));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-stop-btn"));
    });
    const startCall = calls.find((c) => c.channel === "chat:start");
    assert.ok(startCall);
    await act(async () => {
      emitBotTestNotification("chat:done", {
        streamId: String(startCall.args[0]),
        fullContent: "",
      });
    });

    assert.equal(calls.filter((c) => c.channel === "chat:cancel").length, 1);
    assert.equal(calls.filter((c) => c.channel === "chats:appendMessage").length, 0);
    assert.equal(modalInput.value, "Queued follow-up");
  } finally {
    qc.clear();
  }
});

test("State 1 draft Expand preserves ephemeral flag and Stop restores queued attachments", async () => {
  const sampleAttachment = {
    id: "att-1",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 12,
    text: "hello notes",
  };
  const { calls, qc } = mountFloatingApp({
    "attachments:pickAndRead": () => ({ attachments: [sampleAttachment], skipped: [] }),
    "chats:get": () => null,
  });
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Keep me temporary" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    // Expanding State 1 Temporary draft must preserve ephemeral: true.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-expand-starter"));
    });
    const draftExpand = calls.find((c) => c.channel === "quickChat:expandToMain");
    assert.ok(draftExpand);
    assert.equal((draftExpand.args[0] as { kind: string }).kind, "draft");
    assert.equal((draftExpand.args[0] as { ephemeral?: boolean }).ephemeral, true);

    // Complete handoff so we're back in State 1, then start a stream and queue an attachment.
    await act(async () => {
      emitBotTestNotification("quickChat:handoff-complete", { kind: "draft" });
    });
    await waitFor(() => {
      fireEvent.change(screen.getByTestId("quick-chat-input"), { target: { value: "Start stream" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-mini-modal")));

    // Attach a file and queue a follow-up while generating.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-attach-btn"));
    });
    await waitFor(() => {
      assert.ok((document.body.textContent ?? "").includes("notes.txt"));
    });
    fireEvent.change(screen.getByTestId("quick-chat-input"), { target: { value: "Follow-up with file" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => {
      assert.ok((document.body.textContent ?? "").includes("1 follow-up queued"));
    });

    // Stop must restore both the queued text AND its attachment chip.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-stop-btn"));
    });
    assert.equal(
      (screen.getByTestId("quick-chat-input") as HTMLTextAreaElement).value,
      "Follow-up with file",
    );
    assert.ok(
      (document.body.textContent ?? "").includes("notes.txt"),
      "Stop must restore queued attachments into the composer",
    );
  } finally {
    qc.clear();
  }
});

test("lastWorkspace default persistence reads shared main-process lastWorkspaceId even when Quick Chat localStorage is isolated", async () => {
  const prevStorage = globalThis.localStorage;
  // Model packaged file:// isolation: Quick Chat's own document localStorage points elsewhere/empty.
  const isolatedQuickChatStorage = new Map<string, string>([
    ["aiden-agent.workspaceId", "ws-project"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => isolatedQuickChatStorage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        isolatedQuickChatStorage.set(key, value);
      },
      removeItem: (key: string) => {
        isolatedQuickChatStorage.delete(key);
      },
      clear: () => isolatedQuickChatStorage.clear(),
    },
  });
  const { qc } = mountFloatingApp({
    "settings:get": () => ({
      lastProviderId: "lmstudio",
      lastModel: "local-model",
      quickChatDefaultPersistence: "lastWorkspace",
      lastWorkspaceId: "ws-second",
    }),
    "workspaces:list": () => [
      ...WORKSPACES,
      {
        id: "ws-second",
        name: "Second Project",
        folderPath: "/Users/dev/second-project",
        permission: "ask",
        createdAt: 2,
        updatedAt: 30,
      },
    ],
  });
  try {
    await waitFor(() => {
      assert.ok(
        (screen.getByTestId("quick-chat-target-chip").textContent ?? "").includes("Second Project"),
      );
    });
  } finally {
    qc.clear();
    if (prevStorage) {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: prevStorage });
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  }
});

test("lastWorkspace updates immediately when a delayed settings write lands via settings:controls-changed", async () => {
  let activeLastWorkspaceId = "ws-project";
  const { qc } = mountFloatingApp({
    "settings:get": () => ({
      lastProviderId: "lmstudio",
      lastModel: "local-model",
      quickChatDefaultPersistence: "lastWorkspace",
      lastWorkspaceId: activeLastWorkspaceId,
    }),
    "workspaces:list": () => [
      ...WORKSPACES,
      {
        id: "ws-second",
        name: "Second Project",
        folderPath: "/Users/dev/second-project",
        permission: "ask",
        createdAt: 2,
        updatedAt: 30,
      },
    ],
  });
  try {
    await waitFor(() => {
      assert.ok(
        (screen.getByTestId("quick-chat-target-chip").textContent ?? "").includes("My App"),
      );
    });
    // Simulate main window switching workspace while durable write is in flight and broadcasting change.
    activeLastWorkspaceId = "ws-second";
    await act(async () => {
      emitBotTestNotification("settings:controls-changed", {});
    });
    await waitFor(() => {
      assert.ok(
        (screen.getByTestId("quick-chat-target-chip").textContent ?? "").includes("Second Project"),
      );
    });
  } finally {
    qc.clear();
  }
});

test("auto-title chats:metadata-updated preserves Temporary state until explicit ephemeral: false", () => {
  const tempChat: Chat = {
    id: "chat-temp-1",
    workspaceId: "nows-1",
    ephemeral: true,
    title: "New chat",
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };

  // Auto-title with ephemeral: true keeps Temporary flag.
  const titledWithFlag = applyChatMetadataUpdate(tempChat, {
    chatId: "chat-temp-1",
    workspaceId: "nows-1",
    title: "Refactor auth flow",
    updatedAt: 2,
    ephemeral: true,
  });
  assert.equal(titledWithFlag.title, "Refactor auth flow");
  assert.equal(titledWithFlag.ephemeral, true);

  // Metadata update omitting ephemeral (e.g., rename/legacy emitter) still preserves Temporary flag.
  const titledOmitted = applyChatMetadataUpdate(titledWithFlag, {
    chatId: "chat-temp-1",
    workspaceId: "nows-1",
    title: "Auth notes",
    updatedAt: 3,
  });
  assert.equal(titledOmitted.title, "Auth notes");
  assert.equal(titledOmitted.ephemeral, true);

  // Explicit promotion or attach sends ephemeral: false and clears Temporary flag.
  const promoted = applyChatMetadataUpdate(titledOmitted, {
    chatId: "chat-temp-1",
    workspaceId: "ws-project",
    title: "Auth notes",
    updatedAt: 4,
    ephemeral: false,
  });
  assert.equal(promoted.workspaceId, "ws-project");
  assert.equal(promoted.ephemeral, undefined);
});

test("external hide and reopen close already-open starter pickers and restore starter mode", async () => {
  const { calls, qc } = mountFloatingApp();
  try {
    await screen.findByTestId("quick-chat-input");
    // Wait for initial model resolution so the model picker trigger is enabled.
    await waitFor(() => {
      const modelTrigger = screen.getByRole("button", { name: /Selected model:/i }) as HTMLButtonElement;
      assert.equal(modelTrigger.disabled, false);
    });

    // 1. Open the starter target dropdown until it reaches open=true in the DOM.
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("quick-chat-target-chip"), {
        button: 0,
        ctrlKey: false,
      });
    });
    await screen.findByTestId("quick-chat-target-popover");
    assert.ok(
      calls.some((c) => c.channel === "quickChat:setMode" && c.args[0] === "starter-popover"),
      "opening target picker must expand starter-popover stage",
    );

    // External hide (blur / global toggle) must close the already-open target dropdown immediately.
    await act(async () => {
      emitBotTestNotification("quickChat:hidden", undefined);
    });
    await waitFor(() => {
      assert.equal(screen.queryByTestId("quick-chat-target-popover"), null);
    });

    // Reopening keeps the target picker closed and leaves it usable on the next click.
    await act(async () => {
      emitBotTestNotification("quickChat:opened", { source: "hotkey" });
    });
    assert.equal(screen.queryByTestId("quick-chat-target-popover"), null);

    // 2. Open the starter ModelPicker until its filter input is mounted (open=true).
    const modelTrigger = screen.getByRole("button", { name: /Selected model:/i });
    await act(async () => {
      fireEvent.click(modelTrigger);
    });
    await screen.findByRole("dialog", { name: "Choose agent" });

    // Reopening via quickChat:opened (even without a prior quickChat:hidden) must close
    // the mounted model popover AND sync main back to compact starter mode.
    const modeCallsBeforeReopen = calls.filter((c) => c.channel === "quickChat:setMode").length;
    await act(async () => {
      emitBotTestNotification("quickChat:opened", { source: "hotkey" });
    });
    await waitFor(() => {
      assert.equal(screen.queryByRole("dialog", { name: "Choose agent" }), null);
    });
    const modeCallsAfterReopen = calls
      .filter((c) => c.channel === "quickChat:setMode")
      .slice(modeCallsBeforeReopen)
      .map((c) => c.args[0]);
    assert.deepEqual(modeCallsAfterReopen, ["starter"]);

    // Clicking the model trigger after reopen opens cleanly again.
    await act(async () => {
      fireEvent.click(modelTrigger);
    });
    await screen.findByRole("dialog", { name: "Choose agent" });
  } finally {
    qc.clear();
  }
});

test("external hide and reopen preserve State 2 mini-modal stage and draft without resetting to starter", async () => {
  const { calls, qc } = mountFloatingApp();
  try {
    const input = await screen.findByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Keep modal alive across hide" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(screen.getByTestId("quick-chat-mini-modal")));

    // Type a follow-up draft inside the modal before hiding.
    const modalInput = screen.getByTestId("quick-chat-input") as HTMLTextAreaElement;
    fireEvent.change(modalInput, { target: { value: "Unsent follow-up" } });

    const modeCountBeforeHide = calls.filter((c) => c.channel === "quickChat:setMode").length;

    await act(async () => {
      emitBotTestNotification("quickChat:hidden", undefined);
    });
    await act(async () => {
      emitBotTestNotification("quickChat:opened", { source: "hotkey" });
    });

    assert.ok(screen.getByTestId("quick-chat-mini-modal"));
    assert.equal(screen.queryByTestId("quick-chat-stage-starter"), null);
    assert.equal((screen.getByTestId("quick-chat-input") as HTMLTextAreaElement).value, "Unsent follow-up");
    const modeCallsAfterHide = calls
      .filter((c) => c.channel === "quickChat:setMode")
      .slice(modeCountBeforeHide);
    assert.deepEqual(modeCallsAfterHide, []);
  } finally {
    qc.clear();
  }
});

test("an Agent Slider stop picked in Quick Chat sends its effort with the first message, the turn and later picks", async () => {
  // A save can be held open (a pick just before Send) or refused (main busy).
  let holdSave: Promise<void> | undefined;
  let refuseSave = false;
  const quickChat = (id: unknown, providerId: unknown, model: unknown, level?: unknown): Chat => ({
    id: String(id),
    workspaceId: "nows-ephemeral-1",
    ephemeral: true,
    title: "Think hard",
    providerId: String(providerId),
    model: String(model),
    ...(typeof level === "string" ? { thinkingLevel: level as GenerationThinkingLevel } : {}),
    messages: [{ id: "m-user-1", role: "user", content: "Think hard", createdAt: 10 }],
    createdAt: 10,
    updatedAt: 11,
  });
  const { calls, qc } = mountFloatingApp({
    "chats:setModel": async (id: unknown, providerId: unknown, model: unknown, level?: unknown) => {
      if (holdSave) await holdSave;
      if (refuseSave) throw new Error("This chat is busy.");
      return quickChat(id, providerId, model, level);
    },
    // The follow-up runs on the Quick stop the pick just saved (no effort of its own).
    "chats:appendMessage": (id: unknown) => quickChat(id, "lmstudio", "local-model"),
    "settings:get": () => ({
      lastProviderId: "lmstudio",
      lastModel: "local-model",
      agentSlider: {
        version: 1,
        homeStopId: "quick",
        stops: [
          { id: "quick", label: "Quick", providerId: "lmstudio", model: "local-model" },
          { id: "deep", label: "Deep", providerId: "lmstudio", model: "local-model", thinkingLevel: "high" },
          { id: "spare", label: "Spare" },
        ],
      },
    }),
  });
  try {
    const input = await screen.findByTestId("quick-chat-input");
    const trigger = await waitFor(() => {
      const button = screen.getByRole("button", { name: /Quick on the Agent Slider/u }) as HTMLButtonElement;
      assert.equal(button.disabled, false);
      return button;
    });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const slider = await screen.findByRole("slider", { name: "Agent Slider" });
    await act(async () => {
      fireEvent.keyDown(slider, { key: "ArrowRight" });
    });
    await waitFor(() =>
      assert.match(trigger.getAttribute("aria-label") ?? "", /Deep on the Agent Slider/u),
    );

    await waitFor(() => {
      fireEvent.change(input, { target: { value: "Think hard" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    await waitFor(() => assert.ok(calls.some((call) => call.channel === "chat:start")));

    const create = calls.find((call) => call.channel === "chats:createWithFirstMessage");
    assert.equal((create?.args[0] as { thinkingLevel?: string }).thinkingLevel, "high");
    const start = calls.find((call) => call.channel === "chat:start");
    assert.ok(
      start?.args.some(
        (arg) => typeof arg === "object" && arg !== null && (arg as { thinkingLevel?: string }).thinkingLevel === "high",
      ),
      "the turn asks for the stop's effort",
    );

    // Once the chat exists, a stop is saved on the chat itself, so a handoff
    // or reopen sees it; a stop without a level clears the chat's own level.
    const chatId = String((create?.args[0] as { draftId: string }).draftId);
    await act(async () => {
      emitBotTestNotification("chat:done", { streamId: String(start?.args[0]), fullContent: "Done." });
    });
    const modalTrigger = await waitFor(() => {
      const button = screen.getByRole("button", { name: /Deep on the Agent Slider/u }) as HTMLButtonElement;
      assert.equal(button.disabled, false);
      return button;
    });
    await act(async () => {
      fireEvent.click(modalTrigger);
    });
    await act(async () => {
      fireEvent.keyDown(await screen.findByRole("slider", { name: "Agent Slider" }), { key: "ArrowLeft" });
    });
    await waitFor(() => {
      const save = calls.find((call) => call.channel === "chats:setModel");
      assert.deepEqual(save?.args, [chatId, "lmstudio", "local-model", null]);
    });
    await waitFor(() =>
      assert.match(modalTrigger.getAttribute("aria-label") ?? "", /Quick on the Agent Slider/u),
    );

    // Main reconciled the chat's level (a clamp): the slider follows what ran.
    await act(async () => {
      emitBotTestNotification("chats:metadata-updated", {
        chatId,
        title: "Think hard",
        updatedAt: 20,
        thinkingLevel: "high",
      });
    });
    await waitFor(() =>
      assert.match(modalTrigger.getAttribute("aria-label") ?? "", /Deep on the Agent Slider/u),
    );

    // Send right after a pick waits for the pick to be saved on the chat, so
    // the turn and the chat's stored stop agree.
    let releaseSave = () => {};
    holdSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const sliderOpen = async (trigger: HTMLElement) => {
      if (!screen.queryByRole("slider", { name: "Agent Slider" })) {
        await act(async () => {
          fireEvent.click(trigger);
        });
      }
      return screen.findByRole("slider", { name: "Agent Slider" });
    };
    const sliderClosed = async (trigger: HTMLElement) => {
      if (screen.queryByRole("slider", { name: "Agent Slider" })) {
        await act(async () => {
          fireEvent.click(trigger);
        });
      }
      await waitFor(() => assert.equal(screen.queryByRole("slider", { name: "Agent Slider" }), null));
    };
    const pickedQuick = await sliderOpen(modalTrigger);
    await act(async () => {
      fireEvent.keyDown(pickedQuick, { key: "ArrowLeft" });
    });
    await sliderClosed(modalTrigger);
    const followUp = screen.getByTestId("quick-chat-input");
    await waitFor(() => {
      fireEvent.change(followUp, { target: { value: "Now quickly" } });
      assert.equal((screen.getByTestId("quick-chat-send-btn") as HTMLButtonElement).disabled, false);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-send-btn"));
    });
    assert.equal(
      calls.some((call) => call.channel === "chats:appendMessage"),
      false,
      "the turn waits for the pick's save",
    );
    await act(async () => {
      releaseSave();
      holdSave = undefined;
    });
    await waitFor(() => assert.ok(calls.some((call) => call.channel === "chats:appendMessage")));
    const saves = calls.filter((call) => call.channel === "chats:setModel");
    assert.deepEqual(saves[saves.length - 1]?.args, [chatId, "lmstudio", "local-model", null]);
    const turns = calls.filter((call) => call.channel === "chat:start");
    const lastTurn = turns[turns.length - 1];
    assert.equal(
      lastTurn?.args.some(
        (arg: unknown) => typeof arg === "object" && arg !== null && "thinkingLevel" in (arg as object),
      ),
      false,
      "the follow-up runs on the stop just saved, which has no effort of its own",
    );
    await act(async () => {
      emitBotTestNotification("chat:done", { streamId: String(lastTurn?.args[0]), fullContent: "Done." });
    });

    // Main refuses a pick: the slider shows the chat's own selection again.
    refuseSave = true;
    const quickTrigger = await waitFor(() => {
      const button = screen.getByRole("button", { name: /on the Agent Slider/u }) as HTMLButtonElement;
      assert.equal(button.disabled, false);
      return button;
    });
    const refused = await sliderOpen(quickTrigger);
    await act(async () => {
      fireEvent.keyDown(refused, { key: "ArrowRight" });
    });
    await waitFor(() => {
      const refusedSave = calls.filter((call) => call.channel === "chats:setModel").pop();
      assert.deepEqual(refusedSave?.args, [chatId, "lmstudio", "local-model", "high"]);
    });
    await waitFor(() =>
      assert.match(quickTrigger.getAttribute("aria-label") ?? "", /Quick on the Agent Slider/u),
    );
  } finally {
    qc.clear();
  }
});
