import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { LocalVoiceSettings } from "./local-voice-settings";
import type { AppSettings, LocalVoiceModel } from "../../lib/types";
import { localModelsTestCatalog } from "./local-models-test-catalog";

afterEach(cleanup);

const catalog = localModelsTestCatalog(["parakeet-v3", "whisper-turbo"]);

function mount(
  settings: Partial<AppSettings>,
  models: LocalVoiceModel[] | (() => LocalVoiceModel[]) = catalog,
  extra: Record<string, (...args: unknown[]) => unknown> = {},
) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    ...extra,
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "localModels:list": () => (typeof models === "function" ? models() : models),
    "localVoice:status": () => ({ ready: true, error: null }),
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <LocalVoiceSettings />
    </QueryClientProvider>,
  );
  return calls;
}

test("Automatic with no chosen model shows the model dictation will use", async () => {
  mount({});
  await screen.findByText("Parakeet TDT 0.6B v3 (automatic)");
  assert.equal(screen.queryByText("None selected"), null);
});

test("an explicitly chosen installed model is shown as-is", async () => {
  mount({ localVoiceModel: "whisper-turbo" });
  await screen.findByText("Whisper Large v3 Turbo");
});

test("choosing a model in the manager keeps the provider choice untouched", async () => {
  const calls = mount({});
  fireEvent.click(await screen.findByRole("button", { name: /Manage Models/ }));
  const use = await screen.findAllByRole("button", { name: "Use" });
  fireEvent.click(use[1]!);
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "settings:set")));
  const patches = calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  assert.deepEqual(patches, [{ localVoiceModel: "whisper-turbo" }]);
});

test("Trim silence is on by default and can be turned off", async () => {
  const calls = mount({});
  const toggle = await screen.findByRole("switch", { name: "Trim silence" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
      [{ voiceTrimSilence: false }],
    ),
  );
});

test("Load in advance is on by default and can be turned off", async () => {
  const calls = mount({});
  const toggle = await screen.findByRole("switch", { name: "Load in advance" });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  fireEvent.click(toggle);
  await waitFor(() =>
    assert.deepEqual(
      calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]),
      [{ localVoicePreload: false }],
    ),
  );
});

test("Free memory when idle defaults to 30 minutes", async () => {
  mount({});
  const trigger = await screen.findByRole("combobox", { name: "Unload the on-device model" });
  assert.match(trigger.textContent ?? "", /After 30 minutes/u);
});

test("off Apple silicon, Parakeet v3 has no faster build to offer", async () => {
  mount({});
  await screen.findByText("Parakeet TDT 0.6B v3 (automatic)");
  assert.equal(screen.queryByRole("button", { name: /Download and Use/ }), null);
});

test("on Apple silicon, a chosen Parakeet v3 is offered Metal, and the choice follows the download", async () => {
  let installed = ["parakeet-v3"];
  const models = () => localModelsTestCatalog(installed, { appleSilicon: true });
  // Main lists the download once it lands.
  const calls = mount({ localVoiceModel: "parakeet-v3" }, models, {
    "localModels:download": (id: unknown) => {
      installed = [...installed, id as string];
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Download and Use/ }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "localModels:download")));
  assert.deepEqual(calls.find((call) => call.channel === "localModels:download")?.args, ["parakeet-v3-metal"]);
  await screen.findByText("Parakeet TDT 0.6B v3 · Metal");
  const patches = calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  assert.deepEqual(patches, [{ localVoiceModel: "parakeet-v3-metal" }]);
  assert.equal(screen.queryByRole("button", { name: /Download and Use/ }), null);
});

test("on Apple silicon, Automatic stays Automatic and simply picks the Metal build up", async () => {
  let installed = ["parakeet-v3"];
  const calls = mount({}, localModelsTestCatalog(installed, { appleSilicon: true }), {
    "localModels:download": (id: unknown) => {
      installed = [...installed, id as string];
    },
  });
  fireEvent.click(await screen.findByRole("button", { name: /Download and Use/ }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "localModels:download")));
  assert.equal(calls.some((call) => call.channel === "settings:set"), false);
});

test("a model without a faster build gets no offer, even on Apple silicon", async () => {
  mount({ localVoiceModel: "whisper-turbo" }, localModelsTestCatalog(["parakeet-v3", "whisper-turbo"], { appleSilicon: true }));
  await screen.findByText("Whisper Large v3 Turbo");
  assert.equal(screen.queryByRole("button", { name: /Download and Use/ }), null);
});
