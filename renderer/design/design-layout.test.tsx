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
import { applyDesignModeToCache, useDesignModeControls } from "../lib/design-mode";
import { queryKeys } from "../lib/queries";
import { emptyDesignCanvas } from "../shared/design-canvas/schema";
import { effectiveBindings } from "../shared/keybindings";
import type { Chat, ChatMeta, Workspace } from "../lib/types";
import { WorkspaceProvider } from "../lib/workspace-context";
import { DesignPaneSwitch } from "../components/chat-top-bar";
import { DesignChatBody, DesignModeBannerSlot, DesignWorkbench, useDesignChatState } from "./design-layout";

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
const SAVED_WORKBENCH_KEY = "aiden-agent.design.saved-workbench";

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
/** The window's width; the open sidebar (260 px by default) takes its share of it. */
function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
}
let widenCalls = 0;
let widenResult = { widened: true };
let canWidenResult = { canWiden: false };
let panel!: EnvironmentPanelContextValue;
let savedDesignModes: Array<[string, boolean]> = [];
const realRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  containerWidth = 1400;
  setWindowWidth(1024);
  widenCalls = 0;
  widenResult = { widened: true };
  canWidenResult = { canWiden: false };
  savedDesignModes = [];
  // happy-dom does no layout, so every measured box reports the test's width.
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, top: 0, left: 0, bottom: 800, right: containerWidth, width: containerWidth, height: 800, toJSON() {} } as DOMRect;
  };
  const chats = [
    chat("design-chat", { designMode: true }),
    chat("second-design-chat", { designMode: true }),
    chat("plain-chat"),
    chat("bot-chat", { botId: "bot-1" }),
  ];
  installBotTestIpc({
    "shortcut:get": () => ({ overrides: { version: 1, commands: {} }, effective: effectiveBindings(undefined), global: [] }),
    "workspaces:list": () => [WORKSPACE],
    "browser:link-preference": () => "ask",
    "chats:get": (id) => ({
      chat: chats.find((entry) => entry.id === id) ?? null,
      imageArtifactRecoveryPending: false,
      imageArtifactRecoveryUnavailable: false,
      reconciliation: null,
    }),
    "chats:setDesignMode": (id, enabled) => {
      savedDesignModes.push([id as string, enabled as boolean]);
      const saved = chats.find((entry) => entry.id === id);
      return saved ? { ...saved, designMode: enabled === true } : null;
    },
    "app:widenForDesign": () => {
      widenCalls += 1;
      return widenResult;
    },
    "app:designWindowCanWiden": () => canWidenResult,
    "designCanvas:get": () => emptyDesignCanvas(),
    "designCanvas:grant": () => ({ grant: "b".repeat(52) }),
    "designCanvas:watch": () => undefined,
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

/** The design toggle as the top bar wires it: a person's click. */
function ToggleProbe({ chatId }: { chatId: string }) {
  const controls = useDesignModeControls(chatId);
  return controls ? (
    <button type="button" onClick={() => controls.toggle("toggle")}>
      Design mode
    </button>
  ) : null;
}

function DesignChat({ chatId }: { chatId: string }) {
  const design = useDesignChatState(chatId, true);
  return (
    <DesignWorkbench chatId={chatId} design={design} suppressed={false}>
      <main aria-label={`Chat ${chatId}`}>
        <ToggleProbe chatId={chatId} />
        <DesignPaneSwitch />
        <DesignModeBannerSlot />
      </main>
      <DesignChatBody>
        <button type="button">Terminal drawer</button>
      </DesignChatBody>
    </DesignWorkbench>
  );
}

function Shell({ chatId, designMode = true }: { chatId: string; designMode?: boolean }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, platform: "darwin", designMode }}>
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
  await waitFor(() => assert.equal(layoutState() === "off", !on));
}

const layoutState = () => document.querySelector("[data-design-layout]")?.getAttribute("data-design-layout");
const isHidden = (element: Element | null | undefined) =>
  Boolean(element?.closest("[inert]")) && Boolean(element?.closest('[aria-hidden="true"]'));
/** Lets the debounced resize handler run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("a design chat on a wide window splits into a 420 px chat column and the canvas", async () => {
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  assert.equal(layoutState(), "split");
  assert.equal(chatColumn()?.style.width, "420px");
  assert.equal(canvasRegion()?.dataset.designCanvasRegion, "split");
  assert.equal(canvasRegion()?.style.width, "980px");
  assert.equal(panel.toolsOpen, false, "the canvas takes the panel's place");
  assert.equal(toolsSurface()?.dataset.state ?? "closed", "closed");
  await waitFor(() => screen.getByRole("region", { name: "Design canvas" }));
  assert.equal(screen.getAllByRole("region", { name: "Design canvas" }).length, 1, "one landmark, named once");
  await waitFor(() => screen.getByText("Ask Aiden to design something, or add a note."));
  assert.equal(panel.dockRightInset, 980, "the Live pill stays inside the chat column, off the canvas controls");
  assert.equal(screen.queryByRole("radiogroup", { name: "Design mode view" }), null, "no pane switch while split");
  assert.equal(widenCalls, 0, "a wide window is left alone");
});

test("the split holds down to 680 px of content, with the canvas at least 320 px", async () => {
  containerWidth = 700;
  localStorage.setItem(DESIGN_CHAT_WIDTH_KEY, "560");
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  assert.equal(layoutState(), "split");
  assert.equal(chatColumn()?.style.width, "380px", "the chat gives way so the canvas keeps 320 px");
  assert.equal(canvasRegion()?.style.width, "320px");
  assert.equal(screen.getByRole("separator", { name: "Resize chat" }).getAttribute("aria-valuemax"), "380");
});

test("leaving design mode puts back the panel's tab, width and open state", async () => {
  await renderWithTerminalPanel("plain-chat");
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), null, "the sidebar starts open");

  await setDesignMode("plain-chat", true);
  assert.equal(panel.toolsOpen, false, "entering closes the panel");
  assert.ok(canvasRegion(), "the canvas shows");

  await setDesignMode("plain-chat", false);
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"], "Terminal is open again");
  assert.equal(localStorage.getItem(ENVIRONMENT_WIDTH_KEY), "700");
  assert.equal(canvasRegion(), null);
  assert.equal(chatColumn(), null);
});

test("entering closes Quick View as well, and leaving opens it again", async () => {
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  await act(async () => panel.showQuickView());
  assert.equal(panel.quickViewOpen, true);
  await setDesignMode("plain-chat", true);
  assert.equal(panel.quickViewOpen, false);
  await setDesignMode("plain-chat", false);
  assert.equal(panel.quickViewOpen, true);
});

test("a snapshot left from an earlier session is replaced when the panel is open at entry", async () => {
  // An old snapshot says Files at 500 px, closed; the person has Terminal open at 700.
  await renderWithTerminalPanel("plain-chat");
  // Another window's design mode left this snapshot in the shared storage.
  localStorage.setItem(
    SAVED_WORKBENCH_KEY,
    JSON.stringify({ version: 1, tab: "files", toolsOpen: false, quickViewOpen: false, width: 500 }),
  );
  await setDesignMode("plain-chat", true);
  assert.equal(panel.toolsOpen, false);
  await setDesignMode("plain-chat", false);
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"], "what the person had at entry comes back");
  assert.equal(localStorage.getItem(ENVIRONMENT_WIDTH_KEY), "700");
});

test("after a reload mid-design, leaving restores what the person had before entry", async () => {
  // Entry saved Terminal at 700, open, then closed the panel; the window reloaded.
  localStorage.setItem(
    SAVED_WORKBENCH_KEY,
    JSON.stringify({ version: 1, tab: "terminal", toolsOpen: true, quickViewOpen: false, width: 700 }),
  );
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  assert.equal(panel.toolsOpen, false, "the panel stays closed while design mode is on");
  await setDesignMode("design-chat", false);
  assert.deepEqual([panel.toolsOpen, panel.tab], [true, "terminal"]);
  assert.equal(localStorage.getItem(ENVIRONMENT_WIDTH_KEY), "700");
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

test("below 680 px the layout stacks: one pane at a time behind the Chat | Canvas switch", async () => {
  containerWidth = 600;
  const view = render(<Shell chatId="design-chat" />);
  await act(async () => undefined);
  assert.equal(layoutState(), "stacked");
  assert.equal(chatColumn()?.style.width, "", "the chat keeps the whole width");
  assert.equal(screen.queryByRole("separator", { name: "Resize chat" }), null, "nothing to drag when stacked");
  const switcher = screen.getByRole("radiogroup", { name: "Design mode view" });
  assert.equal(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked"), "true");
  assert.ok(isHidden(canvasRegion()), "the hidden canvas is inert and hidden from assistive tech");
  assert.equal(isHidden(screen.getByRole("button", { name: "Terminal drawer" })), false);
  assert.equal(panel.dockRightInset, 0, "the Live pill sits in its usual place over the chat");

  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: "Canvas" }));
  });
  assert.equal(isHidden(canvasRegion()), false, "the canvas shows");
  assert.ok(isHidden(screen.getByText("Terminal drawer", { ignore: false })), "the chat body is inert and hidden");
  assert.ok(switcher.isConnected && !isHidden(switcher), "the switch stays usable in the top bar");
  assert.equal(panel.dockRightInset, 600 - 128, "the Live pill moves to the canvas's bottom-left corner");

  // Each chat keeps its own choice for the session.
  await act(async () => {
    view.rerender(<Shell chatId="second-design-chat" />);
  });
  await waitFor(() => assert.equal(canvasRegion()?.dataset.chatId, "second-design-chat"));
  assert.equal(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked"), "true");
  await act(async () => {
    view.rerender(<Shell chatId="design-chat" />);
  });
  await waitFor(() => assert.equal(canvasRegion()?.dataset.chatId, "design-chat"));
  assert.equal(screen.getByRole("radio", { name: "Canvas" }).getAttribute("aria-checked"), "true");
});

test("the wider-window banner shows only when main says widening can work", async () => {
  containerWidth = 600;
  const view = render(<Shell chatId="design-chat" />);
  await act(async () => undefined);
  assert.equal(screen.queryByText("Design mode needs a wider window"), null, "no banner when widening can't work");
  view.unmount();

  canWidenResult = { canWiden: true };
  render(<Shell chatId="design-chat" />);
  await waitFor(() => screen.getByText("Design mode needs a wider window"));
  assert.equal(widenCalls, 0, "opening a design chat never resizes the window");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  });
  assert.equal(screen.queryByText("Design mode needs a wider window"), null);
});

test("Widen window keeps or hides the banner by what main reports", async () => {
  containerWidth = 600;
  canWidenResult = { canWiden: true };
  widenResult = { widened: false };
  const view = render(<Shell chatId="design-chat" />);
  await waitFor(() => screen.getByText("Design mode needs a wider window"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Widen window" }));
  });
  await waitFor(() => assert.equal(screen.queryByText("Design mode needs a wider window"), null));
  assert.equal(widenCalls, 1);
  view.unmount();

  widenResult = { widened: true };
  render(<Shell chatId="design-chat" />);
  await waitFor(() => screen.getByText("Design mode needs a wider window"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Widen window" }));
  });
  await waitFor(() => assert.equal(screen.queryByText("Design mode needs a wider window"), null));
  assert.equal(widenCalls, 2);
});

test("design mode that the person did not just turn on never collapses the sidebar or widens", async () => {
  containerWidth = 600;
  const view = render(<Shell chatId="design-chat" />);
  await act(async () => undefined);
  await act(async () => {
    view.rerender(<Shell chatId="second-design-chat" />);
  });
  // Another window (or main's echo) turns it on for this chat.
  await act(async () => {
    view.rerender(<Shell chatId="plain-chat" />);
  });
  await setDesignMode("plain-chat", true);
  assert.equal(layoutState(), "stacked");
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), null, "the sidebar stays open");
  assert.equal(widenCalls, 0);
});

test("the person's own entry collapses the sidebar when that is enough for the split", async () => {
  // 600 px of content plus the open 260 px sidebar fits the split.
  containerWidth = 600;
  setWindowWidth(860);
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  const toggle = await screen.findByRole("button", { name: "Design mode" });
  await act(async () => {
    fireEvent.click(toggle);
  });
  await waitFor(() => assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "1"));
  assert.equal(widenCalls, 0, "no widen when collapsing is enough");

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Design mode" }));
  });
  await waitFor(() => assert.equal(layoutState(), "off"));
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "0", "the sidebar design mode collapsed reopens");
});

test("the person's own entry leaves the sidebar open when only the closing panel makes the content look narrow", async () => {
  // A 1024 px window with a 260 px sidebar: once the panel has closed the content has 764 px,
  // enough for the split, even though the panel still squeezes it to 400 px at entry.
  containerWidth = 400;
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  await act(async () => panel.showTools("terminal"));
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Design mode" }));
  });
  await waitFor(() => assert.equal(layoutState() === "off", false));
  await act(async () => undefined);
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), null, "the sidebar stays open");
  assert.equal(widenCalls, 0, "and the window keeps its size");
});

test("the person's own entry widens the window when the sidebar is already collapsed", async () => {
  containerWidth = 600;
  setWindowWidth(600);
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, "1");
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  let taken = false;
  await act(async () => {
    taken = pressDesignShortcut();
  });
  assert.equal(taken, true);
  await waitFor(() => assert.equal(widenCalls, 1));
});

test("after a widen, the sidebar design mode collapsed reopens once it fits again", async () => {
  containerWidth = 600;
  setWindowWidth(860);
  canWidenResult = { canWiden: true };
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  const toggle = await screen.findByRole("button", { name: "Design mode" });
  await act(async () => {
    fireEvent.click(toggle);
  });
  // Collapsing was enough on paper; here the content stays 600 px, so it stacks.
  await waitFor(() => assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "1"));
  await waitFor(() => screen.getByText("Design mode needs a wider window"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Widen window" }));
  });
  await waitFor(() => assert.equal(screen.queryByText("Design mode needs a wider window"), null));
  // The window grows: 1300 px of content leaves room for the 260 px sidebar and the split.
  containerWidth = 1300;
  await act(async () => {
    window.dispatchEvent(new Event("resize"));
    await settle();
  });
  assert.equal(localStorage.getItem(SIDEBAR_COLLAPSED_KEY), "0");
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

});

test("the divider resizes from the keyboard and saves each width", async () => {
  await act(async () => {
    render(<Shell chatId="design-chat" />);
  });
  const divider = screen.getByRole("separator", { name: "Resize chat" });
  divider.focus();
  const press = async (key: string, shiftKey = false) => {
    await act(async () => {
      fireEvent.keyDown(divider, { key, shiftKey });
    });
    return [chatColumn()?.style.width, localStorage.getItem(DESIGN_CHAT_WIDTH_KEY)];
  };
  assert.deepEqual(await press("ArrowRight"), ["436px", "436"]);
  assert.deepEqual(await press("ArrowRight", true), ["476px", "476"]);
  assert.deepEqual(await press("ArrowLeft"), ["460px", "460"]);
  assert.deepEqual(await press("End"), ["560px", "560"]);
  assert.deepEqual(await press("ArrowRight"), ["560px", "560"], "never past the maximum");
  assert.deepEqual(await press("Home"), ["360px", "360"]);
  assert.deepEqual(await press("ArrowLeft", true), ["360px", "360"], "never under the minimum");
});

/** ⌘⇧L as the person presses it in the message box; true when Aiden took the key. */
function pressDesignShortcut(): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "L",
    code: "KeyL",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
}

test("⌘⇧L turns design mode on and off for the open chat and saves each change", async () => {
  await act(async () => {
    render(<Shell chatId="plain-chat" />);
  });
  assert.equal(layoutState(), "off");
  let taken = false;
  await act(async () => {
    taken = pressDesignShortcut();
  });
  assert.equal(taken, true);
  await waitFor(() => assert.equal(layoutState(), "split"));
  await act(async () => {
    pressDesignShortcut();
  });
  await waitFor(() => assert.equal(layoutState(), "off"));
  await waitFor(() =>
    assert.deepEqual(savedDesignModes, [
      ["plain-chat", true],
      ["plain-chat", false],
    ]),
  );
});

test("⌘⇧L is left alone while the flag is off or the chat is a Bot's", async () => {
  for (const [chatId, designMode] of [
    ["plain-chat", false],
    ["bot-chat", true],
  ] as const) {
    const view = render(<Shell chatId={chatId} designMode={designMode} />);
    await act(async () => undefined);
    let taken = true;
    await act(async () => {
      taken = pressDesignShortcut();
    });
    assert.equal(taken, false, `${chatId}, designMode: ${designMode}`);
    assert.equal(layoutState(), "off");
    view.unmount();
  }
  assert.deepEqual(savedDesignModes, []);
});
