import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { LinkOpenerProvider, useBrowserSurface, useBrowserSurfaceBlocker, useLinkOpener } from "./link-opener";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function Surface({ active = true }: { active?: boolean }) {
  useBrowserSurface(active);
  return null;
}

function Blocker({ active = true }: { active?: boolean }) {
  useBrowserSurfaceBlocker(active);
  return null;
}

function app({ surface = true, href = "https://example.com/", blocked = false } = {}) {
  return (
    <LinkOpenerProvider workspaceId="ws-1">
      {surface ? <Surface /> : null}
      {blocked ? <Blocker /> : null}
      <a href={href}>link</a>
      <a href="https://accounts.example.com/" data-link-target="external">sign in</a>
      <a href="/settings">route</a>
      <a href="mailto:a@example.com">mail</a>
    </LinkOpenerProvider>
  );
}

function ipc(preference: string, overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  return installBotTestIpc({
    "browser:link-preference": () => preference,
    "browser:set-link-preference": (value) => value,
    "browser:open-external": () => undefined,
    "browser:command": () => ({ tabId: "tab-1" }),
    ...overrides,
  });
}
const sent = (calls: { channel: string; args: unknown[] }[]) =>
  calls.filter((call) => call.channel !== "browser:link-preference");

function Outside({ href, onResult }: { href: string; onResult: (handled: boolean) => void }) {
  const { openLink } = useLinkOpener();
  return <button onClick={() => onResult(openLink(href))}>run</button>;
}

test("first click asks; remembered Aiden choice is saved and opens in the panel", async () => {
  const calls = ipc("ask");
  render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  fireEvent.click(await screen.findByRole("button", { name: "Open in Aiden browser" }));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:set-link-preference", args: ["browser"] },
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);
  // The saved choice applies to the next click with no prompt, and actually opens.
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(sent(calls), [
    { channel: "browser:set-link-preference", args: ["browser"] },
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);
});

test("without a browser surface (Settings, Bots) links go out with no prompt and no tab", async () => {
  const calls = ipc("browser");
  render(app({ surface: false }));
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/"] }]);
});

test("a failed in-app open falls back to the system browser", async () => {
  const calls = ipc("browser", { "browser:command": () => { throw new Error("Close a browser tab before opening more than 24."); } });
  render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls).map((call) => call.channel), ["browser:command", "browser:open-external"]);
});

test("loopback opens in Aiden even when the preference is external; auth links go out", async () => {
  const calls = ipc("external");
  render(app({ href: "http://localhost:5173/" }));
  await flush();
  fireEvent.click(screen.getByText("link"));
  fireEvent.click(screen.getByText("sign in"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "http://localhost:5173/" }] },
    { channel: "browser:open-external", args: ["https://accounts.example.com/"] },
  ]);
});

test("app routes and modified clicks are left alone", async () => {
  const calls = ipc("browser");
  render(app());
  await flush();
  for (const init of [{ altKey: true }, { shiftKey: true }, { button: 1 }])
    fireEvent.click(screen.getByText("link"), init);
  const route = new MouseEvent("click", { bubbles: true, cancelable: true });
  screen.getByText("route").dispatchEvent(route);
  await flush();
  assert.equal(route.defaultPrevented, false);
  assert.deepEqual(sent(calls), []);
});

test("right-click offers both destinations and copy", async () => {
  const calls = ipc("ask");
  render(app());
  await flush();
  fireEvent.contextMenu(screen.getByText("link"));
  const item = await screen.findByRole("menuitem", { name: "Open in system browser" });
  assert.ok(screen.getByRole("menuitem", { name: "Open in Aiden browser" }));
  assert.ok(screen.getByRole("menuitem", { name: "Copy link" }));
  fireEvent.click(item);
  await flush();
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/"] }]);
});

test("a link with a registered surface still goes external with no prompt while a blocker (onboarding) is active", async () => {
  const calls = ipc("ask");
  render(app({ blocked: true }));
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/"] }]);
});

test("deactivating the browser surface sends later links out with no prompt", async () => {
  const calls = ipc("browser");
  const { rerender } = render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);

  rerender(
    <LinkOpenerProvider workspaceId="ws-1">
      <Surface active={false} />
      <a href="https://example.com/">link</a>
    </LinkOpenerProvider>,
  );
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
    { channel: "browser:open-external", args: ["https://example.com/"] },
  ]);
});

test("unmounting the only registered surface sends later links out with no prompt", async () => {
  const calls = ipc("browser");
  const { rerender } = render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);

  rerender(
    <LinkOpenerProvider workspaceId="ws-1">
      <a href="https://example.com/">link</a>
    </LinkOpenerProvider>,
  );
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
    { channel: "browser:open-external", args: ["https://example.com/"] },
  ]);
});

test("with two registered surfaces, one unmounting leaves the panel available", async () => {
  const calls = ipc("browser");
  const { rerender } = render(
    <LinkOpenerProvider workspaceId="ws-1">
      <Surface />
      <Surface />
      <a href="https://example.com/">link</a>
    </LinkOpenerProvider>,
  );
  await flush();

  rerender(
    <LinkOpenerProvider workspaceId="ws-1">
      <Surface />
      <a href="https://example.com/">link</a>
    </LinkOpenerProvider>,
  );
  await flush();
  fireEvent.click(screen.getByText("link"));
  await flush();
  // Still one surface registered, so the panel is still used, not the system browser.
  assert.deepEqual(sent(calls), [
    { channel: "browser:command", args: ["ws-1", { action: "open_link", url: "https://example.com/" }] },
  ]);
});

test("useLinkOpener outside the provider sends http(s) and mailto out, and leaves other hrefs alone", async () => {
  async function run(href: string) {
    const calls = ipc("ask");
    let handled: boolean | null = null;
    render(<Outside href={href} onResult={(value) => (handled = value)} />);
    fireEvent.click(screen.getByText("run"));
    await flush();
    const result = { handled, calls: sent(calls) };
    cleanup();
    return result;
  }

  const http = await run("https://example.com/");
  assert.equal(http.handled, true);
  assert.deepEqual(http.calls, [{ channel: "browser:open-external", args: ["https://example.com/"] }]);

  const mail = await run("mailto:a@example.com");
  assert.equal(mail.handled, true);
  assert.deepEqual(mail.calls, [{ channel: "browser:open-external", args: ["mailto:a@example.com"] }]);

  const route = await run("/settings");
  assert.equal(route.handled, false);
  assert.deepEqual(route.calls, []);
});

test("Cancel on the dialog opens nothing", async () => {
  const calls = ipc("ask");
  render(app());
  await flush();
  fireEvent.click(screen.getByText("link"));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
  assert.deepEqual(sent(calls), []);
  void dialog;
});

test("right-click: the Aiden item is disabled with no surface, and absent for mailto", async () => {
  const calls = ipc("ask");
  render(app({ surface: false }));
  await flush();
  fireEvent.contextMenu(screen.getByText("link"));
  const aidenItem = await screen.findByRole("menuitem", { name: "Open in Aiden browser" });
  assert.equal(aidenItem.getAttribute("aria-disabled"), "true");
  fireEvent.keyDown(aidenItem.ownerDocument.body, { key: "Escape" });
  await flush();

  fireEvent.contextMenu(screen.getByText("mail"));
  await screen.findByRole("menuitem", { name: "Open in system browser" });
  assert.equal(screen.queryByRole("menuitem", { name: "Open in Aiden browser" }), null);
  assert.deepEqual(sent(calls), []);
});

test("openLink with forcePrompt asks even when a preference is saved, without remember", async () => {
  const calls = ipc("browser");
  function Caller() {
    const { openLink } = useLinkOpener();
    return <button onClick={() => openLink("https://example.com/x", { forcePrompt: true })}>visual</button>;
  }
  render(
    <LinkOpenerProvider workspaceId="ws-1">
      <Surface />
      <Caller />
    </LinkOpenerProvider>,
  );
  await flush();
  fireEvent.click(screen.getByText("visual"));
  await screen.findByRole("dialog", { name: "Open this link?" });
  assert.equal(screen.queryByRole("checkbox"), null);
  fireEvent.click(screen.getByRole("button", { name: "Open in system browser" }));
  await flush();
  assert.deepEqual(sent(calls), [{ channel: "browser:open-external", args: ["https://example.com/x"] }]);
});
