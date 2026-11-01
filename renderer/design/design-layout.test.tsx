// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import {
  EnvironmentPanelProvider,
  useEnvironmentPanel,
  type EnvironmentPanelContextValue,
} from "../components/environment-panel";
import { WorkspaceTerminalProvider } from "../components/terminal-drawer";
import { SplitView } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { CommandSystemProvider } from "../lib/command-system";
import { applyDesignModeToCache } from "../lib/design-mode";
import { queryKeys } from "../lib/queries";
import type { Chat, ChatMeta, Workspace } from "../lib/types";
import { WorkspaceProvider } from "../lib/workspace-context";
import { DesignWorkbench, useDesignChatState } from "./design-layout";

// The lazy canvas imports React Flow's CSS, which Node cannot load; tests get an empty module.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export%20default%20%7B%7D", shortCircuit: true };
    return next(specifier, context);
  },
});

const ENVIRONMENT_WIDTH_KEY = "aiden-agent.environment.width";
const DESIGN_CHAT_WIDTH_KEY = "aiden-agent.design.chat-width";
const SIDEBAR_COLLAPSED_KEY = "aiden-agent.sidebar-collapsed";

const WORKSPACE: Workspace = {
  id: "site",
  name: "site",
  folderPath: "/Users/person/site",
  permission: "full",
  createdAt: 1,
  updatedAt: 1,
};

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
  return { id, title: id, workspaceId: "site", createdAt: 1, updatedAt: 5, messages: [], ...overrides };
}

let queryClient: QueryClient;
let containerWidth = 1400;
let widenCalls = 0;
let panel!: EnvironmentPanelContextValue;
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  containerWidth = 1400;
  widenCalls = 0;
  // happy-dom does no layout, so every measured box reports the test's width.
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: containerWidth, width: containerWidth, height: 800, toJSON() {} } as DOMRect;
  };
  const chats = [chat("design-chat", { designMode: true }), chat("plain-chat")];
  installBotTestIpc({
    "shortcut:get": () => null,
    "workspaces:list": () => [WORKSPACE],
    "browser:link-preference": () => "ask",
    "chats:get": (id) => ({
      chat: chats.find((entry) => entry.id === id) ?? null,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }),
    "app:widenForDesign": () => {
      widenCalls += 1;
      return { widened: true };
    },
  });
  queryClient = createBotTestQueryClient();
  for (const entry of chats) queryClient.setQueryData(queryKeys.chat(entry.id), entry);
  queryClient.setQueryData<ChatMeta[]>(queryKeys.chats, chats);
  queryClient.setQueryData(queryKeys.workspaces, [WORKSPACE]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  window.localStorage.clear();
  HTMLElement.prototype.getBoundingClientRect = realRect;
});

function PanelProbe() {
  panel = useEnvironmentPanel();
  return null;
}

function DesignChat({ chatId }: { chatId: string }) {
  const design = useDesignChatState(chatId, true);
  return (
    <DesignWorkbench chatId={chatId} design={design.state} suppressed={false}>
      <main aria-label={`Chat ${chatId}`} />
    </DesignWorkbench>
  );
}

function Shell({ chatId }: { chatId: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true }}>
        <CommandSystemProvider>
        <WorkspaceProvider>
          <WorkspaceTerminalProvider>
            <EnvironmentPanelProvider>
              <PanelProbe />
              <SplitView storageKey="aiden-agent" sidebar={<nav aria-label="Chats" />}>
                <DesignChat chatId={chatId} />
              </SplitView>
            </EnvironmentPanelProvider>
          </WorkspaceTerminalProvider>
        </WorkspaceProvider>
        </CommandSystemProvider>
      </AppCapabilitiesProvider>
    </QueryClientProvider>
  );
}

const chatColumn = () => document.querySelector<HTMLElement>("[data-design-mode]");
const canvasRegion = () => document.querySelector<HTMLElement>("[data-design-canvas-region]");
const toolsSurface = () => document.querySelector<HTMLElement>('[data-environment-surface="tools"]');

/** The person has the panel open on Terminal at 700 px. */
async function renderWithTerminalPanel(chatId: string) {
  localStorage.setItem(ENVIRONMENT_WIDTH_KEY, "700");
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Shell chatId={chatId} />);
  });
  await act(async () => panel.showTools("terminal"));
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"]);
  return view;
}

async function setDesignMode(chatId: string, on: boolean) {
  await act(async () => applyDesignModeToCache(queryClient, chatId, on));
  // The query cache tells its subscribers on a timer, so wait for the layout to follow.
  await waitFor(() =>
    assert.equal(document.querySelector("[data-design-layout]")?.getAttribute("data-design-layout"), on ? "on" : "off"),
  );
}

test("a design chat on a wide window splits into a 420 px chat column and an inline canvas", async () => {
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  assert.equal(chatColumn()?.style.width, "420px");
  assert.equal(canvasRegion()?.dataset.designCanvasRegion, "inline");
  assert.equal(canvasRegion()?.style.width, "980px");
  assert.equal(panel.toolsOpen, false, "the canvas takes the panel's place");
  assert.equal(toolsSurface()?.dataset.state ?? "closed", "closed");
  await waitFor(() => screen.getByRole("region", { name: "Design canvas" }));
  screen.getByText("Ask Aiden to design something, or add a note.");
  assert.equal(widenCalls, 0, "a wide window is left alone");
});

test("leaving design mode puts back the panel's tab, width and open state", async () => {
  await renderWithTerminalPanel("plain-chat");
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), null, "the sidebar starts open");

  await setDesignMode("plain-chat", true);
  assert.equal(panel.toolsOpen, false, "entering closes the panel");
  assert.ok(canvasRegion(), "the canvas shows");
  // happy-dom's window is 1024 px wide, under the 1100 px sidebar rule.
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "1", "entry collapses the sidebar");

  await setDesignMode("plain-chat", false);
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"], "Terminal is open again");
  assert.equal(localStorage.getItem(ENVIRONMENT_WIDTH_KEY), "700");
  assert.equal(canvasRegion(), null);
  assert.equal(chatColumn(), null);
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "0", "the sidebar design mode collapsed reopens");
});

test("a sidebar the person had collapsed stays collapsed after design mode", async () => {
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  await setDesignMode("plain-chat", true);
  await setDesignMode("plain-chat", false);
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "1");
});

test("switching from a design chat to a normal chat never shows the canvas for the normal chat", async () => {
  const view = await renderWithTerminalPanel("plain-chat");
  await act(async () => {
    view.rerender(<Shell chatId="design-chat" />);
  });
  assert.equal(canvasRegion()?.dataset.chatId, "design-chat");
  assert.equal(panel.toolsOpen, false, "the design chat closes the panel");

  // Every commit's DOM changes are recorded, so a canvas that showed the
  // normal chat for even one render would leave a record behind.
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
  await act(async () => {
    view.rerender(<Shell chatId="plain-chat" />);
  });
  await waitFor(() => assert.equal(canvasRegion(), null));
  records.push(...observer.takeRecords());
  observer.disconnect();
  const wrong = records.filter(
    (record) =>
      (record.type === "attributes" &&
        record.attributeName === "data-chat-id" &&
        (record.target as HTMLElement).hasAttribute("data-design-canvas-region")) ||
      [...record.addedNodes].some(
        (node) =>
          node instanceof HTMLElement &&
          (node.matches("[data-design-canvas-region], [data-design-mode]") ||
            node.querySelector("[data-design-canvas-region], [data-design-mode]") !== null),
      ),
  );
  assert.equal(wrong.length, 0, "no render put the normal chat in design layout");
  assert.ok(records.length > 0, "the switch did change the DOM");
  assert.equal(canvasRegion(), null);
  assert.equal(chatColumn(), null);
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"], "the normal chat gets the panel back");

  await act(async () => {
    view.rerender(<Shell chatId="design-chat" />);
  });
  assert.equal(canvasRegion()?.dataset.chatId, "design-chat");
  assert.equal(panel.toolsOpen, false);
});

test("on a narrow window the canvas floats over the chat instead of squeezing it", async () => {
  containerWidth = 800;
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  assert.equal(canvasRegion()?.dataset.designCanvasRegion, "overlay");
  const column = chatColumn();
  assert.ok(column);
  // The column is not given a fixed width, so it keeps the whole 800 px.
  assert.equal(column.style.width, "");
  assert.equal(screen.queryByRole("separator", { name: "Resize chat" }), null, "nothing to drag in overlay");
});

test("dragging the divider saves the design chat width and leaves the panel width alone", async () => {
  localStorage.setItem(ENVIRONMENT_WIDTH_KEY, "700");
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  const divider = screen.getByRole("separator", { name: "Resize chat" });
  await act(async () => {
    fireEvent.pointerDown(divider, { button: 0, clientX: 420, pointerId: 1 });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 470 }));
  });
  assert.equal(chatColumn()?.style.width, "470px", "the column follows the drag");
  assert.equal(localStorage.getItem(DESIGN_CHAT_WIDTH_KEY), null, "nothing is saved mid-drag");
  await act(async () => {
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: 900 }));
  });
  assert.equal(localStorage.getItem(DESIGN_CHAT_WIDTH_KEY), "560", "the drag stops at the 560 px maximum");
  assert.equal(chatColumn()?.style.width, "560px");
  assert.equal(localStorage.getItem(ENVIRONMENT_WIDTH_KEY), "700");

  divider.focus();
  await act(async () => {
    fireEvent.keyDown(divider, { key: "Home" });
  });
  assert.equal(localStorage.getItem(DESIGN_CHAT_WIDTH_KEY), "360");
});
