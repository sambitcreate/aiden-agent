import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { LinksSettings } from "./links-settings";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
/** The newest entry. Equivalent to `.at(-1)`, which the ES2021 lib lacks. */
const last = <T,>(items: readonly T[]): T | undefined => items[items.length - 1];

test("shows the saved preference and saves a new one", async () => {
  const calls = installBotTestIpc({
    "browser:link-preference": () => "external",
    "browser:set-link-preference": (value) => value,
  });
  render(<LinksSettings />);
  await flush();
  const trigger = screen.getByRole("combobox", { name: "Open links in" });
  assert.match(trigger.textContent ?? "", /System browser/);
  assert.ok(screen.getByText(/local dev servers always open in Aiden/i));
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: "Ask each time" }));
  await flush();
  assert.deepEqual(last(calls), { channel: "browser:set-link-preference", args: ["ask"] });
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Ask each time/);
});

test("a link-preference broadcast updates the shown choice without a reload", async () => {
  installBotTestIpc({
    "browser:link-preference": () => "ask",
    "browser:set-link-preference": (value) => value,
  });
  render(<LinksSettings />);
  await flush();
  emitBotTestNotification("browser:event", { type: "link-preference", linkOpening: "external" });
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /System browser/);
});

test("a failed save restores the previous choice", async () => {
  installBotTestIpc({
    "browser:link-preference": () => "browser",
    "browser:set-link-preference": () => {
      throw new Error("disk full");
    },
  });
  render(<LinksSettings />);
  await flush();
  fireEvent.click(screen.getByRole("combobox", { name: "Open links in" }));
  fireEvent.click(await screen.findByRole("option", { name: "System browser" }));
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open links in" }).textContent ?? "", /Aiden browser/);
});

test("embedded chat link control follows a newer broadcast while its first read is pending", async () => {
  let finish!: (value: string) => void;
  installBotTestIpc({ "browser:link-preference": () => new Promise<string>((resolve) => { finish = resolve; }) });
  render(<LinksSettings embedded />);
  emitBotTestNotification("browser:event", { type: "link-preference", linkOpening: "external" });
  await flush();
  finish("ask");
  await flush();
  assert.match(screen.getByRole("combobox", { name: "Open chat links in" }).textContent ?? "", /System browser/u);
});
