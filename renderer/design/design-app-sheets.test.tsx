// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DesignAppRunningScan, DesignAppRunningServer, DesignAppsSnapshot, DesignAppStatus } from "../shared/design-app";
import { DesignAppChooseSheet, DesignAppConnectSheet } from "./design-app-sheets";

afterEach(cleanup);

function status(overrides: Partial<DesignAppStatus> = {}): DesignAppStatus {
  return { workspaceId: "ws", appRoot: ".", source: "started", frameworkLabel: "Vite", phase: "stopped", since: 1, revision: 1, ...overrides };
}

function server(overrides: Partial<DesignAppRunningServer> = {}): DesignAppRunningServer {
  return {
    port: 5173,
    pid: 300,
    origin: "http://127.0.0.1:5173",
    appRoot: "apps/web",
    folder: "apps/web",
    processName: "vite",
    connectable: true,
    ...overrides,
  };
}

function scanOf(servers: DesignAppRunningServer[], extra: Partial<DesignAppRunningScan> = {}): DesignAppRunningScan {
  return { workspaceId: "ws", ok: true, incomplete: false, servers, ...extra };
}

/** A promise the test settles by hand. */
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// ── Choose apps ──

const CHOOSE_SNAPSHOT: DesignAppsSnapshot = {
  workspaceId: "ws",
  target: "choose",
  apps: [status({ appRoot: "apps/admin", phase: "running", origin: "http://127.0.0.1:5174", port: 5174 })],
  candidates: [
    { appRoot: "apps/web", framework: "vite", frameworkLabel: "Vite", script: "dev", name: "@acme/web" },
    { appRoot: "apps/admin", framework: "next", frameworkLabel: "Next.js", script: "dev", name: "@acme/admin" },
  ],
  chosen: [],
};

function ChooseHarness({ onClose = () => undefined }: { onClose?: () => void }) {
  const [open, setOpen] = React.useState(true);
  return (
    <DesignAppChooseSheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      chatId="chat-1"
      snapshot={CHOOSE_SNAPSHOT}
      onOutcome={() => undefined}
    />
  );
}

test("Choose lists each candidate with its label, escaped root, package and script, as buttons with no radio cards", async () => {
  installBotTestIpc();
  render(<ChooseHarness />);
  const dialog = await screen.findByRole("dialog", { name: "Choose apps" });
  const text = dialog.textContent ?? "";
  for (const expected of ["Vite · apps/web", "@acme/web", "runs dev", "Next.js · apps/admin", "@acme/admin"]) assert.ok(text.includes(expected), expected);
  assert.equal(within(dialog).queryAllByRole("radio").length, 0);
  assert.equal(within(dialog).queryAllByRole("radiogroup").length, 0);
  assert.ok(within(dialog).getByRole("button", { name: "Run apps/web" }));
});

test("Run calls choose for that root and closes the sheet", async () => {
  const calls = installBotTestIpc({ "designApp:choose": () => status({ appRoot: "apps/web", phase: "consent" }) });
  let closed = 0;
  render(<ChooseHarness onClose={() => (closed += 1)} />);
  fireEvent.click(await screen.findByRole("button", { name: "Run apps/web" }));
  await waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designApp:choose").map((call) => call.args),
    [["chat-1", "apps/web"]],
  );
});

test("a running root's Run is disabled", async () => {
  installBotTestIpc();
  render(<ChooseHarness />);
  const button = await screen.findByRole("button", { name: "apps/admin is running" });
  assert.equal((button as HTMLButtonElement).disabled, true);
});

// ── Connect running server ──

function ConnectHarness({
  filterRoot,
  returnFocus,
  onClose = () => undefined,
}: {
  filterRoot?: string;
  returnFocus?: () => HTMLElement | null;
  onClose?: () => void;
}) {
  const [open, setOpen] = React.useState(true);
  return (
    <DesignAppConnectSheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onClose();
      }}
      chatId="chat-1"
      {...(filterRoot !== undefined ? { filterRoot } : {})}
      {...(returnFocus ? { returnFocus } : {})}
    />
  );
}

const dialog = () => screen.findByRole("dialog", { name: "Connect running server" });

test("opening scans once and shows two skeleton rows until the scan answers", async () => {
  const answer = pending<DesignAppRunningScan>();
  const calls = installBotTestIpc({ "designApp:running": () => answer.promise });
  render(<ConnectHarness />);
  const loading = await screen.findByRole("status", { name: "Reading running servers" });
  assert.equal(loading.children.length, 3, "two rows and the separator between them");
  await act(async () => answer.resolve(scanOf([server()])));
  assert.ok(await screen.findByText("127.0.0.1:5173"));
  assert.equal(screen.queryByRole("status", { name: "Reading running servers" }), null);
  assert.equal(calls.filter((call) => call.channel === "designApp:running").length, 1);
  assert.deepEqual(calls.find((call) => call.channel === "designApp:running")!.args, ["chat-1"]);
});

test("rows show the address, process, folder and app root, and Connect calls connect with that port and pid", async () => {
  const calls = installBotTestIpc({
    "designApp:running": () => scanOf([server(), server({ port: 4321, pid: 410, origin: "http://[::1]:4321", appRoot: "docs", folder: "docs/site", processName: "astro" })]),
    "designApp:connect": () => status({ appRoot: "docs", source: "attached", phase: "running", origin: "http://[::1]:4321", port: 4321 }),
  });
  let closed = 0;
  render(<ConnectHarness onClose={() => (closed += 1)} />);
  const shown = await dialog();
  await within(shown).findByText("[::1]:4321");
  const text = shown.textContent ?? "";
  for (const expected of ["127.0.0.1:5173", "vite · apps/web", "App apps/web", "astro · docs/site", "App docs"]) assert.ok(text.includes(expected), expected);
  fireEvent.click(within(shown).getByRole("button", { name: "Connect to [::1]:4321" }));
  await waitFor(() => assert.equal(closed, 1));
  assert.deepEqual(
    calls.filter((call) => call.channel === "designApp:connect").map((call) => call.args),
    [["chat-1", { port: 4321, pid: 410 }]],
  );
});

test("a row from the workspace's own folder says workspace folder, never '.'", async () => {
  installBotTestIpc({ "designApp:running": () => scanOf([server({ appRoot: ".", folder: "." })]) });
  render(<ConnectHarness />);
  const shown = await dialog();
  await within(shown).findByText("127.0.0.1:5173");
  const text = shown.textContent ?? "";
  assert.ok(text.includes("vite · workspace folder"), text);
  assert.ok(text.includes("App workspace folder"), text);
  assert.equal(/· \.|App \./u.test(text), false);
});

test("rows that can't connect are disabled and say why: beyond this computer with the fix, another address, another user, already running", async () => {
  installBotTestIpc({
    "designApp:running": () =>
      scanOf([
        server({ port: 3000, pid: 1, origin: undefined, connectable: false, why: "beyond-loopback" }),
        server({ port: 3001, pid: 2, origin: undefined, connectable: false, why: "other-address" }),
        server({ port: 3002, pid: 3, origin: undefined, connectable: false, why: "other-user" }),
        server({ port: 3003, pid: 4, connectable: false, why: "already-running", origin: "http://127.0.0.1:3003" }),
      ]),
  });
  render(<ConnectHarness />);
  const shown = await dialog();
  const expectations: Array<[string, RegExp]> = [
    [":3000", /listens beyond this computer\. Restart it bound to 127\.0\.0\.1/u],
    [":3001", /another loopback address/u],
    [":3002", /runs as another user/u],
    ["127.0.0.1:3003", /Aiden already runs this app/u],
  ];
  for (const [address, why] of expectations) {
    const button = await within(shown).findByRole("button", { name: `Connect to ${address}` });
    assert.equal((button as HTMLButtonElement).disabled, true, address);
    const reason = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    assert.match(reason?.textContent ?? "", why, address);
  }
});

test("a failed connect shows its fixed message under the row and keeps the sheet open", async () => {
  installBotTestIpc({
    "designApp:running": () => scanOf([server()]),
    "designApp:connect": () => status({ appRoot: "apps/web", phase: "stopped", problem: { problem: "attach-not-loopback" } }),
  });
  render(<ConnectHarness />);
  const shown = await dialog();
  fireEvent.click(await within(shown).findByRole("button", { name: "Connect to 127.0.0.1:5173" }));
  const alert = await within(shown).findByRole("alert");
  assert.match(alert.textContent ?? "", /connects only to a server that listens on this computer alone/u);
  assert.equal(shown.isConnected, true, "the sheet stays open");
});

test("a rejected connect shows the error under the row and keeps the sheet open", async () => {
  installBotTestIpc({
    "designApp:running": () => scanOf([server()]),
    "designApp:connect": () => {
      throw new Error("Live apps are not available.");
    },
  });
  render(<ConnectHarness />);
  const shown = await dialog();
  fireEvent.click(await within(shown).findByRole("button", { name: "Connect to 127.0.0.1:5173" }));
  assert.match((await within(shown).findByRole("alert")).textContent ?? "", /not available/u);
});

test("a successful connect closes the sheet and returns focus through returnFocus", async () => {
  installBotTestIpc({
    "designApp:running": () => scanOf([server()]),
    "designApp:connect": () => status({ appRoot: "apps/web", source: "attached", phase: "running", origin: "http://127.0.0.1:5173", port: 5173 }),
  });
  const chip = document.createElement("button");
  chip.textContent = "Live app";
  document.body.append(chip);
  let asked = 0;
  let closed = 0;
  render(
    <ConnectHarness
      onClose={() => (closed += 1)}
      returnFocus={() => {
        asked += 1;
        return chip;
      }}
    />,
  );
  fireEvent.click(await within(await dialog()).findByRole("button", { name: "Connect to 127.0.0.1:5173" }));
  await waitFor(() => assert.equal(closed, 1));
  await waitFor(() => assert.ok(asked > 0));
  await waitFor(() => assert.equal(document.activeElement, chip));
  chip.remove();
});

test("a connect still pending when the sheet closes and opens again neither closes the new sheet nor writes its failure there", async () => {
  for (const ending of ["fails", "succeeds"] as const) {
    const answer = pending<DesignAppStatus>();
    installBotTestIpc({ "designApp:running": () => scanOf([server()]), "designApp:connect": () => answer.promise });
    let setOpen: (open: boolean) => void = () => undefined;
    let closes = 0;
    function Toggle() {
      const [open, set] = React.useState(true);
      setOpen = set;
      return (
        <DesignAppConnectSheet
          open={open}
          onOpenChange={(next) => {
            set(next);
            if (!next) closes += 1;
          }}
          chatId="chat-1"
        />
      );
    }
    render(<Toggle />);
    fireEvent.click(await within(await dialog()).findByRole("button", { name: "Connect to 127.0.0.1:5173" }));
    act(() => setOpen(false));
    await waitFor(() => assert.equal(screen.queryByRole("dialog", { name: "Connect running server" }) === null, true));
    act(() => setOpen(true));
    const reopened = await dialog();
    await within(reopened).findByRole("button", { name: "Connect to 127.0.0.1:5173" });
    await act(async () =>
      answer.resolve(
        ending === "fails"
          ? status({ appRoot: "apps/web", phase: "stopped", problem: { problem: "attach-not-loopback" } })
          : status({ appRoot: "apps/web", source: "attached", phase: "running", origin: "http://127.0.0.1:5173", port: 5173 }),
      ),
    );
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    assert.equal(within(reopened).queryAllByRole("alert").length, 0, `${ending}: no failure in the new sheet`);
    assert.equal(closes, 0, `${ending}: the new sheet stays open`);
    assert.equal(reopened.isConnected, true, ending);
    const button = within(reopened).getByRole("button", { name: "Connect to 127.0.0.1:5173" }) as HTMLButtonElement;
    assert.equal(button.disabled, false, `${ending}: its rows can connect`);
    cleanup();
  }
});

test("an incomplete scan says some servers may be missing", async () => {
  installBotTestIpc({ "designApp:running": () => scanOf([server()], { incomplete: true }) });
  render(<ConnectHarness />);
  assert.ok(await within(await dialog()).findByText("Some servers may be missing."));
});

test("empty and failed scans say so and offer Refresh, which scans again", async () => {
  let answers: Array<() => DesignAppRunningScan> = [
    () => scanOf([]),
    () => ({ workspaceId: "ws", ok: false, incomplete: false, servers: [] }),
    () => scanOf([server()]),
  ];
  const calls = installBotTestIpc({
    "designApp:running": () => {
      const [next, ...rest] = answers;
      answers = rest;
      return next!();
    },
  });
  render(<ConnectHarness />);
  const shown = await dialog();
  assert.ok(await within(shown).findByText("No server of yours is running in this workspace's folder."));
  fireEvent.click(within(shown).getByRole("button", { name: "Refresh" }));
  assert.ok(await within(shown).findByText("Aiden couldn't read the running servers."));
  fireEvent.click(within(shown).getByRole("button", { name: "Refresh" }));
  assert.ok(await within(shown).findByText("127.0.0.1:5173"));
  assert.equal(calls.filter((call) => call.channel === "designApp:running").length, 3);
});

test("with filterRoot only that root's rows show, with a way to show all", async () => {
  installBotTestIpc({
    "designApp:running": () => scanOf([server(), server({ port: 4321, pid: 410, origin: "http://127.0.0.1:4321", appRoot: "docs", folder: "docs" })]),
  });
  render(<ConnectHarness filterRoot="docs" />);
  const shown = await dialog();
  await within(shown).findByText("127.0.0.1:4321");
  assert.equal(within(shown).queryByText("127.0.0.1:5173"), null);
  fireEvent.click(within(shown).getByRole("button", { name: "Show all servers" }));
  assert.ok(await within(shown).findByText("127.0.0.1:5173"));
});

test("process names, folders and app roots with a bidi override show escapes, not the character", async () => {
  installBotTestIpc({
    "designApp:running": () => scanOf([server({ processName: "vi‮te", folder: "apps/⁦web", appRoot: "apps/​web" })]),
  });
  render(<ConnectHarness />);
  const shown = await dialog();
  await within(shown).findByText("127.0.0.1:5173");
  const text = shown.textContent ?? "";
  for (const hidden of ["‮", "⁦", "​"]) assert.equal(text.includes(hidden), false);
  for (const escape of ["vi\\u{202E}te", "apps/\\u{2066}web", "apps/\\u{200B}web"]) assert.ok(text.includes(escape), escape);
});
