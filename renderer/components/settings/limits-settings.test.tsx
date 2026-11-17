import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { AppSettings } from "../../lib/types";
import { LimitsSettings } from "./limits-settings";

afterEach(cleanup);

type Held = { patch: Partial<AppSettings>; finish(): void; fail(): void };

/** Holds every settings save open until the test finishes or fails it, like a slow disk. */
/** A provider billed by the request: an API key for a hosted endpoint. */
const METERED = { id: "openai", models: ["fast"], baseUrl: "https://api.openai.com/v1", hasKey: true, credentialType: "api_key" };

async function mount(
  settings: Partial<AppSettings> = {},
  options: { hold?: boolean; settingsFail?: boolean; providers?: unknown[] } = {},
) {
  let stored: Partial<AppSettings> = { ...settings };
  const held: Held[] = [];
  const calls = installBotTestIpc({
    "settings:get": () => {
      if (options.settingsFail) throw new Error("unreadable");
      return stored;
    },
    "providers:list": () => options.providers ?? [METERED],
    "settings:set": (value: unknown) => {
      const patch = value as Partial<AppSettings>;
      if (!options.hold) {
        stored = { ...stored, ...patch };
        return stored;
      }
      return new Promise((resolve, reject) => {
        held.push({
          patch,
          finish() {
            stored = { ...stored, ...patch };
            resolve(stored);
          },
          fail: () => reject(new Error("disk full")),
        });
      });
    },
    "settings:setCompactionModelBudget": (modelKey: unknown, budget: unknown) => {
      stored = {
        ...stored,
        compactionModelOverrides: {
          ...stored.compactionModelOverrides,
          [modelKey as string]: budget as { reserveTokens: number },
        },
      };
      return stored;
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <LimitsSettings />
    </QueryClientProvider>,
  );
  // Controls stay disabled until settings have loaded.
  const warming = await screen.findByRole("switch", { name: "Warm prompt caches during active chats" });
  await waitFor(() => assert.equal(warming.hasAttribute("disabled"), false));
  const saves = () => calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  return { calls, held, saves, stored: () => stored };
}

const engineRadio = (name: RegExp) => screen.findByRole("radio", { name });
const warmingSwitch = () => screen.findByRole("switch", { name: "Warm prompt caches during active chats" });

async function chooseOption(trigger: string, option: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: trigger }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

test("the page leads with context settings, then usage and spending limits", async () => {
  await mount();
  await screen.findByRole("radiogroup", { name: "Automatic compaction engine" });
  const titles = ["Automatic compaction", "Prompt cache", "Model compaction budgets", "Usage limits", "Spending limits"];
  const text = document.body.textContent ?? "";
  const positions = titles.map((title) => text.indexOf(title));
  assert.ok(positions.every((position) => position >= 0), `missing a group: ${positions.join(", ")}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("spending limits wait for a provider that bills by the request; a sign-in or a model on this Mac costs nothing", async () => {
  const free = [
    { id: "ollama", models: ["llama"], baseUrl: "http://127.0.0.1:11434/v1", hasKey: true },
    { id: "anthropic", models: ["claude"], baseUrl: "https://api.anthropic.com", hasKey: true, credentialType: "oauth" },
    { id: "groq", models: ["fast"], baseUrl: "https://api.groq.com/openai/v1", hasKey: false },
  ];
  await mount({}, { providers: free });
  await screen.findByText("Nothing here costs money yet");
  assert.equal(screen.queryByRole("combobox", { name: "Spending limit for each chat" }), null);
});

test("a limit already set stays in reach even with no paid provider, so it can be changed or cleared", async () => {
  await mount({ spendingLimits: { botMonthUsd: 10 } }, { providers: [] });
  await screen.findByRole("combobox", { name: "Spending limit for each Bot per month" });
  assert.equal(screen.queryByText("Nothing here costs money yet"), null);
});

test("the page says what compaction may send to the chat model", async () => {
  await mount();
  await screen.findByText(/may be sent to your chat model/u);
});

test("the one-time compaction commands sit in the group's hint", async () => {
  await mount();
  fireEvent.click(await screen.findByRole("button", { name: "About automatic compaction" }));
  const hint = await screen.findByRole("tooltip");
  assert.match(hint.textContent ?? "", /\/compact-LLM or \/compact-VCC/u);
});

test("a group hint explains itself without renaming its heading", async () => {
  await mount();
  await screen.findByRole("heading", { name: "Spending limits" });
  fireEvent.click(screen.getByRole("button", { name: "About spending limits" }));
  const hint = await screen.findByRole("tooltip");
  assert.match(hint.textContent ?? "", /API key requests/u);
});

test("spending limits stay locked when settings can't be read, so a save can't wipe them", async () => {
  await mount({}, { settingsFail: true });
  const trigger = await screen.findByRole("combobox", { name: /chat/iu });
  assert.equal(trigger.hasAttribute("disabled"), true);
});

test("settings that can't be read never claim nothing costs money: the limits show, locked", async () => {
  const free = [{ id: "ollama", models: ["llama"], baseUrl: "http://127.0.0.1:11434/v1", hasKey: true }];
  await mount({}, { settingsFail: true, providers: free });
  const trigger = await screen.findByRole("combobox", { name: "Spending limit for each chat" });
  assert.equal(trigger.hasAttribute("disabled"), true);
  assert.equal(screen.queryByText("Nothing here costs money yet"), null, "a limit set there may be the one not shown");
});

test("a settings read failure says why the limits can't change", async () => {
  await mount({}, { settingsFail: true });
  assert.match((await screen.findByRole("alert")).textContent ?? "", /Couldn’t load your limits/u);
});

test("a second limit change during a slow save waits its turn and keeps both", async () => {
  const { held, stored } = await mount({}, { hold: true });
  await chooseOption("Longest wait for a usage limit", "Up to 1 hour");
  await waitFor(() => assert.equal(held.length, 1));
  assert.equal(screen.getByRole("combobox", { name: /longest wait/iu }).hasAttribute("disabled"), false);

  await chooseOption("Spending limit for each chat", "$5.00");
  assert.equal(held.length, 1);

  held[0]!.finish();
  await waitFor(() => assert.equal(held.length, 2));
  held[1]!.finish();
  await waitFor(() => assert.deepEqual(stored().spendingLimits, { chatUsd: 5 }));
  assert.equal(stored().usageLimitWaitHours, 1);
});

test("a failed limit change puts the page back to what was stored", async () => {
  const { held } = await mount({}, { hold: true });
  const before = (await screen.findByRole("combobox", { name: /longest wait/iu })).textContent;
  await chooseOption("Longest wait for a usage limit", "Up to 1 hour");
  await waitFor(() => assert.equal(held.length, 1));
  assert.match(screen.getByRole("combobox", { name: /longest wait/iu }).textContent ?? "", /Up to 1 hour/u);
  held[0]!.fail();
  await waitFor(() =>
    assert.equal(screen.getByRole("combobox", { name: /longest wait/iu }).textContent, before),
  );
});

test("choosing an engine saves only that choice", async () => {
  const { saves } = await mount({ compactionEngine: "llm" });
  const local = await engineRadio(/pi-vcc Compaction/u);
  fireEvent.click(local);
  await waitFor(() => assert.deepEqual(saves(), [{ compactionEngine: "vcc" }]));
  await waitFor(() => assert.equal(local.getAttribute("aria-checked"), "true"));
});

test("cache warming can change while an engine save is still running, and both are kept", async () => {
  const { held, stored } = await mount({ compactionEngine: "llm", cacheWarmingEnabled: false }, { hold: true });
  fireEvent.click(await engineRadio(/pi-vcc Compaction/u));
  await waitFor(() => assert.equal(held.length, 1));

  const warming = await warmingSwitch();
  fireEvent.click(warming);
  await waitFor(() => assert.equal(held.length, 2));
  assert.deepEqual(held.map((save) => save.patch), [{ compactionEngine: "vcc" }, { cacheWarmingEnabled: true }]);

  await act(async () => {
    held[0]?.finish();
    held[1]?.finish();
  });
  await waitFor(() => assert.equal(warming.getAttribute("aria-checked"), "true"));
  assert.equal((await engineRadio(/pi-vcc Compaction/u)).getAttribute("aria-checked"), "true");
  assert.equal(stored().compactionEngine, "vcc");
  assert.equal(stored().cacheWarmingEnabled, true);
});

test("a usage limit can change while an engine save is still running", async () => {
  const { held } = await mount({ compactionEngine: "llm" }, { hold: true });
  fireEvent.click(await engineRadio(/pi-vcc Compaction/u));
  await waitFor(() => assert.equal(held.length, 1));

  await chooseOption("Longest wait for a usage limit", "Up to 24 hours");
  await waitFor(() => assert.equal(held.length, 2));
  assert.deepEqual(held[1]?.patch, { usageLimitWaitHours: 24 });
});

test("a failed limit save puts back the limit without undoing an engine saved meanwhile", async () => {
  const { held } = await mount({ compactionEngine: "llm", usageLimitWaitHours: 1 }, { hold: true });
  await chooseOption("Longest wait for a usage limit", "Up to 24 hours");
  await waitFor(() => assert.equal(held.length, 1));

  const local = await engineRadio(/pi-vcc Compaction/u);
  fireEvent.click(local);
  await waitFor(() => assert.equal(held.length, 2));
  await act(async () => held[1]?.finish());
  await waitFor(() => assert.equal(local.getAttribute("aria-checked"), "true"));

  await act(async () => held[0]?.fail());
  await waitFor(() =>
    assert.match(screen.getByRole("combobox", { name: "Longest wait for a usage limit" }).textContent ?? "", /Up to 1 hour/u),
  );
  assert.equal(local.getAttribute("aria-checked"), "true");
});

test("a model budget saves through its own call, without touching other settings", async () => {
  const { calls, saves } = await mount();
  fireEvent.change(await screen.findByLabelText("Model for compaction budget"), { target: { value: "local/fast" } });
  fireEvent.change(screen.getByLabelText("Compaction reserved tokens"), { target: { value: "5000" } });
  fireEvent.click(screen.getByRole("button", { name: "Save budget" }));
  await waitFor(() =>
    assert.deepEqual(calls.find((call) => call.channel === "settings:setCompactionModelBudget")?.args, [
      "local/fast",
      { reserveTokens: 5000 },
    ]),
  );
  assert.deepEqual(saves(), []);
});
