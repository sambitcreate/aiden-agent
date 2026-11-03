import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { BotLiveActivity } from "../../shared/bot-live";
import { BotStatusAnnouncer, BotStatusLine } from "./bot-status-line";

afterEach(() => {
  mock.timers.reset();
  cleanup();
});

const reading: BotLiveActivity = {
  phase: "reading",
  startedAt: 1_000,
  step: { kind: "reading", label: "Reading", detail: "grocery-list.md" },
};

/** What the line says when a screen reader reaches it. */
function said(): string | null {
  return screen.getByRole("group").getAttribute("aria-label");
}

/** What a screen reader is told: the live region's text. */
function announced(): string | null {
  return screen.getByRole("status").textContent;
}

test("the line says the phase with its step on the Mac, and only Thinking with Always Thinking", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000} />);
  assert.equal(said(), "Reading, grocery-list.md");
  cleanup();
  render(<BotStatusLine activity={reading} wording="thinking" now={1_000} />);
  assert.equal(said(), "Thinking");
  assert.equal(screen.queryByText(/grocery-list\.md/u) === null, true, "Always Thinking never peeks at the step");
});

test("waiting keeps its word under Always Thinking, and an unknown phase reads as Working", () => {
  render(<BotStatusLine activity={{ phase: "waiting", startedAt: 0 }} wording="thinking" now={0} />);
  assert.equal(said(), "Waiting for you");
  cleanup();
  render(<BotStatusLine activity={{ phase: "browsing" as never, startedAt: 0 }} wording="follows" now={0} />);
  assert.equal(said(), "Working");
});

test("after 20 seconds the line shows elapsed time; after 2 minutes, a still-going note", () => {
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 19_000} />);
  assert.equal(screen.queryByText(/19s/u) === null, true);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 72_000} />);
  assert.ok(screen.getByText("· 1m 12s"));
  assert.equal(screen.queryByRole("note") === null, true);
  cleanup();
  render(<BotStatusLine activity={reading} wording="follows" now={1_000 + 121_000} />);
  assert.ok(screen.getByRole("note"));
  assert.ok(screen.getByText("Still going. I'll message you when it's done."));
});

test("the still-going note is only for work in progress, not while it waits on you or stops", () => {
  const late = 1_000 + 121_000;
  render(<BotStatusLine activity={{ phase: "waiting", startedAt: 1_000 }} wording="follows" now={late} />);
  assert.equal(said(), "Waiting for you");
  assert.equal(screen.queryByRole("note") === null, true, "waiting on the person");
  cleanup();
  render(<BotStatusLine activity={{ phase: "stopping", startedAt: 1_000 }} wording="thinking" now={late} />);
  assert.equal(said(), "Stopping");
  assert.equal(screen.queryByRole("note") === null, true, "already stopping");
});

test("the live region starts empty and fills after it mounts, so the first wording is announced", () => {
  const observer = new MutationObserver(() => {});
  const view = render(<div />);
  observer.observe(view.container, { subtree: true, childList: true, characterData: true });
  view.rerender(<BotStatusAnnouncer text="Getting ready" />);
  const records = observer.takeRecords();
  observer.disconnect();
  const region = screen.getByRole("status");
  assert.equal(announced(), "Getting ready");
  const filledLater = records.some(
    (record) => record.target === region && Array.from(record.addedNodes).some((node) => node.textContent === "Getting ready"),
  );
  assert.equal(filledLater, true, "the wording arrives as a change inside the already-mounted region");
});

test("the announcement changes at most once every 2 seconds, and ends on the newest wording", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const view = render(<BotStatusAnnouncer text="Reading, grocery-list.md" />);
  assert.equal(announced(), "Reading, grocery-list.md");

  mock.timers.tick(500);
  view.rerender(<BotStatusAnnouncer text="Searching the web" />);
  assert.equal(announced(), "Reading, grocery-list.md", "a change inside the gap waits");

  mock.timers.tick(500);
  view.rerender(<BotStatusAnnouncer text="Writing" />);
  assert.equal(announced(), "Reading, grocery-list.md", "still inside the gap");

  act(() => mock.timers.tick(1_000));
  assert.equal(announced(), "Writing", "the gap passed: the newest wording wins, not the skipped one");
});

test("a change after a quiet spell is announced at once", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const view = render(<BotStatusAnnouncer text="Reading, grocery-list.md" />);
  mock.timers.tick(3_000);
  view.rerender(<BotStatusAnnouncer text="Writing" />);
  assert.equal(announced(), "Writing");
});

test("hiding the line clears the region at once, and the gap still holds for what comes next", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 });
  const view = render(<BotStatusAnnouncer text="Reading, grocery-list.md" />);
  mock.timers.tick(500);
  view.rerender(<BotStatusAnnouncer text="" />);
  assert.equal(announced(), "", "the words are streaming: nothing stale stays in the region");

  mock.timers.tick(500);
  view.rerender(<BotStatusAnnouncer text="Editing files" />);
  assert.equal(announced(), "", "inside the gap since the last announcement");
  act(() => mock.timers.tick(1_000));
  assert.equal(announced(), "Editing files");
});

test("running labels share one second clock, stay current across staggered mounts, and stop it when unused", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 40_250 });
  const pending = new Set<ReturnType<typeof setTimeout>>();
  let scheduled = 0;
  t.mock.method(window, "setTimeout", (handler: () => void, delay: number) => {
    scheduled += 1;
    const handle = setTimeout(() => {
      pending.delete(handle);
      handler();
    }, delay);
    pending.add(handle);
    return handle as unknown as number;
  });
  t.mock.method(window, "clearTimeout", (handle: number) => {
    pending.delete(handle as unknown as ReturnType<typeof setTimeout>);
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
  const Labels = ({ count, fixed = false }: { count: number; fixed?: boolean }) => (
    <>
      {Array.from({ length: count }, (_, index) => (
        <BotStatusLine key={index} activity={reading} wording="thinking" now={fixed ? 40_250 : undefined} />
      ))}
    </>
  );
  try {
    const view = render(<Labels count={1} />);
    assert.equal(pending.size, 1);
    assert.equal(screen.getByText("· 39s").textContent, "· 39s");
    act(() => t.mock.timers.tick(250));
    view.rerender(<Labels count={10} />);
    assert.equal(pending.size, 1, "new labels join the existing clock");
    assert.equal(scheduled, 1, "staggered mounts do not reschedule its phase");
    act(() => t.mock.timers.tick(500));
    assert.equal(screen.getAllByText("· 40s").length, 10, "all labels tick on the same wall-clock second");
    assert.equal(pending.size, 1);
    view.rerender(<Labels count={2} />);
    assert.equal(pending.size, 1, "unmounting some labels keeps the clock for the others");
    view.rerender(<Labels count={2} fixed />);
    assert.equal(pending.size, 0, "fixed previews never keep the clock alive");
    act(() => t.mock.timers.tick(5_000));
    view.rerender(<Labels count={2} />);
    assert.equal(screen.getAllByText("· 45s").length, 2, "resuming after idle refreshes the cached time immediately");
    assert.equal(pending.size, 1);
    view.unmount();
    assert.equal(pending.size, 0, "the final unmount cancels the only timer");
  } finally {
    cleanup();
  }
});
