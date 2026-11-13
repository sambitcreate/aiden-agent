// A Bot's Spending section on its Profile: shown once something can cost
// money, and never hidden over a limit it couldn't read.

import "./test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "./test-dom";
import { createBotTestQueryClient } from "./test-providers";
import { BotSpendingSection } from "./bot-spending-section";

afterEach(cleanup);

const FREE = [{ id: "ollama", models: ["llama"], baseUrl: "http://127.0.0.1:11434/v1", hasKey: true }];
const METERED = [{ id: "openai", models: ["fast"], baseUrl: "https://api.openai.com/v1", hasKey: true, credentialType: "api_key" }];

async function mount(options: { providers?: unknown[]; settingsFail?: true; limitFail?: true; choice?: unknown } = {}) {
  installBotTestIpc({
    "settings:get": () => {
      if (options.settingsFail) throw new Error("unreadable");
      return {};
    },
    "providers:list": () => options.providers ?? FREE,
    "spending:status": () => null,
    "spending:botLimit": () => {
      if (options.limitFail) throw new Error("unreadable");
      return options.choice ?? { kind: "default" };
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <BotSpendingSection bot={{ id: "bot-1", name: "Ada" }} />
    </QueryClientProvider>,
  );
}

const section = () => screen.queryByRole("combobox", { name: "Ada’s monthly spending limit" });

test("with only free providers and no limit, the section stays out of the way", async () => {
  await mount();
  // Give every read a chance to land before checking it stayed hidden.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(section(), null);
});

test("a provider that bills by the request, or the Bot's own limit, shows it", async () => {
  await mount({ providers: METERED });
  await waitFor(() => assert.ok(section()));
  cleanup();
  await mount({ choice: { kind: "amount", usd: 5 } });
  await waitFor(() => assert.ok(section()));
});

test("settings or a Bot limit that can't be read show the section rather than hide a limit", async () => {
  await mount({ settingsFail: true });
  await waitFor(() => assert.ok(section()));
  cleanup();
  await mount({ limitFail: true });
  await waitFor(() => assert.ok(section()));
});
