import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { installBotTestIpc } from "../main/bots/test-dom";
import { LinkOpenerProvider, useBrowserSurface } from "./link-opener";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

function Surface() {
  useBrowserSurface(true);
  return null;
}

function app({ surface = true, href = "https://example.com/" } = {}) {
  return (
    <LinkOpenerProvider workspaceId="ws-1">
      {surface ? <Surface /> : null}
      <a href={href}>link</a>
      <a href="https://accounts.example.com/" data-link-target="external">sign in</a>
      <a href="/settings">route</a>
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
  // The saved choice applies to the next click with no prompt.
  fireEvent.click(screen.getByText("link"));
  await flush();
  assert.equal(screen.queryByRole("dialog"), null);
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
