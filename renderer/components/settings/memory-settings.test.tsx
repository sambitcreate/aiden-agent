import "../../main/bots/test-dom";
import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings, Workspace } from "../../lib/types";
import { CompactionBudgetSettings } from "./compaction-budget-settings.js";
import { MemorySettings } from "./memory-settings";

afterEach(cleanup);

function mount(settings: Partial<AppSettings> = {}) {
  let stored: Partial<AppSettings> = { ...settings };
  const workspace = { id: "w1", name: "Notes", memoryEnabled: true } as Workspace;
  const calls = installBotTestIpc({
    "settings:get": () => stored,
    "settings:set": (patch: unknown) => {
      stored = { ...stored, ...(patch as Partial<AppSettings>) };
      return stored;
    },
    "workspaces:list": () => [workspace],
    "workspaces:memoryFacts": () => [],
    "workspaces:update": (_id: unknown, patch: unknown) => ({ ...workspace, ...(patch as Partial<Workspace>) }),
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <MemorySettings />
    </QueryClientProvider>,
  );
  return calls;
}

test("the global switch saves memoryEnabled and leaves workspace switches as stored preferences", async () => {
  const calls = mount();
  const global = await screen.findByRole("switch", { name: "Use memory globally" });
  await waitFor(() => assert.equal(global.getAttribute("aria-checked"), "true"));
  const workspace = await screen.findByRole("switch", { name: "Use memory in Notes" });
  fireEvent.click(global);
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "settings:set")?.args, [{ memoryEnabled: false }]),
  );
  await waitFor(() => assert.equal(workspace.hasAttribute("disabled"), true));
  assert.equal(workspace.getAttribute("aria-checked"), "true");
});

test("a workspace switch updates that workspace alone", async () => {
  const calls = mount();
  const workspace = await screen.findByRole("switch", { name: "Use memory in Notes" });
  await waitFor(() => assert.equal(workspace.hasAttribute("disabled"), false));
  fireEvent.click(workspace);
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "workspaces:update")?.args, ["w1", { memoryEnabled: false }]),
  );
  await waitFor(() => assert.equal(workspace.getAttribute("aria-checked"), "false"));
  assert.equal(calls.some((call) => call.channel === "settings:set"), false);
});

test("Memory says what its switches keep, and leaves compaction to Context & Limits", async () => {
  mount();
  await screen.findByRole("switch", { name: "Use memory globally" });
  const text = document.body.textContent ?? "";
  assert.match(text, /Existing approved\s+facts stay on this device/u);
  assert.match(text, /Bot memory has its own scope/u);
  assert.equal(screen.queryByRole("radiogroup", { name: "Automatic compaction engine" }), null);
  assert.equal(screen.queryByRole("switch", { name: "Warm prompt caches during active chats" }), null);
  assert.doesNotMatch(text, /Model compaction budgets/u);
});

test("model budget controls expose exact model suggestions, token limits and reset", () => {
  const html = renderToStaticMarkup(CompactionBudgetSettingsElement());
  assert.match(html, /Model compaction budgets/u);
  assert.match(html, /aria-label="Compaction reserved tokens"/u);
  assert.match(html, /min="2"/u);
  assert.match(html, /aria-label="Compaction recent tokens"/u);
  assert.match(html, /min="0"/u);
  assert.match(html, /provider\/saved-model/u);
  assert.match(html, /provider\/new-model/u);
  assert.match(html, /Reset model/u);
});

function CompactionBudgetSettingsElement() {
  return <CompactionBudgetSettings overrides={{ "provider/saved-model": { reserveTokens: 5_000 } }} modelKeys={["provider/new-model"]} disabled={false} onSave={async () => { throw new Error("Rendering must not save settings"); }} />;
}
