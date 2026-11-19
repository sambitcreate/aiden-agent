import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import type { Provider } from "../../lib/types";
import { TooltipProvider } from "../ui";
import { ProviderEditor } from "./provider-editor";

afterEach(cleanup);

const PROVIDER = {
  id: "custom-lab",
  kind: "openai",
  label: "Lab server",
  baseUrl: "http://127.0.0.1:8080/v1",
  models: ["small", "large"],
  defaultModel: "large",
  needsKey: true,
  hasKey: false,
} as Provider;

function mount() {
  installBotTestIpc({
    "settings:get": () => ({}),
    "models:info": () => ({}),
  });
  render(
    <TooltipProvider>
      <QueryClientProvider client={createBotTestQueryClient()}>
        <ProviderEditor provider={PROVIDER} open onOpenChange={() => undefined} onSaved={() => undefined} />
      </QueryClientProvider>
    </TooltipProvider>,
  );
  return screen.findByRole("dialog");
}

test("every connection control is named by its row, so it can be found and read on its own", async () => {
  const dialog = await mount();
  assert.equal((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value, "Lab server");
  assert.equal((within(dialog).getByRole("textbox", { name: "Base URL" }) as HTMLInputElement).value, "http://127.0.0.1:8080/v1");
  assert.match(within(dialog).getByRole("combobox", { name: "Authentication" }).textContent ?? "", /API key/u);
  // A password field has no textbox role: find the input the label names.
  assert.ok(within(dialog).getAllByLabelText("API key").some((element) => element instanceof HTMLInputElement && element.type === "password"));
  assert.match((await within(dialog).findByRole("combobox", { name: "Default model" })).textContent ?? "", /large/iu);
  assert.match(within(dialog).getByRole("combobox", { name: "API format" }).textContent ?? "", /OpenAI-compatible/u);
  assert.match(within(dialog).getByRole("combobox", { name: "Deployment" }).textContent ?? "", /Local/u);
});
