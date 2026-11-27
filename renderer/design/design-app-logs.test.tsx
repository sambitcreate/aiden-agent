// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DesignAppLogs, DesignAppsSnapshot, DesignAppStatus } from "../shared/design-app";
import { resetDesignAppChipForTests } from "./design-app-chip";
import { DesignAppLogsDrawer, DESIGN_APP_LOGS_KEEP } from "./design-app-logs";
import { DesignPaneContext, type DesignPane } from "./design-pane";

afterEach(() => {
  cleanup();
  resetDesignAppChipForTests();
  delete document.documentElement.dataset.reduceMotion;
});

const KIB = 1024;

function status(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return { workspaceId: "ws", appRoot: ".", source: "started", frameworkLabel: "Vite", phase: "running", origin: "http://127.0.0.1:5173", port: 5173, since: 1, revision: 1, ...overrides };
}

function snapshot(apps: DesignAppStatus[] = [status()]): DesignAppsSnapshot {
  return { workspaceId: "ws", target: "single", apps, candidates: [], chosen: [] };
}

function read(overrides: Partial<DesignAppLogs>): DesignAppLogs {
  return { run: "r1", text: "", from: 0, next: 0, end: 0, truncated: false, ...overrides };
}

/** Retries `get` until it stops throwing, with timers and React running between tries. Compares booleans, never DOM nodes. */
async function until<T>(get: () => T, tries = 200): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return get();
    } catch (error) {
      if (attempt >= tries) throw error;
    }
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
}

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

type Options = { after?: number; run?: string };

/** A scripted `designApp:logs`: each read answers with the next response, then the last one again. */
function scriptLogs(responses: Array<DesignAppLogs | ((options: Options) => DesignAppLogs)>) {
  const reads: Options[] = [];
  const handler = (_chatId: unknown, _root: unknown, options: unknown) => {
    const asked = options as Options;
    reads.push(asked);
    const response = responses[Math.min(reads.length - 1, responses.length - 1)]!;
    return typeof response === "function" ? response(asked) : response;
  };
  return { reads, handler };
}

function Harness({
  initial = ".",
  pane,
  pollMs = 60_000,
}: {
  initial?: string | null;
  pane?: { stacked: boolean; pane: DesignPane };
  pollMs?: number;
}) {
  const [root, setRoot] = React.useState<string | null>(initial);
  const chip = React.useRef<HTMLButtonElement>(null);
  return (
    <DesignPaneContext.Provider value={{ stacked: pane?.stacked ?? false, pane: pane?.pane ?? "canvas", setPane: () => {} }}>
      <button ref={chip} type="button" onClick={() => setRoot(".")}>
        Chip
      </button>
      <div style={{ position: "relative" }}>
        <DesignAppLogsDrawer chatId="chat-1" appRoot={root} onClose={() => setRoot(null)} returnFocus={() => chip.current} pollMs={pollMs} />
      </div>
    </DesignPaneContext.Provider>
  );
}

function mount(logs: ReturnType<typeof scriptLogs>, props: React.ComponentProps<typeof Harness> = {}, apps = snapshot()) {
  installBotTestIpc({ "designApp:status:get": () => apps, "designApp:logs": logs.handler });
  return render(<Harness {...props} />);
}

const output = () => screen.getByRole("log");
const outputText = () => output().textContent ?? "";

// ── Reading (B-B2) ──

test("opening probes with after 0; a run of 100 KiB keeps the probe's text and continues from its next", async () => {
  const logs = scriptLogs([
    read({ text: "hello\n", next: 6, end: 100 * KIB }),
    read({ text: "world\n", from: 6, next: 12, end: 12 }),
  ]);
  mount(logs);
  await until(() => assert.equal(outputText(), "hello\nworld\n"));
  assert.deepEqual(logs.reads[0], { after: 0 });
  assert.deepEqual(logs.reads[1], { run: "r1", after: 6 });
  assert.equal(outputText().includes("Earlier output was dropped"), false);
});

test("a run of 1 MiB drops the probe's text, shows Earlier output was dropped, and reads from end − 256 KiB", async () => {
  const end = 1024 * KIB;
  const logs = scriptLogs([read({ text: "PROBE\n", next: 6, end }), read({ text: "tail\n", from: end - DESIGN_APP_LOGS_KEEP, next: end, end })]);
  mount(logs);
  await until(() => assert.equal(outputText(), "Earlier output was droppedtail\n"));
  assert.deepEqual(logs.reads[1], { run: "r1", after: end - 256 * KIB });
});

test("while next is below end the next read is sent at once; a read that doesn't advance waits for the poll", async () => {
  const logs = scriptLogs([read({ text: "a\n", next: 2, end: 100 }), read({ text: "", from: 2, next: 2, end: 100 })]);
  mount(logs, { pollMs: 60_000 });
  await until(() => assert.equal(logs.reads.length, 2));
  await wait(100);
  assert.equal(logs.reads.length, 2, "no read until the next poll");
});

test("then it polls with run and next", async () => {
  const logs = scriptLogs([read({ text: "a\n", next: 2, end: 2 }), read({ text: "", from: 2, next: 2, end: 2 })]);
  mount(logs, { pollMs: 20 });
  await until(() => assert.ok(logs.reads.length >= 4));
  for (const asked of logs.reads.slice(1)) assert.deepEqual(asked, { run: "r1", after: 2 });
});

test("a response for another run adds a New run line and continues from it", async () => {
  const logs = scriptLogs([
    read({ text: "old\n", next: 4, end: 4 }),
    read({ run: "r2", text: "fresh\n", next: 6, end: 6, truncated: true }),
    read({ run: "r2", text: "", from: 6, next: 6, end: 6 }),
  ]);
  mount(logs, { pollMs: 20 });
  await until(() => assert.equal(outputText(), "old\nNew runfresh\n"));
  await until(() => assert.ok(logs.reads.length >= 3));
  assert.deepEqual(logs.reads[2], { run: "r2", after: 6 });
});

test("truncated adds an Earlier output was dropped line", async () => {
  const logs = scriptLogs([read({ text: "a\n", next: 2, end: 2 }), read({ text: "b\n", from: 50, next: 52, end: 52, truncated: true })]);
  mount(logs, { pollMs: 20 });
  await until(() => assert.equal(outputText().startsWith("a\nEarlier output was droppedb\n"), true));
});

test("past 256 KiB the oldest chunks go, the first kept chunk starts at a line, and one dropped line stays on top", async () => {
  // About 100 KiB of short lines (each under the 4 KiB line cap), headed by a line that names the chunk.
  const chunk = (head: string, letter: string) => `${head}\n${`${letter.repeat(99)}\n`.repeat(1000)}`;
  const first = chunk("first", "a");
  const second = chunk("partial", "b");
  const third = chunk("third", "c");
  const total = first.length + second.length + third.length;
  assert.ok(first.length + second.length <= DESIGN_APP_LOGS_KEEP && total > DESIGN_APP_LOGS_KEEP);
  // The run grows while the drawer is open, so the probe starts at 0 and the drop happens in the drawer.
  const logs = scriptLogs([
    read({ text: first, next: first.length, end: first.length }),
    read({ text: second, from: first.length, next: first.length + second.length, end: first.length + second.length }),
    read({ text: third, from: first.length + second.length, next: total, end: total }),
    read({ text: "", from: total, next: total, end: total }),
  ]);
  mount(logs, { pollMs: 10 });
  await until(() => assert.equal(outputText().endsWith(third), true));
  const text = outputText();
  assert.equal(text.split("Earlier output was dropped").length - 1, 1, "one dropped line");
  assert.equal(text.startsWith("Earlier output was dropped"), true, "on top");
  assert.equal(text.includes("first"), false, "the oldest chunk went");
  assert.equal(text.includes("partial"), false, "the first kept chunk lost its text up to its first line break");
  assert.equal(text.startsWith(`Earlier output was dropped${"b".repeat(10)}`), true);
  assert.ok(text.length - "Earlier output was dropped".length <= DESIGN_APP_LOGS_KEEP);
});

test("the 256 KiB the drawer keeps are UTF-8 bytes, not characters", async () => {
  // Two chunks of three-byte characters: about 100 K characters together (under 256 K), but about 300 KiB.
  const chunk = (head: string, letter: string) => `${head}\n${`${letter.repeat(99)}\n`.repeat(500)}`;
  const first = chunk("first", "€");
  const second = chunk("second", "₩");
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  assert.ok(first.length + second.length < DESIGN_APP_LOGS_KEEP && bytes(first) + bytes(second) > DESIGN_APP_LOGS_KEEP);
  const logs = scriptLogs([
    read({ text: first, next: bytes(first), end: bytes(first) }),
    read({ text: second, from: bytes(first), next: bytes(first) + bytes(second), end: bytes(first) + bytes(second) }),
    read({ text: "", from: bytes(first) + bytes(second), next: bytes(first) + bytes(second), end: bytes(first) + bytes(second) }),
  ]);
  mount(logs, { pollMs: 10 });
  // The kept chunk starts at a line, so its head line goes with the dropped chunk.
  const body = second.slice(second.indexOf("\n") + 1);
  await until(() => assert.equal(outputText().endsWith(body), true));
  const text = outputText();
  assert.equal(text.includes("first"), false, "the oldest chunk went");
  assert.equal(text.startsWith("Earlier output was dropped"), true);
  assert.ok(bytes(text.slice("Earlier output was dropped".length)) <= DESIGN_APP_LOGS_KEEP);
});

/** A log main serves like `DesignAppServers.logs`: 64 KiB a read from the cursor, a cursor of another run reading the new run from 0. */
function liveLog(initial: string) {
  const state = { run: "r1", text: initial };
  const reads: Array<Options & { at: number }> = [];
  const handler = (_chatId: unknown, _root: unknown, options: unknown) => {
    const asked = options as Options;
    reads.push({ ...asked, at: Date.now() });
    const otherRun = asked.run !== undefined && asked.run !== state.run;
    const from = otherRun || (asked.after ?? 0) > state.text.length ? 0 : (asked.after ?? 0);
    const next = Math.min(state.text.length, from + 64 * KIB);
    return read({ run: state.run, text: state.text.slice(from, next), from, next, end: state.text.length, truncated: otherRun });
  };
  return { state, reads, handler };
}

const lines = (letter: string, bytes: number) => `${letter.repeat(99)}\n`.repeat(Math.ceil(bytes / 100));
const SKIPPED = "Output was skipped to show the latest";

test("after the first read, a log that grew is caught up with 64 KiB reads sent back to back, not one a poll", async () => {
  const log = liveLog("start\n");
  installBotTestIpc({ "designApp:status:get": () => snapshot(), "designApp:logs": log.handler });
  render(<Harness pollMs={400} />);
  await until(() => assert.equal(outputText(), "start\n"));
  log.state.text += lines("a", 200 * KIB);
  await until(() => assert.equal(outputText().length, log.state.text.length), 400);
  const catchUp = log.reads.slice(1);
  assert.ok(catchUp.length >= 4, `at least four reads, saw ${catchUp.length}`);
  for (let index = 1; index < catchUp.length; index += 1) {
    assert.ok(catchUp[index]!.at - catchUp[index - 1]!.at < 200, "the next read went out without the 400 ms wait");
  }
});

test("resumed after a pause more than 256 KiB behind, it drops what it held, says output was skipped, and reads from end − 256 KiB", async () => {
  const log = liveLog("start\n");
  installBotTestIpc({ "designApp:status:get": () => snapshot(), "designApp:logs": log.handler });
  const view = render(<Harness pollMs={20} />);
  await until(() => assert.equal(outputText(), "start\n"));
  view.rerender(<Harness pollMs={20} pane={{ stacked: true, pane: "chat" }} />);
  await wait(60);
  const paused = log.reads.length;
  log.state.text += lines("b", 1024 * KIB);
  const end = log.state.text.length;
  view.rerender(<Harness pollMs={20} pane={{ stacked: false, pane: "canvas" }} />);
  await until(() => assert.equal(outputText().endsWith(log.state.text.slice(-1000)), true), 400);
  const text = outputText();
  assert.equal(text.startsWith(SKIPPED), true, "one line says output was skipped");
  assert.equal(text.includes("start"), false, "what it held went");
  assert.equal(log.reads.slice(paused).some((asked) => asked.after === end - DESIGN_APP_LOGS_KEEP), true, "it jumped to end − 256 KiB");
  assert.ok(log.reads.length - paused <= 8, `a bounded number of reads, saw ${log.reads.length - paused}`);
  assert.ok(text.length - SKIPPED.length <= DESIGN_APP_LOGS_KEEP);
});

test("a new run longer than 256 KiB drops the old run's text, says output was skipped, and reads from its end − 256 KiB", async () => {
  const log = liveLog("old run\n");
  installBotTestIpc({ "designApp:status:get": () => snapshot(), "designApp:logs": log.handler });
  render(<Harness pollMs={20} />);
  await until(() => assert.equal(outputText(), "old run\n"));
  const before = log.reads.length;
  log.state.run = "r2";
  log.state.text = lines("c", 1024 * KIB);
  const end = log.state.text.length;
  await until(() => assert.equal(outputText().endsWith(log.state.text.slice(-1000)), true), 400);
  const text = outputText();
  assert.equal(text.startsWith(SKIPPED), true);
  assert.equal(text.includes("old run"), false);
  assert.equal(log.reads.slice(before).some((asked) => asked.run === "r2" && asked.after === end - DESIGN_APP_LOGS_KEEP), true);
  assert.ok(log.reads.length - before <= 8, `a bounded number of reads, saw ${log.reads.length - before}`);
});

test("the cleaner's carry starts over on a new run and on a truncated read, so an escape split across them hides nothing", async () => {
  for (const second of [read({ run: "r2", text: `le${"\u0007"}visible\n`, next: 10, end: 10, truncated: true }), read({ text: `le${"\u0007"}visible\n`, from: 40, next: 50, end: 50, truncated: true })]) {
    const logs = scriptLogs([read({ text: "a\u001b]0;tit", next: 8, end: 8 }), second, read({ run: second.run, text: "", from: second.next, next: second.next, end: second.next })]);
    mount(logs, { pollMs: 20 });
    await until(() => assert.equal(outputText().includes("visible"), true));
    assert.equal(outputText().includes("le\\u{7}visible"), true, `the ${second.run === "r2" ? "new run" : "truncated read"} shows from its first byte`);
    cleanup();
    resetDesignAppChipForTests();
  }
});

test("polling stops when the canvas isn't shown, when the app leaves the snapshot, and when the drawer closes", async () => {
  const quiet = read({ text: "", next: 0, end: 0 });
  const logs = scriptLogs([quiet]);
  const view = mount(logs, { pollMs: 10, pane: { stacked: true, pane: "chat" } });
  await wait(60);
  assert.equal(logs.reads.length, 0, "the stacked layout shows the chat");
  view.rerender(<Harness pollMs={10} pane={{ stacked: true, pane: "canvas" }} />);
  await until(() => assert.ok(logs.reads.length >= 2));
  // The app leaves the snapshot.
  act(() => emitBotTestNotification("designApp:status", snapshot([status({ appRoot: "other" })])));
  await wait(30);
  const afterGone = logs.reads.length;
  await wait(60);
  assert.equal(logs.reads.length, afterGone, "no reads for an app that's gone");
  // Back again, then closed.
  act(() => emitBotTestNotification("designApp:status", snapshot()));
  await until(() => assert.ok(logs.reads.length > afterGone));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close logs" }));
  });
  await wait(30);
  const afterClose = logs.reads.length;
  await wait(60);
  assert.equal(logs.reads.length, afterClose, "no reads once closed");
});

test("a hidden document with the canvas pane shown keeps polling (B-m1)", async () => {
  const logs = scriptLogs([read({ text: "", next: 0, end: 0 })]);
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  try {
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    mount(logs, { pollMs: 10 });
    await until(() => assert.ok(logs.reads.length >= 4));
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

// ── Text ──

test("ANSI colour codes are gone and an OSC 52 sequence split across two reads leaves nothing", async () => {
  const first = "\u001b[31mred\u001b[0m\n\u001b]52;c;SGVsbG8";
  const second = "=\u0007after\n";
  const logs = scriptLogs([read({ text: first, next: 20, end: 20 }), read({ text: second, from: 20, next: 28, end: 28 }), read({ text: "", from: 28, next: 28, end: 28 })]);
  mount(logs, { pollMs: 10 });
  await until(() => assert.equal(outputText(), "red\nafter\n"));
});

test("an HTML string renders as text, not markup, and no link is made", async () => {
  const logs = scriptLogs([read({ text: "<b>bold</b> <img src=x onerror=alert(1)> https://example.com\n", next: 60, end: 60 })]);
  mount(logs);
  await until(() => assert.equal(outputText().includes("<b>bold</b>"), true));
  assert.equal(output().querySelector("b, img, a") === null, true);
});

// ── Scrolling ──

test("scrolled up, new output doesn't move the view and Jump to latest appears; pressing it scrolls to the end", async () => {
  let lines = 1;
  const logs = scriptLogs([
    read({ text: "line\n", next: 5, end: 5 }),
    (asked) => {
      const at = asked.after ?? 0;
      return read({ text: "more\n", from: at, next: at + 5, end: at + 5 });
    },
  ]);
  mount(logs, { pollMs: 40 });
  const pre = await until(() => output());
  let top = 0;
  Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 1000 + lines * 20 });
  Object.defineProperty(pre, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  // Following: new output scrolls to the end.
  lines += 1;
  await until(() => assert.equal(top, pre.scrollHeight));
  // Scrolled up.
  top = 200;
  act(() => {
    fireEvent.scroll(pre);
  });
  const jump = await until(() => screen.getByRole("button", { name: "Jump to latest" }));
  const before = logs.reads.length;
  lines += 5;
  await until(() => assert.ok(logs.reads.length > before + 1));
  assert.equal(top, 200, "new output leaves the view where the person put it");
  await act(async () => {
    fireEvent.click(jump);
  });
  assert.equal(top, pre.scrollHeight);
  assert.equal(screen.queryByRole("button", { name: "Jump to latest" }) === null, true);
});

// ── Keyboard ──

test("Escape closes it through the layer stack and focus returns to the chip", async () => {
  const logs = scriptLogs([read({ text: "a\n", next: 2, end: 2 })]);
  mount(logs);
  await until(() => output());
  await act(async () => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  await until(() => assert.equal(screen.queryByRole("log") === null, true));
  assert.equal(document.activeElement === screen.getByRole("button", { name: "Chip" }), true, "focus is on the chip");
});

test("the log region is focusable by keyboard, has focus when the drawer opens, and isn't announced", async () => {
  const logs = scriptLogs([read({ text: "a\n", next: 2, end: 2 })]);
  mount(logs);
  const pre = await until(() => output());
  assert.equal(pre.tabIndex, 0);
  assert.equal(pre.getAttribute("aria-live"), "off");
  await until(() => assert.equal(pre.getAttribute("aria-label"), "Output of Vite · workspace folder"));
  await until(() => assert.equal(document.activeElement === pre, true, "focus is on the output"));
});

test("the header names the app and its state", async () => {
  const logs = scriptLogs([read({ text: "", next: 0, end: 0 })]);
  mount(logs);
  await until(() => screen.getByRole("heading", { name: "Logs: Vite · workspace folder" }));
  await until(() => screen.getByText("Running at 127.0.0.1:5173"));
});

// ── Motion ──

test("under Reduce Motion it is shown and removed without waiting", async () => {
  document.documentElement.dataset.reduceMotion = "true";
  const logs = scriptLogs([read({ text: "", next: 0, end: 0 })]);
  mount(logs, { initial: null });
  assert.equal(screen.queryByRole("log") === null, true);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Chip" }));
  });
  assert.equal(screen.queryByRole("log") === null, false, "shown at once");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close logs" }));
  });
  assert.equal(screen.queryByRole("log") === null, true, "removed at once");
});
