// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import * as React from "react";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "./app-capabilities";
import { designModeAvailable, useDesignMode } from "./design-mode";
import { queryKeys } from "./queries";
import type { Chat, ChatMeta, Workspace } from "./types";

const ON = { designMode: true };
const OFF = { designMode: false };

const WORKSPACE: Workspace = {
  id: "site",
  name: "site",
  folderPath: "/Users/person/site",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

function chat(overrides: Partial<Chat> = {}): Chat {
  return { id: "chat-1", title: "Landing hero", workspaceId: "site", createdAt: 1, updatedAt: 5, messages: [], ...overrides };
}

let queryClient: QueryClient;
let server: Chat;
let saveDesignMode: (id: unknown, enabled: unknown) => Promise<Chat>;

beforeEach(() => {
  server = chat();
  saveDesignMode = async (_id, enabled) => {
    server = enabled ? { ...server, designMode: true } : chat();
    return server;
  };
  installBotTestIpc({
    "shortcut:get": () => null,
    "workspaces:list": () => [WORKSPACE],
    "chats:get": () => ({
      chat: server,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }),
    "chats:setDesignMode": (id, enabled) => saveDesignMode(id, enabled),
  });
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  });
  queryClient.setQueryData(queryKeys.chat("chat-1"), server);
  queryClient.setQueryData<ChatMeta[]>(queryKeys.chats, [server, chat({ id: "chat-2", title: "Pricing" })]);
  queryClient.setQueryData(queryKeys.workspaces, [WORKSPACE]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true }}>
        {children}
        <Toaster />
      </AppCapabilitiesProvider>
    </QueryClientProvider>
  );
}

const listed = (id: string) => queryClient.getQueryData<ChatMeta[]>(queryKeys.chats)?.find((row) => row.id === id);

test("design mode is offered only for project chats while the capability is on", () => {
  const folder = { folderPath: "/Users/person/site" };
  assert.equal(designModeAvailable(chat(), OFF, folder), false, "the capability gates it");
  assert.equal(designModeAvailable(undefined, ON), false);
  assert.equal(designModeAvailable(chat({ botId: "bot-1" }), ON, folder), false, "a Bot chat");
  assert.equal(designModeAvailable(chat({ workspaceId: "assistant" }), ON, folder), false, "an Assistant chat");
  assert.equal(
    designModeAvailable(chat({ owner: { kind: "design-project", projectId: "p" } }), ON, folder),
    false,
    "a feature-owned chat",
  );
  assert.equal(designModeAvailable(chat(), ON, {}), false, "a workspace with no folder");
  assert.equal(designModeAvailable(chat(), ON, null), false, "a workspace that no longer exists");
  assert.equal(designModeAvailable(chat(), ON, folder), true, "a folder workspace");
  assert.equal(
    designModeAvailable(chat({ workspaceId: undefined }), ON, { noWorkspace: true, folderPath: "/tmp/chats/x" }),
    true,
    "a No workspace chat in Aiden's own folder",
  );
  assert.equal(designModeAvailable(chat(), ON), true, "an unloaded workspace list does not hide it");
});

test("toggling flips the layout before the save answers, then keeps the saved value", async () => {
  let answer: (saved: Chat) => void = () => undefined;
  saveDesignMode = () => new Promise<Chat>((resolve) => (answer = resolve));
  const { result } = renderHook(() => useDesignMode("chat-1"), { wrapper });
  assert.deepEqual([result.current.available, result.current.on], [true, false]);

  act(() => result.current.toggle("toggle"));
  // The save is still unanswered here; the layout follows the cache at once.
  await waitFor(() => assert.equal(result.current.on, true, "on before the IPC promise resolves"));
  assert.equal(listed("chat-1")?.designMode, true, "the sidebar row follows");
  assert.equal(listed("chat-1")?.title, "Landing hero");
  assert.equal(listed("chat-2")?.designMode, undefined, "other chats are untouched");

  await act(async () => answer({ ...server, designMode: true }));
  assert.equal(result.current.on, true);
});

test("a refused save puts the previous layout back and says why once", async () => {
  saveDesignMode = async () => {
    throw new Error("Design mode is available in project chats only.");
  };
  const { result } = renderHook(() => useDesignMode("chat-1"), { wrapper });
  act(() => result.current.set(true, "shortcut"));
  assert.equal(queryClient.getQueryData<Chat>(queryKeys.chat("chat-1"))?.designMode, true, "flipped at once");
  await waitFor(() => assert.equal(result.current.on, false));
  assert.equal(listed("chat-1")?.designMode, undefined);
  await waitFor(() => assert.equal(screen.getAllByText("Design mode is available in project chats only.").length, 1));
});

test("another window turning design mode off reaches this one", async () => {
  queryClient.setQueryData(queryKeys.chat("chat-1"), chat({ designMode: true }));
  const { result } = renderHook(() => useDesignMode("chat-1"), { wrapper });
  assert.equal(result.current.on, true);
  act(() => emitBotTestNotification("chats:design-mode-changed", { chatId: "chat-1", designMode: false }));
  await waitFor(() => assert.equal(result.current.on, false));
  assert.equal(queryClient.getQueryData<Chat>(queryKeys.chat("chat-1"))?.title, "Landing hero", "the title stays");
});

test("with the capability off nothing is offered and nothing is saved", () => {
  let saves = 0;
  saveDesignMode = async () => {
    saves += 1;
    return server;
  };
  const { result } = renderHook(() => useDesignMode("chat-1"), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <AppCapabilitiesProvider capabilities={DISABLED_APP_CAPABILITIES}>{children}</AppCapabilitiesProvider>
      </QueryClientProvider>
    ),
  });
  queryClient.setQueryData(queryKeys.chat("chat-1"), chat({ designMode: true }));
  act(() => result.current.toggle("slash"));
  assert.deepEqual([result.current.available, result.current.on, saves], [false, false, 0]);
});
