// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Toaster } from "../components/ui";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import type { DesignAppsSnapshot, DesignAppStatus } from "../shared/design-app";
import { DesignAppStatusChip, resetDesignAppChipForTests } from "./design-app-chip";

afterEach(() => {
  cleanup();
  resetDesignAppChipForTests();
});

function status(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return { workspaceId: "ws", appRoot: ".", source: "started", framework: "vite", frameworkLabel: "Vite", phase: "stopped", since: 1, revision: 1, ...overrides };
}

function snapshot(apps: DesignAppStatus[], overrides: Partial<DesignAppsSnapshot> = {}): DesignAppsSnapshot {
  return {
    workspaceId: "ws",
    target: "single",
    apps,
    candidates: [{ appRoot: ".", framework: "vite", frameworkLabel: "Vite", script: "dev" }],
    chosen: [],
    ...overrides,
  };
}

const RUNNING = status({ phase: "running", origin: "http://127.0.0.1:5173", port: 5173, revision: 4 });
const ATTACHED = status({ source: "attached", phase: "running", origin: "http://127.0.0.1:5173", port: 5173, revision: 2 });

/** A promise the test settles by hand. */
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Retries `get` until it stops throwing, letting timers and React run between
 * tries inside `act`. Assertions here compare booleans, never DOM nodes: a
 * failing comparison of a happy-dom node makes assert inspect its whole
 * object graph, which stalls the run instead of failing it.
 */
async function until<T>(get: () => T, tries = 100): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return get();
    } catch (error) {
      if (attempt >= tries) throw error;
    }
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}

function Chip({ designLive = true, onShowLogs }: { designLive?: boolean; onShowLogs?: (appRoot: string) => void }) {
  return (
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive }}>
      <Toaster />
      <DesignAppStatusChip chatId="chat-1" {...(onShowLogs ? { onShowLogs } : {})} />
    </AppCapabilitiesProvider>
  );
}

function mount(
  read: DesignAppsSnapshot | (() => unknown),
  handlers: Record<string, (...args: unknown[]) => unknown> = {},
  props: { designLive?: boolean; onShowLogs?: (appRoot: string) => void } = {},
) {
  const calls = installBotTestIpc({ "designApp:status:get": typeof read === "function" ? read : () => read, ...handlers });
  render(<Chip {...props} />);
  return calls;
}

const trigger = () => until(() => screen.getByRole("button", { name: /^Live app:/u }));

async function openMenu() {
  const button = await trigger();
  await act(async () => {
    fireEvent.keyDown(button, { key: "Enter" });
  });
  return until(() => screen.getByRole("menu"));
}

async function closeMenu(menu: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Escape" });
  });
  await until(() => assert.equal(screen.queryByRole("menu") === null, true));
}

async function choose(menu: HTMLElement, name: string, index = 0) {
  const item = within(menu).getAllByRole("menuitem", { name })[index]!;
  await act(async () => {
    fireEvent.click(item);
  });
}

function broadcast(next: DesignAppsSnapshot) {
  act(() => emitBotTestNotification("designApp:status", next));
}

const menuItems = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent);

/** The menu's text, read by opening and closing the menu. */
async function menuText(): Promise<string> {
  const menu = await openMenu();
  const text = menu.textContent ?? "";
  await closeMenu(menu);
  return text;
}

// ── Visibility (B-M2) ──

test("no chip and no read while designLive is off; no chip for target unavailable", async () => {
  const calls = mount(snapshot([RUNNING]), {}, { designLive: false });
  await until(() => undefined);
  assert.equal(screen.queryByRole("group", { name: "Live app" }) === null, true);
  assert.equal(calls.length, 0, "nothing is read with the flag off");
  cleanup();
  mount(snapshot([], { target: "unavailable", candidates: [] }));
  await until(() => assert.equal(screen.queryByRole("status", { name: "Reading the live app" }) === null, true));
  assert.equal(screen.queryByRole("group", { name: "Live app" }) === null, true);
});

test("no chip when the read fails, as for a Bot's chat or a chat with no folder", async () => {
  mount(() => {
    throw new Error("Design mode needs a workspace folder.");
  });
  await until(() => assert.equal(screen.queryByRole("status", { name: "Reading the live app" }) === null, true));
  assert.equal(screen.queryByRole("group", { name: "Live app" }) === null, true);
});

test("for target none, a Connect chip whose menu has only Connect running server…", async () => {
  mount(snapshot([], { target: "none", candidates: [] }));
  assert.equal((await trigger()).textContent, "Connect");
  assert.deepEqual(menuItems(await openMenu()), ["Connect running server…"]);
});

test("a skeleton chip on the first read only, then the label; a later broadcast updates the same chip", async () => {
  const read = pending<DesignAppsSnapshot>();
  mount(() => read.promise);
  assert.ok(screen.getByRole("status", { name: "Reading the live app" }));
  await act(async () => read.resolve(snapshot([status()])));
  const button = await trigger();
  assert.equal(button.textContent, "Start");
  broadcast(snapshot([RUNNING]));
  await until(() => assert.equal(button.textContent, "Vite · :5173"));
  assert.equal(screen.getByRole("button", { name: /^Live app:/u }) === button, true, "the same element");
  cleanup();
  // Mounted again for the chat (the canvas reopened), the last snapshot shows at once, with no skeleton.
  mount(() => new Promise(() => {}));
  assert.equal(screen.queryByRole("status", { name: "Reading the live app" }) === null, true);
  assert.equal(screen.getByRole("button", { name: /^Live app:/u }).textContent, "Vite · :5173");
});

test("a broadcast for another workspace leaves the chip alone", async () => {
  mount(snapshot([status()]));
  const button = await trigger();
  broadcast({ ...snapshot([RUNNING]), workspaceId: "other" });
  await until(() => undefined);
  assert.equal(button.textContent, "Start");
});

test("a status read and a broadcast that race keep the higher revision of each app", async () => {
  const cases: Array<[string, DesignAppStatus, DesignAppStatus, string]> = [
    ["the broadcast is newer", { ...RUNNING, revision: 5 }, status({ revision: 3 }), "Vite · :5173"],
    ["the read is newer", status({ revision: 2 }), { ...RUNNING, revision: 4 }, "Vite · :5173"],
  ];
  for (const [label, broadcasted, answered, shown] of cases) {
    const read = pending<DesignAppsSnapshot>();
    mount(() => read.promise);
    // The broadcast lands while the read is on its way.
    broadcast(snapshot([broadcasted]));
    await act(async () => read.resolve(snapshot([answered])));
    const button = await trigger();
    await until(() => assert.equal(button.textContent, shown, label));
    cleanup();
    resetDesignAppChipForTests();
  }
});

// ── Labels (D2) ──

test("the label follows the snapshot", async () => {
  const cases: Array<[DesignAppStatus[], string]> = [
    [[RUNNING], "Vite · :5173"],
    [[status({ phase: "starting" })], "Starting…"],
    [[status({ phase: "installing" })], "Installing…"],
    [[status({ phase: "consent" })], "Waiting for approval"],
    [[status({ phase: "crashed", exitCode: 1 })], "Crashed"],
    [[status()], "Start"],
    [[status({ source: "attached", url: "http://localhost:4321" })], "Connect"],
    [[status({ source: "attached" })], "Connect again"],
    [[status({ problem: { problem: "choice-not-saved" } })], "Not running"],
    [[RUNNING, status({ appRoot: "docs" })], "2 apps"],
  ];
  mount(snapshot([status()]));
  const button = await trigger();
  let revision = 100;
  for (const [apps, label] of cases) {
    revision += 1;
    broadcast(snapshot(apps.map((app) => ({ ...app, revision }))));
    await until(() => assert.equal(button.textContent, label));
  }
});

// ── The menu (D3) ──

test("the trigger names the app and its state for screen readers, and Enter opens the menu", async () => {
  mount(snapshot([RUNNING]));
  const button = await trigger();
  assert.equal(button.getAttribute("aria-label"), "Live app: Vite, running at port 5173");
  assert.equal(button.getAttribute("aria-haspopup"), "menu");
  const menu = await openMenu();
  assert.ok(within(menu).getByText("Running at 127.0.0.1:5173"));
});

test("the menu names the workspace's own folder as the workspace folder, never '.'", async () => {
  mount(snapshot([RUNNING]));
  const menu = await openMenu();
  const text = menu.textContent ?? "";
  assert.ok(text.includes("Vite · workspace folder"), text);
  assert.equal(text.includes("Vite · ."), false);
});

test("a running app offers Stop, Restart and Show logs; Show logs opens the drawer for its root", async () => {
  const logs: string[] = [];
  mount(snapshot([RUNNING]), {}, { onShowLogs: (root) => logs.push(root) });
  const menu = await openMenu();
  assert.deepEqual(menuItems(menu), ["Stop", "Restart", "Show logs", "Connect running server…"]);
  await choose(menu, "Show logs");
  // The drawer opens from the menu's onCloseAutoFocus, after the menu has gone (deviation #17).
  await until(() => assert.deepEqual(logs, ["."]));
});

test("a stopped app offers Start; an install failure offers Retry, which calls retry with its root", async () => {
  const calls = mount(snapshot([status()]), { "designApp:retry": () => status({ phase: "starting", revision: 20 }) });
  const first = await openMenu();
  assert.equal(menuItems(first)[0], "Start");
  await closeMenu(first);
  broadcast(snapshot([status({ revision: 11, problem: { problem: "install-failed", exitCode: 1, tail: "npm ERR!" } })]));
  const menu = await openMenu();
  assert.ok(menuItems(menu).includes("Retry"));
  await choose(menu, "Retry");
  const retry = await until(() => {
    const call = calls.find((candidate) => candidate.channel === "designApp:retry");
    assert.ok(call);
    return call;
  });
  assert.deepEqual(retry.args, ["chat-1", "."]);
});

test("Choose apps… is offered when the workspace has more than one web app", async () => {
  mount(
    snapshot([RUNNING], {
      candidates: [
        { appRoot: ".", framework: "vite", frameworkLabel: "Vite", script: "dev" },
        { appRoot: "docs", framework: "astro", frameworkLabel: "Astro", script: "dev" },
      ],
    }),
  );
  const menu = await openMenu();
  assert.ok(menuItems(menu).includes("Choose apps…"));
  await choose(menu, "Choose apps…");
  const sheet = await until(() => screen.getByRole("dialog", { name: "Choose apps" }));
  assert.ok(within(sheet).getByRole("button", { name: "Run docs" }));
});

test("a connected server offers Disconnect only: no Restart, Retry or Show logs", async () => {
  mount(snapshot([status({ ...ATTACHED, origin: "http://[::1]:5173" })]), {}, { onShowLogs: () => undefined });
  const menu = await openMenu();
  assert.ok(within(menu).getByText("Connected to your server at [::1]:5173"));
  assert.deepEqual(menuItems(menu), ["Disconnect", "Connect running server…"]);
});

test("a url root offers Connect, which calls start for it; a disconnected pick offers Connect again, which opens the Connect sheet for its root", async () => {
  const calls = mount(snapshot([status({ appRoot: "docs", source: "attached", url: "http://localhost:4321" })]), {
    "designApp:start": () => status({ appRoot: "docs", source: "attached", phase: "consent", revision: 2 }),
    "designApp:running": () => ({ workspaceId: "ws", ok: true, incomplete: false, servers: [] }),
  });
  await choose(await openMenu(), "Connect");
  const start = await until(() => {
    const call = calls.find((candidate) => candidate.channel === "designApp:start");
    assert.ok(call);
    return call;
  });
  assert.deepEqual(start.args, ["chat-1", "docs"]);
  broadcast(snapshot([status({ appRoot: "web", source: "attached", revision: 50 })]));
  await choose(await openMenu(), "Connect again");
  const sheet = await until(() => screen.getByRole("dialog", { name: "Connect running server" }));
  await until(() => within(sheet).getByText("No server of yours is running for web."));
});

test("a problem shows its fixed message in the menu, never the server's output", async () => {
  mount(snapshot([status({ problem: { problem: "not-ready", tail: "SECRET-LOOKING-TAIL" } })]));
  const menu = await openMenu();
  assert.ok(within(menu).getByText("The app's dev server didn't start listening in time, so Aiden stopped it."));
  assert.ok(menuItems(menu).includes("Retry"));
  assert.equal(document.body.textContent?.includes("SECRET-LOOKING-TAIL"), false);
});

// ── The instant rule (B-M1) ──

test("Start shows Starting… before the invoke answers, and the answer replaces it", async () => {
  const answer = pending<DesignAppStatus>();
  mount(snapshot([status({ revision: 2 })]), { "designApp:start": () => answer.promise });
  const button = await trigger();
  await choose(await openMenu(), "Start");
  assert.equal(button.textContent, "Starting…");
  await act(async () => answer.resolve(status({ phase: "consent", revision: 3 })));
  await until(() => assert.equal(button.textContent, "Waiting for approval"));
});

test("a refusal rolls back and shows the problem in the menu, with no toast", async () => {
  mount(snapshot([status({ revision: 2 })]), {
    "designApp:start": () => status({ revision: 2, problem: { problem: "job-limit" } }),
  });
  const button = await trigger();
  await choose(await openMenu(), "Start");
  await until(() => assert.equal(button.textContent, "Start"));
  const message = "Design mode already runs 8 apps. Stop one, then try again.";
  assert.equal(screen.queryAllByText(message).length, 0, "no toast");
  const menu = await openMenu();
  assert.ok(within(menu).getByText(message));
});

test("a rejected invoke rolls back and shows one toast", async () => {
  mount(snapshot([status({ revision: 2 })]), {
    "designApp:start": () => {
      throw new Error("Live apps are not available.");
    },
  });
  const button = await trigger();
  await choose(await openMenu(), "Start");
  await until(() => screen.getByText("Live apps are not available."));
  assert.equal(button.textContent, "Start");
  assert.equal(screen.getAllByText("Live apps are not available.").length, 1);
});

test("while an action is pending, an equal or older broadcast for its app keeps the optimistic state and a newer one replaces it", async () => {
  mount(snapshot([status({ revision: 5 }), status({ appRoot: "docs", revision: 1 })]), { "designApp:start": () => new Promise(() => {}) });
  await choose(await openMenu(), "Start", 0);
  assert.match(await menuText(), /Starting…/u);
  broadcast(snapshot([status({ revision: 5 }), status({ appRoot: "docs", revision: 2 })]));
  assert.match(await menuText(), /Starting…/u, "an equal revision, and another app's change, leave it");
  broadcast(snapshot([status({ revision: 4 }), status({ appRoot: "docs", revision: 3 })]));
  assert.match(await menuText(), /Starting…/u, "an older revision leaves it");
  broadcast(snapshot([status({ revision: 6, phase: "consent" }), status({ appRoot: "docs", revision: 3 })]));
  const text = await menuText();
  assert.match(text, /Waiting for your approval/u, "a newer revision replaces it");
  assert.doesNotMatch(text, /Starting…/u);
});

// ── Announcements (B-m5) ──

test("the status region says when a running app crashes and when a connected server goes away, and nothing else", async () => {
  mount(snapshot([status()]));
  await trigger();
  const region = () => screen.getByRole("status");
  broadcast(snapshot([status({ phase: "starting", revision: 2 })]));
  broadcast(snapshot([{ ...RUNNING, revision: 3 }]));
  await until(() => undefined);
  assert.equal(region().textContent, "");
  broadcast(snapshot([status({ phase: "crashed", exitCode: 1, revision: 4 })]));
  await until(() => assert.equal(region().textContent, "Vite crashed."));
  broadcast(snapshot([{ ...ATTACHED, revision: 5 }]));
  broadcast(snapshot([status({ source: "attached", revision: 6, problem: { problem: "attach-unreachable" } })]));
  await until(() => assert.equal(region().textContent, "Disconnected from your server at 127.0.0.1:5173."));
});

// ── Keyboard and focus (B-m4) ──

test("Escape closes the menu and focus returns to the chip", async () => {
  mount(snapshot([RUNNING]));
  const button = await trigger();
  await closeMenu(await openMenu());
  await until(() => assert.equal(document.activeElement === button, true, "focus is on the chip"));
});

test("closing the Connect sheet returns focus to the chip", async () => {
  mount(snapshot([RUNNING]), { "designApp:running": () => ({ workspaceId: "ws", ok: true, incomplete: false, servers: [] }) });
  const button = await trigger();
  await choose(await openMenu(), "Connect running server…");
  const sheet = await until(() => screen.getByRole("dialog", { name: "Connect running server" }));
  await until(() => within(sheet).getByText("No server of yours is running in this workspace's folder."));
  await act(async () => {
    fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  });
  await until(() => assert.equal(screen.queryByRole("dialog") === null, true));
  await until(() => assert.equal(document.activeElement === button, true, "focus is on the chip"));
});
