// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { useDesignChatState } from "../design/design-layout";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { CommandSystemProvider } from "../lib/command-system";
import { DesignModeControlsContext } from "../lib/design-mode";
import { queryKeys } from "../lib/queries";
import type { Chat, ChatMeta, Workspace } from "../lib/types";
import { ariaKeyShortcut, effectiveBindings, prettyAccelerator } from "../shared/keybindings";
import { ChatTitleMenu, DesignModeToggle, WorkspaceToolButtons, type FoldableToolbarAction } from "./chat-top-bar";
import { EnvironmentPanelContext, type EnvironmentPanelContextValue } from "./environment-panel";

const WORKSPACE: Workspace = {
  id: "site",
  name: "site",
  folderPath: "/Users/person/site",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

const CHATS: Chat[] = [
  { id: "plain-chat", title: "Plain", workspaceId: "site", createdAt: 1, updatedAt: 5, messages: [] },
  { id: "bot-chat", title: "Bot", workspaceId: "site", botId: "bot-1", createdAt: 1, updatedAt: 5, messages: [] },
];

let queryClient: QueryClient;
let saved: Array<[string, boolean]> = [];
/** Saves wait here until the test lets them finish. */
let heldSaves: Array<() => void> = [];

beforeEach(() => {
  saved = [];
  heldSaves = [];
  installBotTestIpc({
    "shortcut:get": () => ({ overrides: { version: 1, commands: {} }, effective: effectiveBindings(undefined), global: [] }),
    "workspaces:list": () => [WORKSPACE],
    "chats:get": (id) => ({
      chat: CHATS.find((entry) => entry.id === id) ?? null,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }),
    "chats:setDesignMode": async (id, enabled) => {
      saved.push([id as string, enabled as boolean]);
      await new Promise<void>((release) => heldSaves.push(release));
      const chat = CHATS.find((entry) => entry.id === id);
      return chat ? { ...chat, designMode: enabled === true } : null;
    },
  });
  queryClient = createBotTestQueryClient();
  for (const chat of CHATS) queryClient.setQueryData(queryKeys.chat(chat.id), chat);
  queryClient.setQueryData<ChatMeta[]>(queryKeys.chats, CHATS);
  queryClient.setQueryData(queryKeys.workspaces, [WORKSPACE]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

/** The open chat's design state, as the chat area provides it, and the top bar of `barChatId`. */
function TopBar({ chatId, barChatId = chatId }: { chatId: string; barChatId?: string }) {
  const design = useDesignChatState(chatId, true);
  return (
    <DesignModeControlsContext.Provider value={design.controls}>
      <DesignModeToggle chatId={barChatId} />
    </DesignModeControlsContext.Provider>
  );
}

async function renderTopBar(props: { chatId: string; barChatId?: string }, designMode = true) {
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", designMode }}>
          <CommandSystemProvider>
            <TopBar {...props} />
          </CommandSystemProvider>
        </AppCapabilitiesProvider>
      </QueryClientProvider>,
    );
  });
}

const toggle = () => screen.queryByRole("button", { name: "Design mode" });

test("the Design mode button turns design mode on and off and shows which", async () => {
  await renderTopBar({ chatId: "plain-chat" });
  const button = toggle();
  assert.ok(button);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  // The default key, written for this computer's keyboard.
  assert.equal(button.getAttribute("aria-keyshortcuts"), ariaKeyShortcut("Command+Shift+L"));
  assert.equal(button.title, `Design mode (${prettyAccelerator("Command+Shift+L")})`);

  await act(async () => fireEvent.click(button));
  // The button and the chat show design mode on while the save is still running.
  await waitFor(() => assert.equal(button.getAttribute("aria-pressed"), "true"));
  assert.equal(queryClient.getQueryData<Chat>(queryKeys.chat("plain-chat"))?.designMode, true);
  await waitFor(() => assert.deepEqual(saved, [["plain-chat", true]]));
  assert.equal(heldSaves.length, 1, "the save has not finished");
  await act(async () => heldSaves.shift()?.());

  await act(async () => fireEvent.click(button));
  await waitFor(() => assert.equal(button.getAttribute("aria-pressed"), "false"));
  await waitFor(() =>
    assert.deepEqual(saved, [
      ["plain-chat", true],
      ["plain-chat", false],
    ]),
  );
  await act(async () => heldSaves.shift()?.());
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("there is no Design mode button while the flag is off, in a Bot chat, or for another chat", async () => {
  await renderTopBar({ chatId: "plain-chat" }, false);
  assert.equal(toggle(), null, "flag off");
  cleanup();
  await renderTopBar({ chatId: "bot-chat" });
  assert.equal(toggle(), null, "Bot chat");
  cleanup();
  // A top bar left over from the chat being switched away from.
  await renderTopBar({ chatId: "plain-chat", barChatId: "bot-chat" });
  assert.equal(toggle(), null, "another chat's controls");
  assert.deepEqual(saved, []);
});

/** Only the panel fields the workspace tools read. */
const STUB_PANEL = {
  devicesEnabled: false,
  subagentsEnabled: false,
  subagents: { chatId: "plain-chat" },
  subagentViews: [],
  artifacts: { views: [] },
  toolsPresented: false,
  tab: "browser",
  gitOperationBusy: false,
  showTools: () => {},
  closeTools: () => {},
} as unknown as EnvironmentPanelContextValue;

/** The header at `width` px of content, with Quick View and Terminal as the chat pane passes them. */
function renderToolbarAt(width: number, selected: string[], designOn = true) {
  const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-toolbar") ? width : 0;
    },
  });
  const action = (key: string, label: string): FoldableToolbarAction => ({
    key,
    label,
    icon: () => null,
    onSelect: () => selected.push(key),
    placement: key === "quick-view" ? "leading" : "tools",
    button: (
      <button type="button" onClick={() => selected.push(key)}>
        {label}
      </button>
    ),
  });
  try {
    render(
      <QueryClientProvider client={queryClient}>
        <CommandSystemProvider>
          <DesignModeControlsContext.Provider
            value={{ chatId: "plain-chat", on: designOn, set: () => {}, toggle: () => {} }}
          >
            <EnvironmentPanelContext.Provider value={STUB_PANEL}>
              <div data-toolbar>
                <WorkspaceToolButtons
                  chatId="plain-chat"
                  hasWorkspace
                  hasFolder
                  hasFolderAccess
                  isRepo={false}
                  foldable={[action("quick-view", "Show Quick View"), action("terminal", "Show terminal")]}
                />
              </div>
            </EnvironmentPanelContext.Provider>
          </DesignModeControlsContext.Provider>
        </CommandSystemProvider>
      </QueryClientProvider>,
    );
  } finally {
    if (realWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realWidth);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  }
}

test("a tight header in design mode, like its chat column, moves Quick View and Terminal into the tools menu", async () => {
  const selected: string[] = [];
  renderToolbarAt(1000, selected);
  assert.ok(screen.getByRole("button", { name: "Show Quick View" }), "a roomy header keeps both buttons");
  assert.ok(screen.getByRole("button", { name: "Show terminal" }));
  cleanup();

  // 360 px of header: the design column at its narrowest.
  renderToolbarAt(360, selected);
  assert.equal(screen.queryByRole("button", { name: "Show Quick View" }) === null, true, "Quick View folds away");
  assert.equal(screen.queryByRole("button", { name: "Show terminal" }) === null, true, "Terminal folds away");
  const menu = screen.getByRole("button", { name: "More workspace tools" });
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Enter" });
  });
  const items = await screen.findAllByRole("menuitem");
  assert.deepEqual(
    items.slice(0, 2).map((item) => item.textContent),
    ["Show Quick View", "Show terminal"],
    "they lead the menu",
  );
  await act(async () => {
    fireEvent.click(items[1]);
  });
  assert.deepEqual(selected, ["terminal"], "the menu row does what the button did");
  cleanup();

  // Outside design mode a narrow window keeps both buttons in the header.
  renderToolbarAt(360, selected, false);
  assert.ok(screen.getByRole("button", { name: "Show Quick View" }), "Quick View stays without design mode");
  assert.ok(screen.getByRole("button", { name: "Show terminal" }));
});

test("a truncated chat title keeps its full text as the name and on hover", () => {
  const title = "Design chat for the landing page and its pricing section";
  for (const persisted of [true, false]) {
    const { container } = render(
      <ChatTitleMenu
        title={title}
        persisted={persisted}
        onRename={async () => {}}
        onDuplicate={async () => {}}
        duplicateDisabledReason={null}
      />,
    );
    if (persisted) assert.ok(screen.getByRole("button", { name: title }), "the menu button is named by the whole title");
    assert.equal(container.querySelector(`[title="${title}"]`)?.textContent, title, "hovering the title shows all of it");
    cleanup();
  }
});
