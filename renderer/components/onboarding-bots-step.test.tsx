import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import { installBotTestIpc, type BotTestIpcCall } from "../main/bots/test-dom";
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
}: {
  bots: ReturnType<typeof botFixture>[];
  botsCapability?: boolean;
}) {
  let created = false;
  const calls: BotTestIpcCall[] = installBotTestIpc({
    "app:getOnboardingState": () => resumeAfterProvider,
    "app:setOnboardingProgress": (step: unknown) => ({
      ...resumeAfterProvider,
      lastSatisfiedStep: step === "bots" ? "bots" : resumeAfterProvider.lastSatisfiedStep,
    }),
    "profile:get": () => ({ name: "Sam" }),
    "providers:list": () => [readyProvider],
    "bots:list": () => (created ? [botFixture({ id: "bot-chief", name: "Chief of Staff" })] : bots),
    "bots:createFromPreset": () => {
      created = true;
      return { bot: botFixture({ id: "bot-chief", name: "Chief of Staff" }), created: true };
    },
  });
  render(
    <QueryClientProvider client={createBotTestQueryClient()}>
      <AppCapabilitiesProvider
        capabilities={{ ...DISABLED_APP_CAPABILITIES, bots: botsCapability }}
      >
        <OnboardingFlow />
      </AppCapabilitiesProvider>
    </QueryClientProvider>,
  );
  return calls;
}

const tourHeading = "Everything Aiden brings together";

test("a first run with no Bots stops on Meet Your First Bot before the tour", async () => {
  mountOnboarding({ bots: [] });
  assert.ok(await screen.findByRole("heading", { name: "Meet Your First Bot" }));
  const stepper = screen.getByRole("list", { name: "Setup progress" });
  assert.ok(within(stepper).getByText("Your first Bot"));
});

test("Start Chat creates exactly one starter Bot and moves on to the tour", async () => {
  const calls = mountOnboarding({ bots: [] });
  const starters = await screen.findByRole("list", { name: "Starter Bots" });
  fireEvent.click(within(starters).getAllByRole("button", { name: "Start Chat" })[0]!);

  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  const creates = calls.filter((call) => call.channel === "bots:createFromPreset");
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0]!.args[0], { presetId: "chief-of-staff" });
  assert.ok(
    calls.some(
      (call) => call.channel === "app:setOnboardingProgress" && call.args[0] === "bots",
    ),
  );
});

test("Skip leaves onboarding on the tour without creating a Bot", async () => {
  const calls = mountOnboarding({ bots: [] });
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
  assert.equal(screen.queryByRole("heading", { name: "Meet Your First Bot" }), null);
});

test("the step is not offered without the Bots capability", async () => {
  mountOnboarding({ bots: [], botsCapability: false });
  assert.ok(await screen.findByRole("heading", { name: tourHeading }));
  assert.equal(screen.queryByRole("heading", { name: "Meet Your First Bot" }), null);
});
