// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { CommandSystemProvider } from "../lib/command-system";
import { useDelayedFlag } from "../lib/use-delayed-flag";
import type { ExternalEditor } from "../lib/types";
import { effectiveBindings } from "../shared/keybindings";
import { WorkspaceToolButtons, type FoldableToolbarAction } from "./chat-top-bar";
import { EnvironmentPanelContext, GIT_BUSY_DIM_DELAY_MS, type EnvironmentPanelContextValue } from "./environment-panel";
import { OpenInEditorPicker } from "./open-in-editor-picker";

const CURSOR: ExternalEditor = { id: "cursor", label: "Cursor" } as ExternalEditor;

let queryClient: QueryClient;
/** Editor discoveries wait here until the test lets them finish. */
let heldDiscoveries: Array<() => void> = [];

// Stands in for the stylesheet: a leaving control runs these animations.
let exitAnimations: Array<{ finished: Promise<unknown>; effect: unknown; finish: () => void }> = [];
const originalGetAnimations = Element.prototype.getAnimations;

function exitAnimation() {
  let resolve!: () => void;
  const animation = {
    finished: new Promise<void>((done) => (resolve = done)),
    effect: { getComputedTiming: () => ({ endTime: 200, localTime: 0 }) },
    finish: () => resolve(),
  };
  return animation;
}

beforeEach(() => {
  heldDiscoveries = [];
  exitAnimations = [];
  installBotTestIpc({
    "shortcut:get": () => ({ overrides: { version: 1, commands: {} }, effective: effectiveBindings(undefined), global: [] }),
    "workspaces:externalEditors": async () => {
      await new Promise<void>((release) => heldDiscoveries.push(release));
      return [CURSOR];
    },
  });
  queryClient = createBotTestQueryClient();
  Element.prototype.getAnimations = function (this: Element) {
    return (this.getAttribute("data-presence") === "exiting" ? exitAnimations : []) as unknown as Animation[];
  };
  document.documentElement.dataset.reduceMotion = "false";
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  if (originalGetAnimations) Element.prototype.getAnimations = originalGetAnimations;
  else delete (Element.prototype as Partial<Element>).getAnimations;
  delete document.documentElement.dataset.reduceMotion;
});

interface HeaderState {
  chatId?: string;
  hasFolderAccess?: boolean;
  gitOperationBusy?: boolean;
  gitOperationDimmed?: boolean;
  /** Pixels of header content; under 680 the tools fold into the ⋯ menu. */
  width?: number;
  openInEditor?: boolean;
}

/** Only the panel fields the header reads. */
function stubPanel(state: HeaderState): EnvironmentPanelContextValue {
  return {
    devicesEnabled: true,
    subagentsEnabled: false,
    subagents: { chatId: state.chatId ?? "chat-1" },
    subagentViews: [],
    artifacts: { views: [] },
    toolsPresented: false,
    tab: "browser",
    gitOperationBusy: state.gitOperationBusy ?? false,
    gitOperationDimmed: state.gitOperationDimmed ?? false,
    showTools: () => {},
    closeTools: () => {},
  } as unknown as EnvironmentPanelContextValue;
}

/** The chat header as the chat pane builds it: Terminal rides along like Quick View does. */
function Header(state: HeaderState) {
  const access = state.hasFolderAccess ?? true;
  const terminal: FoldableToolbarAction = {
    key: "terminal",
    label: "Show terminal",
    icon: () => null,
    onSelect: () => {},
    available: access,
    button: (
      <button type="button" data-terminal-toggle>
        Show terminal
      </button>
    ),
  };
  return (
    <EnvironmentPanelContext.Provider value={stubPanel(state)}>
      <div data-toolbar>
        <WorkspaceToolButtons
          chatId={state.chatId ?? "chat-1"}
          hasWorkspace
          hasFolder
          hasFolderAccess={access}
          isRepo={false}
          foldable={[terminal]}
          trailing={state.openInEditor ? <OpenInEditorPicker workspaceId="site" folderPath="/Users/person/site" /> : undefined}
          end={
            <button type="button" data-environment-toggle>
              Show Environment
            </button>
          }
        />
      </div>
    </EnvironmentPanelContext.Provider>
  );
}

function withProviders(node: React.ReactNode) {
  return (
    <QueryClientProvider client={queryClient}>
      <CommandSystemProvider>{node}</CommandSystemProvider>
    </QueryClientProvider>
  );
}

/** Renders the header with `clientWidth` faked for the toolbar, as the density hook measures it. */
function renderHeader(state: HeaderState) {
  const width = state.width ?? 1000;
  const realWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-toolbar") ? width : 0;
    },
  });
  const result = render(withProviders(<Header {...state} />));
  return {
    rerender: (next: HeaderState) => result.rerender(withProviders(<Header {...next} />)),
    restore: () => {
      if (realWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", realWidth);
      else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    },
  };
}

const terminalButton = () => screen.queryByRole("button", { name: "Show terminal" });
const filesButton = () => screen.queryByRole("button", { name: "Show Files" });

test("Open stays out of the header, divider included, until the editor list arrives, then slides in", async () => {
  const header = renderHeader({ openInEditor: true });
  try {
    assert.equal(screen.queryByRole("group", { name: "Open workspace in editor" }), null, "no greyed Open while loading");
    const bar = document.querySelector("[data-workspace-tool-buttons]")!;
    assert.equal(bar.querySelectorAll(".bg-separator").length, 0, "no divider is left waiting for it");

    await act(async () => heldDiscoveries.shift()?.());
    const open = await screen.findByRole("group", { name: "Open workspace in editor" });
    assert.equal(open.closest(".toolbar-presence")?.getAttribute("data-enter"), "animate", "it arrives with the slide-in");
    assert.ok(screen.getByRole("button", { name: "Open workspace in Cursor" }));
  } finally {
    header.restore();
  }
  cleanup();

  // Back in a fresh header (from Settings, say), the remembered list shows Open at once.
  const again = renderHeader({ openInEditor: true });
  try {
    const open = screen.getByRole("group", { name: "Open workspace in editor" });
    assert.equal(open.closest(".toolbar-presence")?.hasAttribute("data-enter"), false, "no slide on a fresh header");
  } finally {
    again.restore();
  }
});

test("with workspace access off, Terminal and Files are left out of the header and the ⋯ menu", async () => {
  const header = renderHeader({ hasFolderAccess: false });
  try {
    assert.equal(terminalButton(), null);
    assert.equal(filesButton(), null);
    assert.ok(screen.getByRole("button", { name: "Show Browser" }), "tools that still work stay");
    assert.ok(screen.getByRole("button", { name: "Show Device" }));
  } finally {
    header.restore();
  }
  cleanup();

  const narrow = renderHeader({ hasFolderAccess: false, width: 600 });
  try {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "More workspace tools" }), { key: "Enter" });
    });
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    assert.ok(items.includes("Browser"));
    assert.ok(!items.includes("Files"), "no greyed Files row either");
  } finally {
    narrow.restore();
  }
});

test("turning access on slides Terminal and Files in; a first render or another chat does not animate", async () => {
  const header = renderHeader({ hasFolderAccess: true });
  try {
    for (const button of [terminalButton(), filesButton()]) {
      assert.equal(button?.closest(".toolbar-presence")?.hasAttribute("data-enter"), false, "the first render is still");
    }
    header.rerender({ hasFolderAccess: false });
    await act(async () => exitAnimations.splice(0).forEach((animation) => animation.finish()));
    assert.equal(terminalButton(), null);

    header.rerender({ hasFolderAccess: true });
    for (const button of [terminalButton(), filesButton()]) {
      assert.equal(button?.closest(".toolbar-presence")?.getAttribute("data-enter"), "animate", "access on mid-chat slides in");
    }

    // Switching to a chat whose folder has access off, then to one with access on: no motion either way.
    header.rerender({ chatId: "chat-2", hasFolderAccess: false });
    assert.equal(terminalButton(), null, "gone at once on a chat switch");
    header.rerender({ chatId: "chat-3", hasFolderAccess: true });
    assert.equal(terminalButton()?.closest(".toolbar-presence")?.hasAttribute("data-enter"), false);
  } finally {
    header.restore();
  }
});

test("a button leaving mid-chat can't be used on its way out and hands focus to its neighbour", async () => {
  exitAnimations = [exitAnimation()];
  const header = renderHeader({ hasFolderAccess: true });
  try {
    const files = filesButton()!;
    files.focus();
    header.rerender({ hasFolderAccess: false });

    const leaving = document.querySelector('[data-workspace-tool="files"]')!.closest(".toolbar-presence")!;
    assert.equal(leaving.getAttribute("data-presence"), "exiting", "it stays for its slide-out");
    assert.equal(leaving.hasAttribute("inert"), true, "it can't be clicked or focused while it goes");
    assert.equal(
      document.activeElement,
      screen.getByRole("button", { name: "More workspace tools" }),
      "focus moves to the next control, not the page",
    );

    await act(async () => exitAnimations[0]?.finish());
    assert.equal(document.querySelector('[data-workspace-tool="files"]'), null, "then it is gone");
  } finally {
    header.restore();
  }
});

test("a running Git operation dims the buttons only once it is past the delay", () => {
  const header = renderHeader({ gitOperationBusy: true, gitOperationDimmed: false });
  try {
    assert.equal((screen.getByRole("button", { name: "Show Browser" }) as HTMLButtonElement).disabled, false);
    header.rerender({ gitOperationBusy: true, gitOperationDimmed: true });
    assert.equal((screen.getByRole("button", { name: "Show Browser" }) as HTMLButtonElement).disabled, true);
    assert.equal((screen.getByRole("button", { name: "More workspace tools" }) as HTMLButtonElement).disabled, true);
  } finally {
    header.restore();
  }
});

test("a Git operation shorter than the dim delay never dims; a longer one does until it ends", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { result, rerender } = renderHook(({ busy }) => useDelayedFlag(busy, GIT_BUSY_DIM_DELAY_MS), {
      initialProps: { busy: true },
    });
    act(() => mock.timers.tick(GIT_BUSY_DIM_DELAY_MS - 100));
    assert.equal(result.current, false, "a quick commit");
    rerender({ busy: false });
    act(() => mock.timers.tick(1000));
    assert.equal(result.current, false, "and it never flashes afterwards");

    rerender({ busy: true });
    act(() => mock.timers.tick(GIT_BUSY_DIM_DELAY_MS));
    assert.equal(result.current, true, "a slow push dims");
    rerender({ busy: false });
    assert.equal(result.current, false, "and undims the moment it ends");
  } finally {
    mock.timers.reset();
  }
});
