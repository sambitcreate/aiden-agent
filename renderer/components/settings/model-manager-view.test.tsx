import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { emitBotTestNotification, installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { ModelManagerView } from "./model-manager-view";
import { localModelsTestCatalog } from "./local-models-test-catalog";

afterEach(cleanup);

const catalog = localModelsTestCatalog();

function mount(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls = installBotTestIpc({
    "settings:get": () => ({}),
    "localModels:list": () => catalog,
    ...handlers,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <ModelManagerView onBack={() => undefined} />
    </QueryClientProvider>,
  );
  return calls;
}

function card(name: string): Promise<HTMLElement> {
  return screen.findByRole("group", { name });
}

test("each model row lists its languages and download size", async () => {
  mount();
  const senseVoice = await card("SenseVoice Small");
  assert.ok(within(senseVoice).getByText(/Chinese, Cantonese, English, Japanese, Korean/));
  const v3 = await card("Parakeet TDT 0.6B v3");
  assert.ok(within(v3).getByText(/487 MB/));
});

test("capability chips show auto-detection and translation", async () => {
  mount();
  const canary = await card("Canary 180M Flash");
  assert.ok(within(canary).getByText("Translate", { exact: true }));
  assert.equal(within(canary).queryByText("Auto-detect", { exact: true }), null);
  const v3 = await card("Parakeet TDT 0.6B v3");
  assert.ok(within(v3).getByText("Auto-detect", { exact: true }));
  assert.equal(within(v3).queryByText("Translate", { exact: true }), null);
});

test("every row credits its licence, with attribution when required", async () => {
  mount();
  for (const model of catalog) {
    const row = await card(model.name);
    assert.ok(within(row).getByText(/^License: /), `${model.name} licence line`);
  }
  const senseVoice = await card("SenseVoice Small");
  assert.ok(within(senseVoice).getByText(/SenseVoice Small, Alibaba FunAudioLLM/));
});

test("a download in its verification phase says it is verifying", async () => {
  mount({ "localModels:download": () => new Promise(() => undefined) });
  const canary = await card("Canary 180M Flash");
  fireEvent.click(within(canary).getByRole("button", { name: /Download/ }));
  await within(canary).findByText(/Downloading…/);
  emitBotTestNotification("localModels:progress", {
    id: "canary-180m-flash",
    downloaded: 1,
    total: 1,
    percentage: 100,
    phase: "verify",
  });
  await within(canary).findByText(/Verifying…/);
  assert.equal(within(canary).queryByText(/Downloading…/), null);
});
