import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { LocalVoiceSettings } from "./local-voice-settings";
import type { AppSettings, LocalVoiceModel } from "../../lib/types";

afterEach(cleanup);

function model(id: string, name: string, installed: boolean): LocalVoiceModel {
  return {
    id,
    name,
    description: "",
    sizeLabel: "640 MB",
    quant: "int8",
    languagesLabel: "25 languages",
    accuracy: 0.9,
    speed: 0.9,
    recommended: id === "parakeet-v3",
    installed,
  };
}

const catalog = [
  model("parakeet-v3", "Parakeet TDT 0.6B v3", true),
  model("whisper-turbo", "Whisper Large v3 Turbo", true),
  model("sense-voice", "SenseVoice Small", false),
];

function mount(settings: Partial<AppSettings>) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "localModels:list": () => catalog,
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
