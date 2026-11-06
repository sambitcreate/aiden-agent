import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import { botFixture } from "../main/bots/test-fixtures";
import { createBotTestQueryClient } from "../main/bots/test-providers";
import { OnboardingFlow } from "./onboarding-flow";
import type { OnboardingSnapshot } from "../shared/onboarding";

afterEach(cleanup);

/** Provider setup is already done, so onboarding resumes at the step after it. */
const resumeAfterProvider: OnboardingSnapshot = {
  version: 2,
  outcome: "incomplete",
  lastSatisfiedStep: "provider",
  selectedProviderId: "openai",
  profileReady: true,
  providerReady: true,
};

const readyProvider = {
  id: "openai",
  kind: "openai",
  label: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-test"],
  defaultModel: "gpt-test",
  needsKey: true,
  hasKey: true,
  isBuiltin: true,
};

function mountOnboarding({
  bots,
  botsCapability = true,
  overrides = {},
  onOpenBotChat,
}: {
  bots: ReturnType<typeof botFixture>[];
  botsCapability?: boolean;
  overrides?: Record<string, (...args: unknown[]) => unknown>;
  onOpenBotChat?(botId: string): void;
}) {
  let created = false;
  const calls: BotTestIpcCall[] = installBotTestIpc({
    "app:getOnboardingState": () => resumeAfterProvider,
    "app:setOnboardingProgress": (step: unknown) => ({
      ...resumeAfterProvider,
      lastSatisfiedStep: step === "bots" ? "bots" : resumeAfterProvider.lastSatisfiedStep,
    }),
    "app:setOnboardingOutcome": () => ({ ...resumeAfterProvider, outcome: "completed", lastSatisfiedStep: "tour" }),
    "profile:get": () => ({ name: "Sam" }),
    "providers:list": () => [readyProvider],
    "bots:list": () => (created ? [botFixture({ id: "bot-chief", name: "Chief of Staff" })] : bots),
    "bots:createFromPreset": async () => {
      // Creating takes a moment, so a second click lands while it runs.
      await new Promise((resolve) => setTimeout(resolve, 20));
      created = true;
      return { bot: botFixture({ id: "bot-chief", name: "Chief of Staff" }), created: true };
    },
    ...overrides,
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider
        capabilities={{ ...DISABLED_APP_CAPABILITIES, bots: botsCapability }}
      >
        <OnboardingFlow {...(onOpenBotChat ? { onOpenBotChat } : {})} />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
  return calls;
}

const tourHeading = "Finish setup";
async function openStarters() {
  fireEvent.click(await screen.findByText("Choose your first Bot", { exact: true }));
}

test("a first run offers the starter Bots as an optional part of Finish setup", async () => {
  mountOnboarding({ bots: [] });
  await openStarters();
  assert.ok(await screen.findByRole("heading", { name: "Meet your first Bot" }));
  const stepper = screen.getByRole("list", { name: "Setup progress" });
  assert.ok(within(stepper).getByText("Finish setup"));
  // Explain hand-offs, rules, and whole-plan approval at the first Bot setup.
  assert.ok(screen.getByText("Bots track accepted tasks in Open work, follow your rules, hand you the steps only you should do, and can ask you to approve a whole plan."));
  assert.ok(screen.getByText("Bots can message each other when it helps; turn it off in Settings → Bots & Approvals."));
});

test("Start chat creates exactly one starter Bot and moves on to the tour", async () => {
  const calls = mountOnboarding({ bots: [] });
  await openStarters();
  const starters = await screen.findByRole("list", { name: "Starter Bots" });
  fireEvent.click(within(starters).getAllByRole("button", { name: "Start chat" })[0]!);

  await screen.findByText("Your Bot’s chat will open when you finish.");
  const creates = calls.filter((call) => call.channel === "bots:createFromPreset");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0]!.args[0], { presetId: "chief-of-staff" });
  assert.ok(
    calls.some(
      (call) => call.channel === "app:setOnboardingProgress" && call.args[0] === "bots",
    ),
  );
});

test("finishing onboarding after Start chat opens the new Bot's chat", async () => {
  const opened: string[] = [];
  mountOnboarding({ bots: [], onOpenBotChat: (botId) => opened.push(botId) });
  await openStarters();
  const starters = await screen.findByRole("list", { name: "Starter Bots" });
  fireEvent.click(within(starters).getAllByRole("button", { name: "Start chat" })[0]!);
  await screen.findByText("Your Bot’s chat will open when you finish.");
  assert.deepEqual(opened, [], "the chat waits until onboarding is done");
  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.deepEqual(opened, ["bot-chief"]));
});

test("finishing onboarding after Skip opens no Bot chat", async () => {
  const opened: string[] = [];
  const calls = mountOnboarding({ bots: [], onOpenBotChat: (botId) => opened.push(botId) });
  await openStarters();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "app:setOnboardingOutcome")));
  assert.deepEqual(opened, []);
});

test("Skip leaves onboarding on the tour without creating a Bot", async () => {
  const calls = mountOnboarding({ bots: [] });
  await openStarters();
  fireEvent.click(await screen.findByRole("button", { name: "Skip" }));

  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.deepEqual(
    calls.filter((call) => call.channel === "bots:createFromPreset"),
    [],
  );
});

test("the step is skipped when Bots already exist", async () => {
  mountOnboarding({ bots: [botFixture()] });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(screen.queryByRole("heading", { name: "Meet your first Bot" }), null);
});

test("the step is not offered without the Bots capability, and the Bot store is not read", async () => {
  const calls = mountOnboarding({ bots: [], botsCapability: false });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(screen.queryByRole("heading", { name: "Meet your first Bot" }), null);
  assert.equal(calls.some((call) => call.channel === "bots:list"), false);
  const stepper = screen.getByRole("list", { name: "Setup progress" });
  assert.equal(within(stepper).queryByText("Your first Bot"), null);
});

test("the step is not offered when the Bot store can't be read", async () => {
  mountOnboarding({
    bots: [],
    overrides: { "bots:list": () => Promise.reject(new Error("Bots are open in another Aiden window.")) },
  });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(screen.queryByRole("heading", { name: "Meet your first Bot" }), null);
});

test("Start chat clicked twice while the Bot is being made sends one create", async () => {
  const calls = mountOnboarding({ bots: [] });
  await openStarters();
  const starters = await screen.findByRole("list", { name: "Starter Bots" });
  const start = within(starters).getAllByRole("button", { name: "Start chat" })[0]!;
  fireEvent.click(start);
  fireEvent.click(start);
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(calls.filter((call) => call.channel === "bots:createFromPreset").length, 1);
});

test("a Start chat that fails stays on the step so the person can try again or skip", async () => {
  const calls = mountOnboarding({
    bots: [],
    overrides: { "bots:createFromPreset": () => Promise.reject(new Error("Bots are open in another Aiden window.")) },
  });
  await openStarters();
  const starters = await screen.findByRole("list", { name: "Starter Bots" });
  fireEvent.click(within(starters).getAllByRole("button", { name: "Start chat" })[0]!);
  await waitFor(() => assert.equal(calls.filter((call) => call.channel === "bots:createFromPreset").length, 1));
  await waitFor(() =>
    assert.equal(within(starters).getAllByRole("button", { name: "Start chat" })[0]!.hasAttribute("disabled"), false),
  );
  assert.ok(screen.getByRole("heading", { name: "Meet your first Bot" }));
  assert.equal(calls.some((call) => call.channel === "app:setOnboardingProgress" && call.args[0] === "bots"), false);
});

test("onboarding validates the chosen key, records a usable model and waits for Finish", async () => {
  const provider = { ...readyProvider, id: "anthropic", label: "Anthropic", hasKey: false,
    authMethods: [{ type: "api_key", canLogin: true, label: "API key" }] };
  const calls = mountOnboarding({ bots: [], botsCapability: false, overrides: {
    "app:getOnboardingState": () => ({ ...resumeAfterProvider, providerReady: false, selectedProviderId: undefined, lastSatisfiedStep: "profile" }),
    "providers:list": () => [provider],
    "settings:get": () => ({}),
    "providers:validateOnboardingApiKey": (id, key) => {
      assert.equal(id, "anthropic");
      if (key !== "fixture-key") throw new Error("The provider rejected this key.");
      provider.hasKey = true;
      return { provider };
    },
  } });
  fireEvent.click(await screen.findByRole("button", { name: /I have an API key/u }));
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  const input = screen.getByPlaceholderText("Paste your API key");
  fireEvent.change(input, { target: { value: "rejected-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  await screen.findByText("The provider rejected this key.");
  assert.equal(calls.some(c => c.channel === "app:setOnboardingProgress"), false);
  fireEvent.change(input, { target: { value: "fixture-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate key" }));
  await screen.findByText("Anthropic is ready for chat");
  assert.ok(screen.getByText("gpt-test"));
  assert.equal(calls.some(c => c.channel === "app:setOnboardingProgress"), false);
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  await waitFor(() => assert.deepEqual(calls.find(c => c.channel === "app:setOnboardingProgress")?.args, ["provider", "anthropic"]));
  await screen.findByRole("heading", { name: "Finish setup" });
  assert.equal(calls.some(c => c.channel === "app:setOnboardingOutcome"), false);
  fireEvent.click(screen.getByRole("button", { name: "Start using Aiden" }));
  await waitFor(() => assert.deepEqual(calls.find(c => c.channel === "app:setOnboardingOutcome")?.args, ["completed", "anthropic"]));
});

test("a sign-in finishing after cancellation leaves the user's deferred setup intact", async () => {
  const provider = { ...readyProvider, hasKey: false,
    authMethods: [{ type: "oauth", canLogin: true, label: "Sign in with OpenAI" }] };
  let flowId = "";
  let lists = 0;
  const calls = mountOnboarding({ bots: [], botsCapability: false, overrides: {
    "app:getOnboardingState": () => ({ ...resumeAfterProvider, providerReady: false, selectedProviderId: undefined, lastSatisfiedStep: "profile" }),
    "providers:list": () => { lists++; return [provider]; },
    "settings:get": () => ({}),
    "providers:auth:start": request => { flowId = (request as { flowId: string }).flowId; return { started: true }; },
    "providers:auth:cancel": () => ({ cancelled: false, reason: "finishing" }),
  } });
  fireEvent.click(await screen.findByRole("button", { name: /I have an account/u }));
  fireEvent.click(screen.getByRole("button", { name: "ChatGPT" }));
  await screen.findByText(/random installation identifier/u);
  fireEvent.click(screen.getByRole("button", { name: "Sign in with OpenAI" }));
  await waitFor(() => assert.ok(flowId));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Set up OpenAI" })).getAllByRole("button", { name: "Close" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
  await screen.findByRole("heading", { name: "Finish setup" });
  provider.hasKey = true;
  const before = lists;
  await act(async () => emitBotTestNotification("providers:auth:done", { providerId: "openai", flowId }));
  await waitFor(() => assert.ok(lists > before, "reconcile the credential commit with the provider inventory"));
  fireEvent.click(screen.getByRole("button", { name: "Start using Aiden" }));
  await waitFor(() => assert.equal(calls.find(c => c.channel === "app:setOnboardingOutcome")?.args[0], "deferred"));
  assert.equal(calls.some(c => c.channel === "app:setOnboardingProgress" && c.args[0] === "provider"), false);
});

test("a voice-only Google connection with a missing credential opens key repair first", async () => {
  const google = { ...readyProvider, id: "google", label: "Google", needsKey: true, hasKey: false,
    canLogout: true, authMethods: [{ type: "api_key", canLogin: true, label: "API key" }] };
  mountOnboarding({ bots: [], botsCapability: false, overrides: {
    "app:getOnboardingState": () => ({ ...resumeAfterProvider, providerReady: false, selectedProviderId: undefined, lastSatisfiedStep: "profile" }),
    "providers:list": () => [google],
    "settings:get": () => ({ geminiUsageScope: "transcription_only" }),
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Finish connection: Google" }));
  const editor = await screen.findByRole("dialog", { name: "Set up Google" });
  assert.ok(within(editor).getByRole("button", { name: "API key" }));
});
