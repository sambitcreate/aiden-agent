import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { emitBotTestNotification, installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
import { botFixture, catalogFixture } from "../main/bots/test-fixtures";
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
  notice = "pending",
}: {
  bots: ReturnType<typeof botFixture>[];
  botsCapability?: boolean;
  /** The Full-access notice as main has it before onboarding. */
  notice?: "pending" | "customize_first";
  overrides?: Record<string, (...args: unknown[]) => unknown>;
  onOpenBotChat?(botId: string): void;
}) {
  let created = false;
  let decision: "continue_full" | "customize_first" | undefined = notice === "customize_first" ? notice : undefined;
  const catalog = () => {
    const base = catalogFixture({ accepted: decision !== undefined });
    return decision === "customize_first"
      ? { ...base, notice: { ...base.notice, acceptedDecision: "customize_first" as const } }
      : base;
  };
  const calls: BotTestIpcCall[] = installBotTestIpc({
    "bots:getCapabilityCatalog": catalog,
    // Like main: one step that keeps a review-first choice.
    "bots:acceptFirstBotAccess": () => {
      if (decision !== "customize_first") decision = "continue_full";
      return catalog().notice;
    },
    "bots:introduce": () => true,
    "app:getOnboardingState": () => resumeAfterProvider,
    "app:setOnboardingProgress": (step: unknown) => ({
      ...resumeAfterProvider,
      lastSatisfiedStep: step === "bots" ? "bots" : resumeAfterProvider.lastSatisfiedStep,
    }),
    "app:setOnboardingOutcome": () => ({ ...resumeAfterProvider, outcome: "completed", lastSatisfiedStep: "tour" }),
    "profile:get": () => ({ name: "Sam" }),
    "providers:list": () => [readyProvider],
    "bots:list": () => (created ? [botFixture({ id: "bot-chief", name: "Chief" })] : bots),
    "bots:createFirst": async () => {
      // Making it takes a moment; main makes it once however often it is asked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const first = !created;
      created = true;
      return { bot: botFixture({ id: "bot-chief", name: "Chief" }), created: first };
    },
    ...overrides,
  });
  const chooseReviewFirstElsewhere = () => { decision = "customize_first"; };
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider
        capabilities={{ ...DISABLED_APP_CAPABILITIES, bots: botsCapability }}
      >
        <OnboardingFlow {...(onOpenBotChat ? { onOpenBotChat } : {})} />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
  return Object.assign(calls, { chooseReviewFirstElsewhere });
}

const tourHeading = "Finish setup";

test("a first run makes the first Bot silently and says what a Bot is, with no starter carousel", async () => {
  const calls = mountOnboarding({ bots: [] });
  await screen.findByText("Chief is ready");
  assert.ok(screen.getByText(/A Bot is a helper with its own chat, memory and routines\./u));
  assert.equal(screen.queryByRole("list", { name: "Starter Bots" }), null);
  assert.equal(screen.queryByRole("button", { name: "Skip" }), null, "nothing to choose");
  assert.equal(calls.filter((call) => call.channel === "bots:createFirst").length >= 1, true);
  assert.equal(calls.some((call) => call.channel === "bots:createFromPreset"), false);
  await waitFor(() =>
    assert.ok(calls.some((call) => call.channel === "app:setOnboardingProgress" && call.args[0] === "bots")),
  );
});

test("finishing onboarding opens the first Bot's chat, where it asks what it should help with", async () => {
  const opened: string[] = [];
  const calls = mountOnboarding({ bots: [], onOpenBotChat: (botId) => opened.push(botId) });
  await screen.findByText("Chief is ready");
  screen.getByText(/Chief gets Full access: .*Starting accepts this/u);
  assert.deepEqual(opened, [], "the chat waits until onboarding is done");
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  const channels = () => calls.map((call) => call.channel);
  assert.equal(channels().includes("bots:acceptFirstBotAccess"), false, "showing the step accepts nothing");
  assert.equal(channels().includes("bots:introduce"), false);

  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.deepEqual(opened, ["bot-chief"]));
  await waitFor(() => assert.ok(channels().includes("bots:introduce")));
  const acknowledgement = calls.find((call) => call.channel === "bots:acceptFirstBotAccess");
  assert.equal((acknowledgement?.args[0] as { decision?: string } | undefined)?.decision, "continue_full");
  assert.ok(channels().indexOf("bots:acceptFirstBotAccess") < channels().indexOf("bots:introduce"), "it greets only once Full access is accepted");
});

test("a person who chose to review Bot access first keeps that choice through onboarding", async () => {
  const opened: string[] = [];
  const calls = mountOnboarding({ bots: [], notice: "customize_first", onOpenBotChat: (botId) => opened.push(botId) });
  await screen.findByText("Chief is ready");
  screen.getByText(/You chose to review a Bot’s access first/u);
  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.deepEqual(opened, ["bot-chief"]));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(calls.some((call) => call.channel === "bots:acceptFirstBotAccess"), false);
  assert.equal(calls.some((call) => call.channel === "bots:introduce"), false);
});

test("a review-first choice made elsewhere after the step showed stands, and the Bot doesn't greet", async () => {
  const opened: string[] = [];
  const calls = mountOnboarding({ bots: [], onOpenBotChat: (botId) => opened.push(botId) });
  await screen.findByText("Chief is ready");
  screen.getByText(/Chief gets Full access/u);
  calls.chooseReviewFirstElsewhere();
  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.deepEqual(opened, ["bot-chief"]));
  await waitFor(() => assert.ok(calls.some((call) => call.channel === "bots:acceptFirstBotAccess")));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(calls.some((call) => call.channel === "bots:introduce"), false);
});

test("the first Bot is never made when Bots already exist", async () => {
  const calls = mountOnboarding({ bots: [botFixture()] });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(screen.queryByRole("region", { name: "Your first Bot" }), null);
  assert.equal(calls.some((call) => call.channel === "bots:createFirst"), false);
});

test("without the Bots capability no Bot is made and the Bot store is not read", async () => {
  const calls = mountOnboarding({ bots: [], botsCapability: false });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(calls.some((call) => call.channel === "bots:list"), false);
  assert.equal(calls.some((call) => call.channel === "bots:createFirst"), false);
  const stepper = screen.getByRole("list", { name: "Setup progress" });
  assert.equal(within(stepper).queryByText("Your first Bot"), null);
});

test("no Bot is made when the Bot store can't be read", async () => {
  const calls = mountOnboarding({
    bots: [],
    overrides: { "bots:list": () => Promise.reject(new Error("Bots are open in another Aiden window.")) },
  });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(calls.some((call) => call.channel === "bots:createFirst"), false);
});

test("making the first Bot that fails offers only Try again, which makes it", async () => {
  let fail = true;
  const opened: string[] = [];
  const calls = mountOnboarding({
    bots: [],
    onOpenBotChat: (botId) => opened.push(botId),
    overrides: {
      "bots:createFirst": () => {
        if (fail) return Promise.reject(new Error("Bots are open in another Aiden window."));
        return { bot: botFixture({ id: "bot-chief", name: "Chief" }), created: true };
      },
    },
  });
  const retry = await screen.findByRole("button", { name: "Try again" });
  assert.equal(calls.some((call) => call.channel === "app:setOnboardingProgress" && call.args[0] === "bots"), false);
  fail = false;
  fireEvent.click(retry);
  await screen.findByText("Chief is ready");
  fireEvent.click(screen.getByRole("button", { name: /Start using Aiden/u }));
  await waitFor(() => assert.deepEqual(opened, ["bot-chief"]));
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

test("Google repair saves the missing key, requests chat access and confirms a usable connection", async () => {
  const google = { ...readyProvider, id: "google", label: "Google", needsKey: true, hasKey: false,
    canLogout: true, authMethods: [{ type: "api_key", canLogin: true, label: "API key" }] };
  let flowId = "";
  let scope = "transcription_only";
  const calls = mountOnboarding({ bots: [], botsCapability: false, overrides: {
    "app:getOnboardingState": () => ({ ...resumeAfterProvider, providerReady: false, selectedProviderId: undefined, lastSatisfiedStep: "profile" }),
    "providers:list": () => [google],
    "settings:get": () => ({ geminiUsageScope: scope }),
    "providers:auth:start": request => {
      flowId = (request as { flowId: string }).flowId;
      emitBotTestNotification("providers:auth:prompt", {
        providerId: "google", flowId, promptId: "google-key", type: "secret", message: "Enter API key",
      });
      return { started: true };
    },
    "providers:auth:respond": request => {
      assert.equal((request as { value: string }).value, "replacement-fixture");
      google.hasKey = true;
      return { accepted: true };
    },
    "settings:setGeminiUsageScope": value => {
      scope = value as string;
      return { geminiUsageScope: scope };
    },
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Finish connection: Google" }));
  const editor = await screen.findByRole("dialog", { name: "Set up Google" });
  fireEvent.click(within(editor).getByRole("button", { name: "API key" }));
  await screen.findByText("Enter API key");
  fireEvent.change(editor.querySelector('input[type="password"]')!, { target: { value: "replacement-fixture" } });
  fireEvent.click(within(editor).getByRole("button", { name: "Continue" }));
  await waitFor(() => assert.equal(google.hasKey, true));
  await act(async () => emitBotTestNotification("providers:auth:done", { providerId: "google", flowId }));
  const access = await screen.findByRole("dialog", { name: "Set up Google Gemini access?" });
  assert.equal(scope, "transcription_only", "saving a key must wait for explicit chat access consent");
  assert.equal(calls.some(c => c.channel === "app:setOnboardingProgress"), false);
  fireEvent.click(within(access).getByRole("radio", { name: /Models \+ transcription/u }));
  fireEvent.click(within(access).getByRole("button", { name: "Save Gemini access" }));
  await screen.findByText("Google is ready for chat");
  await waitFor(() => assert.ok(!screen.queryByRole("dialog", { name: "Set up Google Gemini access?" })));
  fireEvent.click(screen.getByRole("button", { name: "Continue setup" }));
  await screen.findByRole("heading", { name: "Finish setup" });
  assert.deepEqual(calls.find(c => c.channel === "app:setOnboardingProgress")?.args, ["provider", "google"]);
});
