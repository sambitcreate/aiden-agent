// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import type { Chat, Provider, Workspace } from "../lib/types";
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

    // Promote Temporary chat to regular Chats.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-save-btn"));
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

    // Discard removes the ephemeral chat and resets to State 1.
    await act(async () => {
      fireEvent.click(screen.getByTestId("quick-chat-discard-btn"));
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

test("lastWorkspace default persistence selects persisted localStorage workspace ID", async () => {
  const prevStorage = globalThis.localStorage;
  const store = new Map<string, string>([["aiden-agent.workspaceId", "ws-second"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
    },
  });
  const { qc } = mountFloatingApp({
    "settings:get": () => ({
      lastProviderId: "lmstudio",
      lastModel: "local-model",
      quickChatDefaultPersistence: "lastWorkspace",
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
