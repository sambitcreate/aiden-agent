// Installs happy-dom for the Testing Library cases; must stay the first import.
import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatRow, type ChatRowInbox, type ChatRowMenu, type ChatRowProps } from "./chat-row.js";
import { TooltipProvider } from "../ui.js";
import { RowGroup } from "./row-group.js";
import { SectionHeader } from "./section-header.js";
import { remoteChatRowMenu } from "./remote-chat-row-menu.js";
import { inboxTriageMenuItems } from "./inbox-triage-menu.js";
import { remoteChatRowActions, type RemoteSidebarChat } from "../../lib/sidebar-remote-groups.js";
import type { HostChatCapability } from "../../lib/hosts/host-chat-adapter.js";

afterEach(cleanup);

function labels(markup: string): string[] {
  return [...markup.matchAll(/aria-label="([^"]+)"/gu)].map((match) => match[1]!);
}

/** The `aria-busy` value on the row's own button. */
function rowBusy(markup: string): string | undefined {
  return /<button[^>]*data-roving-item[^>]*aria-busy="([^"]+)"/u.exec(markup)?.[1]
    ?? /<button[^>]*aria-busy="([^"]+)"[^>]*data-roving-item/u.exec(markup)?.[1];
}

function row(props: Partial<ChatRowProps> = {}): string {
  return renderToStaticMarkup(
    <ChatRow
      title="Fix the build"
      status={{ state: "idle", unread: false }}
      onOpen={() => {}}
      {...props}
    />,
  );
}

const menu: ChatRowMenu = (Item) => <Item>Open</Item>;

test("each row state shows its one status pill next to the title", () => {
  const expected = {
    needs_approval: ["Needs approval"],
    needs_input: ["Needs input"],
    working: ["Working"],
    idle: [],
  } as const;
  for (const [state, pills] of Object.entries(expected)) {
    const markup = row({ status: { state: state as keyof typeof expected, unread: false } });
    assert.deepEqual(labels(markup), pills, state);
    assert.match(markup, />Fix the build</u, state);
  }
  assert.deepEqual(labels(row({ status: { state: "idle", unread: true, failed: true } })), ["Failed"]);
});

test("the open chat never shows unread, other rows do", () => {
  const unread = { state: "idle", unread: true } as const;
  assert.deepEqual(labels(row({ status: unread })), ["Unread"]);
  const open = row({ status: unread, selected: true });
  assert.deepEqual(labels(open), []);
  assert.doesNotMatch(open, /data-chat-unread/u);
});

test("aria-busy is true only while Working or while the caller reports extra work", () => {
  assert.equal(rowBusy(row({ status: { state: "working", unread: false } })), "true");
  for (const state of ["needs_approval", "needs_input", "idle"] as const) {
    assert.equal(rowBusy(row({ status: { state, unread: true } })), "false", state);
  }
  assert.equal(rowBusy(row({ busy: true })), "true");
});

test("a remote row carries its host marker and a ••• menu named for the chat", () => {
  const live = row({ remote: { hostLabel: "Studio Mac", stale: false }, menu });
  assert.deepEqual(labels(live), ["On Studio Mac", "More for Fix the build"]);
  assert.match(live, /data-remote-chat="live"/u);
  assert.match(live, /data-remote-host-marker="true"/u);
  assert.match(live, /<button[^>]*aria-label="More for Fix the build"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="More for Fix the build"/u);

  const stale = row({ remote: { hostLabel: "Studio Mac", stale: true } });
  assert.deepEqual(labels(stale), ["On Studio Mac, offline"]);
  assert.match(stale, /data-remote-chat="stale"/u);
  assert.doesNotMatch(stale, /aria-haspopup/u, "a row without actions has no ••• button");
});

test("holding the shortcut modifier swaps the ••• button for the shortcut hint", () => {
  const hidden = row({ menu, shortcutHint: "⌘1" });
  assert.doesNotMatch(hidden, /data-chat-shortcut-hint/u);
  assert.match(hidden, /aria-haspopup="menu"/u);

  const revealed = row({ menu, shortcutHint: "⌘1", shortcutsRevealed: true });
  assert.match(revealed, /<kbd[^>]*data-chat-shortcut-hint="true"[^>]*>⌘1<\/kbd>/u);
  assert.doesNotMatch(revealed, /aria-haspopup="menu"/u);
});

function remoteChat(overrides: Partial<RemoteSidebarChat> = {}): RemoteSidebarChat {
  return {
    key: "remote:host-1:chat-1",
    projectKey: "remote:host-1:ws-1",
    title: "Fix the build",
    remote: true,
    hostId: "host-1",
    hostLabel: "Studio Mac",
    chatId: "chat-1",
    workspaceId: "ws-1",
    rowState: "idle",
    unread: true,
    lastRunFailed: false,
    stale: false,
    revision: "rev-7",
    ...overrides,
  };
}

const ids = (chat: RemoteSidebarChat, granted: HostChatCapability[]) =>
  remoteChatRowActions(chat, new Set(granted)).map((action) => action.id);

test("remote rows offer only the actions the host grants", () => {
  assert.deepEqual(ids(remoteChat(), []), ["open"]);
  assert.deepEqual(ids(remoteChat(), ["markRead"]), ["open", "markRead"]);
  assert.deepEqual(ids(remoteChat(), ["rename"]), ["open", "rename"]);
  // Granted control the sidebar has no menu item for (delete, send) never adds one.
  assert.deepEqual(ids(remoteChat(), ["markRead", "rename", "remove", "send"]), [
    "open",
    "markRead",
    "rename",
  ]);
});

test("remote mark read needs an unread row and rename needs the host's revision", () => {
  assert.deepEqual(ids(remoteChat({ unread: false }), ["markRead", "rename"]), ["open", "rename"]);
  assert.deepEqual(ids(remoteChat({ revision: undefined }), ["markRead", "rename"]), ["open", "markRead"]);
});

test("an offline host's rows keep Open but disable the actions that need the host", () => {
  const actions = remoteChatRowActions(remoteChat({ stale: true }), new Set(["markRead", "rename"]));
  assert.deepEqual(actions, [
    { id: "open", disabled: false },
    { id: "markRead", disabled: true },
    { id: "rename", disabled: true },
  ]);
});

test("a remote row's menu lists the granted actions, keeps disabled ones unselectable, and runs the chosen one", async () => {
  const chosen: string[] = [];
  const actions = remoteChatRowActions(remoteChat({ stale: true }), new Set(["markRead", "rename"]));
  render(
    <ChatRow
      title="Fix the build"
      status={{ state: "idle", unread: true }}
      remote={{ hostLabel: "Studio Mac", stale: true }}
      menu={remoteChatRowMenu(actions, {
        onOpen: () => void chosen.push("open"),
        onMarkRead: () => void chosen.push("markRead"),
        onRename: () => void chosen.push("rename"),
      })}
      onOpen={() => {}}
    />,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/u }));
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  assert.deepEqual(
    items.map((item) => [item.textContent, item.getAttribute("aria-disabled") === "true"]),
    [
      ["Open", false],
      ["Mark read", true],
      ["Rename", true],
    ],
  );
  fireEvent.click(items[2]!);
  fireEvent.click(items[0]!);
  assert.deepEqual(chosen, ["open"], "a disabled item never runs its action");
});

test("a remote row's live menu runs Mark read and Rename", async () => {
  for (const [label, expected] of [
    ["Mark read", "markRead"],
    ["Rename", "rename"],
  ] as const) {
    const chosen: string[] = [];
    const actions = remoteChatRowActions(remoteChat(), new Set(["markRead", "rename"]));
    render(
      <ChatRow
        title="Fix the build"
        status={{ state: "idle", unread: true }}
        menu={remoteChatRowMenu(actions, {
          onOpen: () => void chosen.push("open"),
          onMarkRead: () => void chosen.push("markRead"),
          onRename: () => void chosen.push("rename"),
        })}
        onOpen={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Fix the build/u }));
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: label }));
    assert.deepEqual(chosen, [expected], label);
    cleanup();
  }
});

test("clicking a row group's header asks to toggle it", () => {
  let toggles = 0;
  render(
    <RowGroup expanded={false} icon={null} title="aiden-agent" accessibleName="aiden-agent workspace" onToggle={() => void toggles++}>
      <span>child</span>
    </RowGroup>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand aiden-agent workspace" }));
  assert.equal(toggles, 1);
});

test("a row group shows its rows only while expanded and names the toggle for the next step", () => {
  const render = (expanded: boolean) =>
    renderToStaticMarkup(
      <RowGroup expanded={expanded} icon={null} title="aiden-agent" accessibleName="aiden-agent workspace" onToggle={() => {}}>
        <span data-child="row">child</span>
      </RowGroup>,
    );
  const open = render(true);
  assert.match(open, /aria-label="Collapse aiden-agent workspace"/u);
  assert.match(open, /aria-expanded="true"/u);
  assert.match(open, /data-child="row"/u);

  const closed = render(false);
  assert.match(closed, /aria-label="Expand aiden-agent workspace"/u);
  assert.match(closed, /aria-expanded="false"/u);
  assert.doesNotMatch(closed, /data-child="row"/u);
});

test("a section header shows its count and only becomes a button when collapsible", () => {
  const plain = render(<SectionHeader label="Today" count={3} />);
  assert.equal(plain.container.textContent, "Today3");
  assert.ok(screen.getByText("3"));
  assert.equal(screen.queryByRole("button"), null);
  plain.unmount();
  assert.equal(render(<SectionHeader label="Today" />).container.textContent, "Today");

  const collapsible = renderToStaticMarkup(
    <SectionHeader label="Done" collapse={{ expanded: false, onToggle: () => {} }} />,
  );
  assert.match(collapsible, /<button[^>]*aria-expanded="false"[^>]*>.*Done.*<\/button>/u);
});

function inboxRow(inbox: Partial<ChatRowInbox> = {}, props: Partial<ChatRowProps> = {}) {
  return render(
    <TooltipProvider>
      <ChatRow
        title="Fix the build"
        layout="inbox"
        status={{ state: "idle", unread: Boolean(inbox.unread) }}
        inbox={{ meta: "aiden", status: { label: "2h", tone: "quiet" }, ...inbox }}
        onOpen={() => {}}
        {...props}
      />
    </TooltipProvider>,
  );
}

/** The row's own button (the ••• and action buttons also name the chat). */
function inboxRowButton(): HTMLElement {
  const [button] = screen
    .getAllByRole("button", { name: /Fix the build/u })
    .filter((candidate) => candidate.hasAttribute("data-roving-item"));
  assert.ok(button);
  return button;
}

test("an Inbox row's name leads with its title and says Unread once, at the end", () => {
  inboxRow({ unread: true });
  assert.equal(screen.getByRole("button", { name: "Fix the build, aiden, 2h, Unread" }), inboxRowButton());
  cleanup();

  inboxRow({ unread: false });
  assert.equal(screen.getByRole("button", { name: "Fix the build, aiden, 2h" }), inboxRowButton());
  assert.equal(screen.queryByRole("button", { name: /Unread/u }), null);
  cleanup();

  // A Needs you row names its reason and how long it has waited, after the title.
  inboxRow({ meta: "aiden · Studio", status: { label: "Approval", tone: "warning", wait: "4m", needsYou: "approval" } });
  assert.equal(screen.getByRole("button", { name: "Fix the build, aiden · Studio, Approval, 4m" }), inboxRowButton());
});

test("an Inbox row's action runs without opening the chat, and a dimmed row offers none", () => {
  let opened = 0;
  let marked = 0;
  inboxRow(
    { unread: true, action: { kind: "mark_read", onSelect: () => (marked += 1) } },
    { onOpen: () => (opened += 1) },
  );
  fireEvent.click(screen.getByRole("button", { name: "Mark read: Fix the build" }));
  assert.equal(marked, 1);
  assert.equal(opened, 0);
  cleanup();

  inboxRow({ unread: true, dimmed: true, action: { kind: "mark_read", onSelect: () => (marked += 1) } });
  assert.equal(screen.queryByRole("button", { name: /^Mark read/u }), null);
});

test("an Inbox row describes its request and keeps its leading icon", () => {
  inboxRow(
    { description: "Approve: rm -rf build", status: { label: "Approval", tone: "warning", needsYou: "approval" } },
    { icon: <span data-testid="lead-icon" /> },
  );
  assert.equal(inboxRowButton().getAttribute("aria-description"), "Approve: rm -rf build");
  assert.ok(within(inboxRowButton()).getByTestId("lead-icon"));
});

test("an Inbox remote row's menu offers the same one action as its hover icon", async () => {
  const actions = remoteChatRowActions(remoteChat(), new Set(["markRead", "rename"]));
  for (const kind of ["acknowledge", "mark_read"] as const) {
    let fromMenu = 0;
    const action = { kind, onSelect: () => (fromMenu += 1) };
    const handlers = { onOpen: () => {}, onMarkRead: () => {}, onRename: () => {}, inboxAction: action };
    inboxRow({ unread: true, action }, { menu: remoteChatRowMenu(actions, handlers) });
    const hover = screen.getByRole("button", { name: /^(Acknowledge|Mark read): Fix the build$/u });
    const hoverLabel = hover.getAttribute("title");
    assert.ok(hoverLabel);

    fireEvent.contextMenu(inboxRowButton());
    const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
    // Open first, then the row's one action, named as the hover icon names it; no separate Mark read.
    assert.deepEqual(items.map((item) => item.textContent), ["Open", hoverLabel, "Rename"]);
    fireEvent.click(items[1]!);
    assert.equal(fromMenu, 1);
    cleanup();
  }

  // Without an Inbox action, the menu has none either.
  inboxRow({}, {
    menu: remoteChatRowMenu(actions, { onOpen: () => {}, onMarkRead: () => {}, onRename: () => {}, inboxAction: null }),
  });
  assert.equal(document.querySelector("[data-inbox-action]"), null);
  fireEvent.contextMenu(inboxRowButton());
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Open", "Rename"]);
});

test("an Inbox row's triage lives in its menus only, and Snooze sends an absolute time", async () => {
  // Saturday 31 October 2026, 15:00 on this device's clock.
  const now = new Date(2026, 9, 31, 15, 0);
  const acts: [string, number | undefined][] = [];
  const triageMenu = (pinned: boolean, disabled = false): ChatRowMenu => (...parts) =>
    inboxTriageMenuItems(parts, { pinned, disabled, now: () => now, onAct: (kind, until) => void acts.push([kind, until]) });
  inboxRow({ unread: true }, { menu: triageMenu(false) });
  // No inline triage button on the row itself.
  assert.equal(screen.queryByRole("button", { name: /\b(Pin|Mark done|Snooze)\b/u }), null);

  fireEvent.contextMenu(inboxRowButton());
  const menu = await screen.findByRole("menu");
  assert.deepEqual(within(menu).getAllByRole("menuitem").map((item) => item.textContent), ["Pin", "Mark done", "Snooze"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Snooze" }));
  const presets = [...document.querySelectorAll<HTMLElement>("[data-snooze-preset]")];
  assert.deepEqual(presets.map((item) => item.dataset.snoozePreset), ["hour", "evening", "tomorrow", "next_week"]);
  fireEvent.click(presets[2]!);
  assert.deepEqual(acts, [["snooze", new Date(2026, 10, 1, 9, 0).getTime()]]);
  cleanup();

  // A pinned row offers Unpin; a host that can't take writes disables every item.
  inboxRow({}, { menu: triageMenu(true, true) });
  fireEvent.contextMenu(inboxRowButton());
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  assert.deepEqual(
    items.map((item) => [item.textContent, item.getAttribute("aria-disabled") === "true"]),
    [["Unpin", true], ["Mark done", true], ["Snooze", true]],
  );
  fireEvent.click(items[0]!);
  assert.equal(acts.length, 1, "a disabled item never acts");
});

test("a Done or snoozed row's menu takes it back, and a row that waits on the person offers Pin alone", async () => {
  const acts: [string, number | undefined][] = [];
  const menuFor = (offer: { doneAndSnooze: boolean; done: boolean; snoozed: boolean }): ChatRowMenu => (...parts) =>
    inboxTriageMenuItems(parts, { pinned: false, offer, disabled: false, onAct: (kind, until) => void acts.push([kind, until]) });
  const items = async (offer: { doneAndSnooze: boolean; done: boolean; snoozed: boolean }) => {
    inboxRow({}, { menu: menuFor(offer) });
    fireEvent.contextMenu(inboxRowButton());
    return within(await screen.findByRole("menu")).getAllByRole("menuitem");
  };

  const done = await items({ doneAndSnooze: true, done: true, snoozed: false });
  assert.deepEqual(done.map((item) => item.textContent), ["Pin", "Mark not done", "Snooze"]);
  fireEvent.click(done[1]!);
  cleanup();

  const snoozed = await items({ doneAndSnooze: true, done: false, snoozed: true });
  assert.deepEqual(snoozed.map((item) => item.textContent), ["Pin", "Mark done", "Unsnooze"]);
  fireEvent.click(snoozed[2]!);
  cleanup();
  assert.deepEqual(acts, [["undone", undefined], ["unsnooze", undefined]]);

  const waiting = await items({ doneAndSnooze: false, done: false, snoozed: false });
  assert.deepEqual(waiting.map((item) => item.textContent), ["Pin"]);
  cleanup();

  // A waiting row with a snooze still to run can end it.
  const waitingSnoozed = await items({ doneAndSnooze: false, done: false, snoozed: true });
  assert.deepEqual(waitingSnoozed.map((item) => item.textContent), ["Pin", "Unsnooze"]);
  fireEvent.click(waitingSnoozed[1]!);
  assert.deepEqual(acts, [["undone", undefined], ["unsnooze", undefined], ["unsnooze", undefined]]);
});

test("an Inbox remote row's triage follows its one action, as on a local row", async () => {
  const actions = remoteChatRowActions(remoteChat(), new Set(["markRead", "rename"]));
  const action = { kind: "mark_read" as const, onSelect: () => {} };
  inboxRow({ unread: true, action }, {
    menu: remoteChatRowMenu(actions, {
      onOpen: () => {},
      onMarkRead: () => {},
      onRename: () => {},
      inboxAction: action,
      triage: (...parts) => inboxTriageMenuItems(parts, { pinned: false, disabled: false, onAct: () => {} }),
    }),
  });
  const hoverLabel = screen.getByRole("button", { name: /^Mark read: Fix the build$/u }).getAttribute("title");
  fireEvent.contextMenu(inboxRowButton());
  const items = within(await screen.findByRole("menu")).getAllByRole("menuitem");
  assert.deepEqual(items.map((item) => item.textContent), ["Open", hoverLabel, "Pin", "Mark done", "Snooze", "Rename"]);
});
