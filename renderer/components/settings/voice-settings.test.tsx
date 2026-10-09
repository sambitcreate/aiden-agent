import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { installBotTestIpc } from "../../main/bots/test-dom";
import { createBotTestQueryClient } from "../../main/bots/test-providers";
import { VoiceInputSettings } from "./voice-settings";
import { localModelsTestCatalog } from "./local-models-test-catalog";
import type { AppSettings } from "../../lib/types";
import type { VoiceProviderResolution } from "../../shared/voice-provider";

afterEach(cleanup);

function mount(settings: Partial<AppSettings>, resolution: VoiceProviderResolution, installed: string[]) {
  return mountWithCalls(settings, resolution, installed);
}

function mountWithCalls(
  settings: Partial<AppSettings>,
  resolution: VoiceProviderResolution,
  installed: string[],
  providers: unknown[] = [],
) {
  let current: Partial<AppSettings> = { ...settings };
  const calls = installBotTestIpc({
    "settings:get": () => current,
    "settings:set": (patch: unknown) => {
      current = { ...current, ...(patch as Partial<AppSettings>) };
      return current;
    },
    "providers:list": () => providers,
    "settings:setGeminiVoiceSetup": () => ({ ...current, voiceProvider: "gemini" }),
    "localModels:list": () => localModelsTestCatalog(installed),
    "voice:resolveProvider": () => resolution,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <VoiceInputSettings />
    </QueryClientProvider>,
  );
  const patches = () => calls.filter((call) => call.channel === "settings:set").map((call) => call.args[0]);
  return { calls, patches };
}

const localReady = (modelId: string, automatic: boolean): VoiceProviderResolution => ({
  kind: "ready",
  provider: "local",
  modelId,
  automatic,
});

async function optionsOf(name: string): Promise<string[]> {
  const trigger = await screen.findByRole("combobox", { name });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  const listbox = await screen.findByRole("listbox");
  const labels = Array.from(listbox.querySelectorAll("[role=option]")).map((option) => option.textContent ?? "");
  fireEvent.keyDown(listbox, { key: "Escape" });
  return labels;
}

test("Automatic shows which provider dictation is using", async () => {
  mount({}, localReady("parakeet-v3", true), ["parakeet-v3"]);
  const provider = await screen.findByRole("combobox", { name: "Voice provider" });
  assert.match(provider.textContent ?? "", /Automatic/);
  await screen.findByText("Automatic — using On-device (Parakeet TDT 0.6B v3)");
});

test("a language the active model can't hear explains the fallback", async () => {
  mount(
    { voiceProvider: "local", localVoiceModel: "parakeet-v2", voiceLanguage: "de" },
    localReady("parakeet-v2", false),
    ["parakeet-v2"],
  );
  await screen.findByText("Parakeet TDT 0.6B v2 doesn't support German. Using English.");
});

test("the language list is Automatic then the active model's languages", async () => {
  mount({ localVoiceModel: "canary-180m-flash" }, localReady("canary-180m-flash", true), ["canary-180m-flash"]);
  await screen.findByText("Automatic — using On-device (Canary 180M Flash)");
  assert.deepEqual(await optionsOf("Language"), ["Automatic", "English", "German", "Spanish", "French"]);
});

test("a supported language choice has no fallback notice", async () => {
  mount(
    { localVoiceModel: "canary-180m-flash", voiceLanguage: "de" },
    localReady("canary-180m-flash", true),
    ["canary-180m-flash"],
  );
  await screen.findByText("Automatic — using On-device (Canary 180M Flash)");
  assert.equal(screen.queryByText(/doesn't support/), null);
});

test("cloud transcription offers the common cloud languages", async () => {
  mount({ voiceProvider: "openai" }, { kind: "ready", provider: "openai", automatic: false }, []);
  const options = await optionsOf("Language");
  assert.equal(options[0], "Automatic");
  assert.ok(options.includes("Japanese"));
  assert.ok(options.includes("Ukrainian"));
  assert.equal(options.length, 18);
});

test("Translate to English appears only for a model that can translate", async () => {
  mount({ localVoiceModel: "parakeet-v3" }, localReady("parakeet-v3", true), ["parakeet-v3", "canary-180m-flash"]);
  await screen.findByText("Automatic — using On-device (Parakeet TDT 0.6B v3)");
  assert.equal(screen.queryByRole("switch", { name: "Translate to English" }), null);
});

test("turning on Translate to English saves the preference", async () => {
  const { patches } = mount(
    { localVoiceModel: "canary-180m-flash" },
    localReady("canary-180m-flash", true),
    ["canary-180m-flash"],
  );
  const toggle = await screen.findByRole("switch", { name: "Translate to English" });
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  fireEvent.click(toggle);
  await waitFor(() => assert.deepEqual(patches(), [{ voiceTranslateToEnglish: true }]));
});

async function choose(comboboxName: string, optionName: string) {
  const trigger = await screen.findByRole("combobox", { name: comboboxName });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.keyDown(option, { key: "Enter" });
}

test("choosing Gemini waits for the privacy disclosure before switching voice", async () => {
  const { calls, patches } = mountWithCalls(
    {},
    localReady("parakeet-v3", true),
    ["parakeet-v3"],
    [{ id: "google", name: "Google", kind: "builtin", hasKey: true }],
  );
  await choose("Voice provider", "Online · Google Gemini");
  const dialog = await screen.findByRole("dialog", { name: "Use Google Gemini for voice?" });
  assert.deepEqual(patches(), []);
  fireEvent.click(within(dialog).getByRole("button", { name: "Use Gemini" }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "settings:setGeminiVoiceSetup")));
  assert.deepEqual(patches(), []);
});

test("choosing the language saves the spoken-language preference", async () => {
  const { patches } = mountWithCalls({}, localReady("canary-180m-flash", true), ["canary-180m-flash"]);
  await choose("Language", "German");
  await waitFor(() => assert.deepEqual(patches(), [{ voiceLanguage: "de" }]));
});

test("Gemini voice keeps its privacy and access choice reachable", async () => {
  mountWithCalls(
    { voiceProvider: "gemini", geminiUsageScope: "transcription_only" },
    { kind: "ready", provider: "gemini", automatic: false },
    [],
    [{ id: "google", name: "Google", kind: "builtin", hasKey: true }],
  );
  fireEvent.click(await screen.findByRole("button", { name: "Privacy & access" }));
  await screen.findByRole("dialog", { name: "Use Google Gemini for voice?" });
});
