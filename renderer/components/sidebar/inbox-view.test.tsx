// Installs happy-dom for the Testing Library cases; must stay the first import.
import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "../ui";
import { ChatRow } from "./chat-row";
import { InboxView, type InboxRowContext } from "./inbox-view";
import { inboxRowAction, type InboxEntry } from "../../lib/sidebar-inbox-view";
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

function view(entries: readonly InboxEntry[], extra: { onMarkRead?: (key: string) => void } = {}) {
  return (
    <TooltipProvider>
      <InboxView entries={entries} now={clock} renderRow={renderRow(extra.onMarkRead)} />
    </TooltipProvider>
  );
}

function section(name: string): HTMLElement {
  return screen.getByRole("group", { name });
}

function rowTitles(container: HTMLElement): string[] {
  return within(container)
    .queryAllByRole("button")
    .filter((button) => button.hasAttribute("data-roving-item") && button.dataset.inboxShowMore === undefined)
    .map((button) => button.querySelector("[data-chat-unread], span.block")?.textContent ?? "");
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
  fireEvent.pointerEnter(root);
  assert.equal(root.dataset.inboxFrozen, "true");
  const before = rowTitles(section("Earlier"));

  // A newer chat lands while the pointer is over the list: it waits behind Show more.
  rerender(view([entry("fresh", { updatedAt: NOW - MINUTE }), ...earlier]));
  assert.deepEqual(rowTitles(section("Earlier")), before);
  assert.ok(screen.getByRole("button", { name: "Show 6 more" }));

  fireEvent.pointerLeave(root);
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
  fireEvent.pointerEnter(root);
  rerender(view([entry("a"), entry("b")]));
  // Well past the 400ms debounce, the frozen list still holds it in place.
  nowMs = NOW + 5_000;
  rerender(view([entry("a"), entry("b")]));
  assert.deepEqual(rowTitles(section("Needs you")), ["Chat a"]);
  fireEvent.pointerLeave(root);
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

test("the Working shelf collapses to its header and drops its rows from the list", () => {
  render(view([entry("busy", { rowState: "working" }), entry("quiet")]));
  const shelf = section("Working");
  assert.deepEqual(rowTitles(shelf), ["Chat busy"]);
  const toggle = within(shelf).getByRole("button", { expanded: true });
  fireEvent.click(toggle);
  assert.deepEqual(rowTitles(section("Working")), []);
  assert.ok(within(section("Working")).getByRole("button", { expanded: false }));
});
