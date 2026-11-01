// Installs happy-dom for the Testing Library cases; must stay the first import.
import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createPortal } from "react-dom";
import { TooltipProvider } from "../ui";
import { ChatRow } from "./chat-row";
import { InboxView, type InboxRowContext } from "./inbox-view";
import { botInboxRows, inboxRowAction, inboxShortcutTargets, type InboxEntry } from "../../lib/sidebar-inbox-view";
import { botFixture } from "../../main/bots/test-fixtures";
import type { InboxSignals } from "../../lib/sidebar-inbox";
import { projectOrderKey } from "../../lib/sidebar-organization";
import { writeSidebarPreferences } from "../../lib/use-sidebar-view";
import type { ChatPendingAttention } from "../../shared/chat-pending-attention";
import type { ChatMeta } from "../../lib/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 31, 12);
let nowMs = NOW;
const clock = () => nowMs;

afterEach(() => {
  cleanup();
  nowMs = NOW;
  writeSidebarPreferences({ workingShelfCollapsed: false });
});

function entry(id: string, signals: Partial<InboxSignals> = {}, pending?: ChatPendingAttention): InboxEntry {
  const chat: ChatMeta = { id, title: `Chat ${id}`, workspaceId: "ws-1", createdAt: NOW - 2 * HOUR, updatedAt: NOW - HOUR };
  return {
    key: projectOrderKey("local", id),
    title: `Chat ${id}`,
    project: "aiden",
    hostId: "local",
    hostLabel: "This Mac",
    source: { kind: "local", chat },
    signals: {
      rowState: "idle",
      unread: false,
      failed: false,
      isOpen: false,
      hostOnline: true,
      updatedAt: NOW - HOUR,
      ...signals,
    },
    ...(pending ? { pending } : {}),
  };
}

/** The real Inbox row, built the way the sidebar builds it. */
function renderRow(onMarkRead: (key: string) => void = () => {}) {
  return (item: InboxEntry, context: InboxRowContext) => {
    const action = inboxRowAction(item, context.section, context.status, false);
    return (
      <ChatRow
        title={item.title}
        layout="inbox"
        status={{ state: item.signals.rowState, unread: item.signals.unread }}
        inbox={{
          meta: item.project,
          status: context.status,
          ...(context.description ? { description: context.description } : {}),
          unread: item.signals.unread,
          dimmed: context.dimmed,
          ...(action ? { action: { kind: action, onSelect: () => onMarkRead(item.key) } } : {}),
        }}
        onOpen={() => {}}
      />
    );
  };
}

function view(
  entries: readonly InboxEntry[],
  extra: {
    unlisted?: readonly InboxEntry[];
    onMarkRead?: (key: string) => void;
    searching?: boolean;
    shelfHost?: HTMLElement | null;
    renderRow?: (entry: InboxEntry, context: InboxRowContext) => React.ReactNode;
    onShortcutOrderChange?: (keys: readonly string[]) => void;
  } = {},
) {
  return (
    <TooltipProvider>
      <InboxView
        entries={entries}
        {...(extra.unlisted ? { unlisted: new Map(extra.unlisted.map((item) => [item.key, item] as const)) } : {})}
        now={clock}
        searching={extra.searching ?? false}
        shelfHost={extra.shelfHost ?? null}
        renderRow={extra.renderRow ?? renderRow(extra.onMarkRead)}
        {...(extra.onShortcutOrderChange ? { onShortcutOrderChange: extra.onShortcutOrderChange } : {})}
      />
    </TooltipProvider>
  );
}

function inboxRoot(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-inbox-view]")!;
}

function rowButton(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`\\b${name}(?!\\w)`, "u") });
}

function section(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function rowTitles(container: HTMLElement): string[] {
  return within(container)
    .queryAllByRole("button")
    .filter((button) => button.hasAttribute("data-roving-item") && button.dataset.inboxShowMore === undefined)
    .map((button) => button.querySelector("[data-inbox-title]")?.textContent ?? "");
}

test("rows sort into Needs you, Updates, Earlier and the Working shelf, each a labelled group", () => {
  render(view([
    entry("approval", { rowState: "needs_approval", attentionSince: NOW - 3 * MINUTE }),
    entry("news", { unread: true, lastAssistantAt: NOW - 10 * MINUTE }),
    entry("quiet"),
    entry("busy", { rowState: "working", runStartedAt: NOW - 4 * MINUTE }),
  ]));
  assert.deepEqual(rowTitles(section("Needs you")), ["Chat approval"]);
  assert.deepEqual(rowTitles(section("Updates")), ["Chat news"]);
  assert.deepEqual(rowTitles(section("Earlier")), ["Chat quiet"]);
  assert.deepEqual(rowTitles(section("Working")), ["Chat busy"]);
  assert.ok(within(section("Working")).getByText("Working 4m"));
  assert.equal(screen.queryByText("Nothing needs you"), null);
});

test("Needs you rows name their reason and wait, and carry the request only as a description", () => {
  render(view([
    entry(
      "approval",
      { rowState: "needs_approval", attentionSince: NOW - 3 * MINUTE },
      { chatId: "approval", kind: "approval", summary: "rm -rf build", since: NOW - 3 * MINUTE, count: 1 },
    ),
    entry("question", { rowState: "needs_input", attentionSince: NOW - 5 * MINUTE }),
    entry("failed", { failed: true, unread: true, lastAssistantAt: NOW - 20 * MINUTE }),
    entry("detached", { attention: "detached", attentionSince: NOW - 2 * MINUTE }),
    entry("interrupted", { attention: "interrupted", attentionSince: NOW - 8 * MINUTE }),
  ]));
  const needsYou = section("Needs you");
  const statuses = [...needsYou.querySelectorAll<HTMLElement>("[data-inbox-status]")].map((node) => node.textContent);
  // Approval, then Question, then Failed, then the prompts that can't be answered
  // here, longest wait first.
  assert.deepEqual(statuses, ["Approval3m", "Question5m", "Failed20m", "Interrupted8m", "Unavailable2m"]);

  const approval = within(needsYou).getByRole("button", { name: /Chat approval/u });
  assert.equal(approval.getAttribute("aria-description"), "Approve: rm -rf build");
  // The request isn't drawn in the row itself.
  assert.equal(within(needsYou).queryByText(/rm -rf build/u), null);
});

test("only Failed rows in Needs you get a hover icon, and it acknowledges", () => {
  render(view([
    entry("approval", { rowState: "needs_approval", attentionSince: NOW - MINUTE }),
    entry("question", { rowState: "needs_input", attentionSince: NOW - MINUTE }),
    entry("failed", { failed: true, unread: true, lastAssistantAt: NOW - MINUTE }),
  ]));
  const needsYou = section("Needs you");
  const actions = [...needsYou.querySelectorAll<HTMLElement>("[data-inbox-action]")].map((node) => node.getAttribute("aria-label"));
  assert.deepEqual(actions, ["Acknowledge: Chat failed"]);
});

test("Mark read shows on unread Updates rows only and reaches the caller", () => {
  const marked: string[] = [];
  render(view([
    entry("news", { unread: true, lastAssistantAt: NOW - 10 * MINUTE }),
    entry("quiet"),
    entry("busy", { rowState: "working", unread: true }),
  ], { onMarkRead: (key) => marked.push(key) }));
  assert.equal(within(section("Earlier")).queryByRole("button", { name: /^Mark read/u }), null);
  assert.equal(within(section("Working")).queryByRole("button", { name: /^Mark read/u }), null);
  fireEvent.click(within(section("Updates")).getByRole("button", { name: "Mark read: Chat news" }));
  assert.deepEqual(marked, [projectOrderKey("local", "news")]);
});

test("an Inbox with nothing waiting says so, even while a run is working", () => {
  render(view([entry("busy", { rowState: "working" }), entry("old", { updatedAt: NOW - 30 * 24 * HOUR })]));
  const empty = screen.getByRole("status");
  assert.match(empty.textContent ?? "", /Nothing needs you/u);
  assert.equal(screen.queryByRole("group", { name: "Earlier" }), null);
  assert.ok(section("Working"));
});

test("Earlier lists 20 rows, then Show more; the count holds the frozen list while it's in use", () => {
  const earlier = Array.from({ length: 25 }, (_, index) =>
    entry(`old-${String(index).padStart(2, "0")}`, { updatedAt: NOW - (index + 1) * HOUR }));
  const { rerender, container } = render(view(earlier));
  assert.equal(rowTitles(section("Earlier")).length, 20);
  assert.ok(screen.getByRole("button", { name: "Show 5 more" }));

  const root = container.querySelector<HTMLElement>("[data-inbox-view]")!;
  fireEvent.pointerOver(root);
  assert.equal(root.dataset.inboxFrozen, "true");
  const before = rowTitles(section("Earlier"));

  // A newer chat lands while the pointer is over the list: it waits behind Show more.
  rerender(view([entry("fresh", { updatedAt: NOW - MINUTE }), ...earlier]));
  assert.deepEqual(rowTitles(section("Earlier")), before);
  assert.ok(screen.getByRole("button", { name: "Show 6 more" }));

  fireEvent.pointerOver(document.body);
  assert.equal(rowTitles(section("Earlier"))[0], "Chat fresh");
  assert.ok(screen.getByRole("button", { name: "Show 6 more" }));

  fireEvent.click(screen.getByRole("button", { name: "Show 6 more" }));
  assert.equal(rowTitles(section("Earlier")).length, 26);
  assert.equal(screen.queryByRole("button", { name: /^Show \d+ more$/u }), null);
});

test("a resolved approval holds its slot while the list is in use, then moves on release", () => {
  const { rerender, container } = render(view([
    entry("a", { rowState: "needs_approval", attentionSince: NOW - MINUTE }),
    entry("b"),
  ]));
  const root = container.querySelector<HTMLElement>("[data-inbox-view]")!;
  fireEvent.pointerOver(root);
  rerender(view([entry("a"), entry("b")]));
  // Well past the 400ms debounce, the frozen list still holds it in place.
  nowMs = NOW + 5_000;
  rerender(view([entry("a"), entry("b")]));
  assert.deepEqual(rowTitles(section("Needs you")), ["Chat a"]);
  fireEvent.pointerOver(document.body);
  assert.equal(screen.queryByRole("group", { name: "Needs you" }), null);
  assert.deepEqual(rowTitles(section("Earlier")).sort(), ["Chat a", "Chat b"]);
});

test("a row that leaves Needs you lingers 400ms before it moves", () => {
  const { rerender } = render(view([entry("a", { rowState: "needs_approval", attentionSince: NOW - MINUTE })]));
  rerender(view([entry("a")]));
  assert.deepEqual(rowTitles(section("Needs you")), ["Chat a"]);
  nowMs = NOW + 450;
  rerender(view([entry("a")]));
  assert.equal(screen.queryByRole("group", { name: "Needs you" }), null);
  assert.deepEqual(rowTitles(section("Earlier")), ["Chat a"]);
});

/** A local Bot's rows, built by the sidebar's own rule; `seenAt` is the newest reply marked read. */
function botRows(state: { needsYou?: boolean; lastReplyAt?: number | null; seenAt?: number }) {
  return botInboxRows({
    bots: [{
      bot: botFixture({ id: "b1", name: "Trip Planner" }),
      activityAt: NOW - 5 * MINUTE,
      needsYou: state.needsYou ?? false,
      lastReplyAt: state.lastReplyAt ?? null,
    }],
    openBotId: null,
    unread: (_botId, lastReplyAt) => lastReplyAt !== null && lastReplyAt > (state.seenAt ?? 0),
  });
}

test("a Bot read elsewhere while the pointer is on the list stays put, read, until it leaves", () => {
  const unread = botRows({ lastReplyAt: NOW - 2 * MINUTE });
  const { rerender } = render(view(unread.listed, { unlisted: unread.unlisted }));
  const botRow = () => screen.getByRole("button", { name: /^Trip Planner,/u });
  assert.match(botRow().getAttribute("aria-label") ?? "", /Unread/u);
  fireEvent.pointerOver(inboxRoot());

  // Read from the Bot list or its chat: the Bot no longer qualifies, so it leaves the listed rows.
  const read = botRows({ lastReplyAt: NOW - 2 * MINUTE, seenAt: NOW - 2 * MINUTE });
  assert.equal(read.listed.length, 0);
  rerender(view(read.listed, { unlisted: read.unlisted }));
  assert.deepEqual(rowTitles(section("Updates")), ["Trip Planner"]);
  assert.doesNotMatch(botRow().getAttribute("aria-label") ?? "", /Unread/u, "it shows its live, read state");

  fireEvent.pointerOver(document.body);
  assert.equal(screen.queryByRole("button", { name: /^Trip Planner,/u }), null);
});

test("⌘N opens the Nth row on screen, a Bot lingering in Needs you after it was answered elsewhere included", () => {
  let reported: readonly string[] = [];
  const onShortcutOrderChange = (keys: readonly string[]) => {
    reported = keys;
  };
  const chats = [entry("u", { unread: true, updatedAt: NOW - MINUTE }), entry("a")];
  const waiting = botRows({ needsYou: true });
  const { rerender } = render(view([...chats, ...waiting.listed], { unlisted: waiting.unlisted, onShortcutOrderChange }));
  // Answered from the Bot list or its chat: the Bot no longer qualifies, but lingers 400ms.
  const answered = botRows({});
  assert.equal(answered.listed.length, 0);
  rerender(view([...chats, ...answered.listed], { unlisted: answered.unlisted, onShortcutOrderChange }));

  // The sidebar's lookup: listed rows first, then Bots that no longer qualify.
  const listed = new Map(chats.map((item) => [item.key, item] as const));
  const unlisted = new Map(answered.unlisted.map((item) => [item.key, item] as const));
  const resolve = (key: string) => listed.get(key) ?? unlisted.get(key);
  const onScreen = rowTitles(inboxRoot());
  assert.deepEqual(onScreen, ["Trip Planner", "Chat u", "Chat a"]);
  const targets = inboxShortcutTargets(reported, resolve, null);
  assert.deepEqual(targets.jump.map((item) => item?.title), onScreen, "⌘1 opens the lingering Bot, ⌘2 the row labelled ⌘2");
  assert.equal(targets.next?.title, "Trip Planner");

  const fromChat = inboxShortcutTargets(reported, resolve, chats[0]!.key);
  assert.equal(fromChat.previous?.title, "Trip Planner");
  assert.equal(fromChat.next?.title, "Chat a");
});

test("a Bot answered elsewhere lingers 400ms in Needs you; a deleted one goes at once", () => {
  const waiting = botRows({ needsYou: true });
  const answered = botRows({});
  const { rerender } = render(view(waiting.listed, { unlisted: waiting.unlisted }));
  assert.deepEqual(rowTitles(section("Needs you")), ["Trip Planner"]);
  rerender(view(answered.listed, { unlisted: answered.unlisted }));
  assert.deepEqual(rowTitles(section("Needs you")), ["Trip Planner"]);
  nowMs = NOW + 450;
  rerender(view(answered.listed, { unlisted: answered.unlisted }));
  assert.equal(screen.queryByRole("group", { name: "Needs you" }), null);

  cleanup();
  nowMs = NOW;
  const again = render(view(waiting.listed, { unlisted: waiting.unlisted }));
  again.rerender(view([], { unlisted: [] }));
  assert.equal(screen.queryByRole("group", { name: "Needs you" }), null, "a Bot that no longer exists doesn't linger");
});

test("the Working shelf collapses to its header and drops its rows from the list", () => {
  render(view([entry("busy", { rowState: "working" }), entry("quiet")]));
  const shelf = section("Working");
  assert.deepEqual(rowTitles(shelf), ["Chat busy"]);
  const toggle = within(shelf).getByRole("button", { expanded: true });
  fireEvent.click(toggle);
  assert.deepEqual(rowTitles(section("Working")), []);
  assert.ok(within(section("Working")).getByRole("button", { expanded: false }));
});

test("keyboard focus inside the list freezes it, and focus leaving releases it", () => {
  render(view([entry("a"), entry("b")]));
  act(() => rowButton("Chat a").focus());
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");
  act(() => rowButton("Chat a").blur());
  assert.equal(inboxRoot().dataset.inboxFrozen, undefined);
});

test("an open menu or dialog holds the freeze after the pointer leaves", async () => {
  render(view([entry("a")]));
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  await act(async () => {
    document.body.append(menu);
  });
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");
  fireEvent.pointerOver(document.body);
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");
  await act(async () => {
    menu.remove();
  });
  assert.equal(inboxRoot().dataset.inboxFrozen, undefined);
});

test("a focused row that goes hands focus to the row in its place, and the last one releases the freeze", () => {
  const { rerender } = render(view([entry("a", { updatedAt: NOW - MINUTE }), entry("b")]));
  act(() => rowButton("Chat a").focus());
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");

  // Deleted while focused: focus moves to the row now in its place.
  rerender(view([entry("b")]));
  assert.equal(document.activeElement, rowButton("Chat b"));
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");

  // Nothing left to take focus: it falls to the page and the list lets go.
  rerender(view([]));
  assert.equal(document.activeElement, document.body);
  assert.equal(inboxRoot().dataset.inboxFrozen, undefined);
});

test("the pointer over a row's portalled popup is not the pointer over the list", () => {
  const withPopup = (item: InboxEntry, context: InboxRowContext) => (
    <>
      {renderRow()(item, context)}
      {createPortal(<div data-testid={`popup-${item.title}`}>Popup</div>, document.body)}
    </>
  );
  render(view([entry("a")], { renderRow: withPopup }));
  fireEvent.pointerOver(screen.getByTestId("popup-Chat a"));
  assert.equal(inboxRoot().dataset.inboxFrozen, undefined);
  fireEvent.pointerOver(rowButton("Chat a"));
  assert.equal(inboxRoot().dataset.inboxFrozen, "true");
});

test("a search that only matches working chats lists them on the shelf, not No matches", () => {
  render(view([entry("busy", { rowState: "working" })], { searching: true }));
  assert.equal(screen.queryByText("No matches"), null);
  assert.deepEqual(rowTitles(section("Working")), ["Chat busy"]);
});

test("given a shelf host, the Working shelf renders there and the pointer over it freezes the list", () => {
  const host = document.createElement("div");
  document.body.append(host);
  try {
    render(view([entry("busy", { rowState: "working" }), entry("quiet")], { shelfHost: host }));
    const shelf = section("Working");
    assert.ok(host.contains(shelf));
    assert.equal(inboxRoot().contains(shelf), false);
    fireEvent.pointerOver(within(shelf).getByRole("button", { name: /\bChat busy\b/u }));
    assert.equal(inboxRoot().dataset.inboxFrozen, "true");
  } finally {
    cleanup();
    host.remove();
  }
});

/**
 * Lays rows out 32px apart in document order and records slides, so a test can
 * watch which rows animate and which slides get cancelled.
 */
function stubRowLayout() {
  type Slide = { row: string; from: string; cancelled: boolean; cancel: () => void };
  const slides: Slide[] = [];
  const proto = HTMLElement.prototype;
  const original = {
    rect: proto.getBoundingClientRect,
    animate: proto.animate,
    getAnimations: proto.getAnimations,
  };
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const rows = [...document.querySelectorAll("[data-inbox-row]")];
    const top = this.hasAttribute("data-inbox-row") ? rows.indexOf(this) * 32 : 0;
    return { top, bottom: top + 32, left: 0, right: 200, width: 200, height: 32, x: 0, y: top, toJSON: () => ({}) };
  };
  proto.animate = function (this: HTMLElement, keyframes: Keyframe[]) {
    const slide: Slide = {
      row: this.dataset.inboxRow ?? "",
      from: String(keyframes[0]?.transform),
      cancelled: false,
      cancel: () => { slide.cancelled = true; },
    };
    slides.push(slide);
    return slide as unknown as Animation;
  } as typeof proto.animate;
  proto.getAnimations = function (this: HTMLElement) {
    return slides.filter((slide) => !slide.cancelled && slide.row === this.dataset.inboxRow) as unknown as Animation[];
  };
  return {
    slides,
    restore() {
      proto.getBoundingClientRect = original.rect;
      proto.animate = original.animate;
      proto.getAnimations = original.getAnimations;
    },
  };
}

test("a reorder slides the moved rows, and a re-render that moves nothing leaves the slides running", () => {
  const layout = stubRowLayout();
  try {
    const a = projectOrderKey("local", "a");
    const b = projectOrderKey("local", "b");
    const { rerender } = render(view([entry("a", { updatedAt: NOW - MINUTE }), entry("b", { updatedAt: NOW - HOUR })]));
    assert.equal(layout.slides.length, 0);

    // b becomes the newer chat: the two swap, each sliding from its old place.
    rerender(view([entry("a", { updatedAt: NOW - HOUR }), entry("b", { updatedAt: NOW - MINUTE })]));
    assert.deepEqual(rowTitles(section("Earlier")), ["Chat b", "Chat a"]);
    assert.deepEqual(
      layout.slides.map(({ row, from }) => [row, from]).sort(),
      [[a, "translateY(-32px)"], [b, "translateY(32px)"]].sort(),
    );

    // Re-renders that move nothing (a streaming update, the parent taking the shortcut order).
    rerender(view([entry("a", { updatedAt: NOW - HOUR }), entry("b", { updatedAt: NOW - MINUTE })]));
    rerender(view([entry("a", { updatedAt: NOW - HOUR }), entry("b", { updatedAt: NOW - MINUTE })]));
    assert.equal(layout.slides.length, 2);
    assert.ok(layout.slides.every((slide) => !slide.cancelled));
  } finally {
    layout.restore();
  }
});
