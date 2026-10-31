import "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { analyticsRegistryView } from "../../main/handlers/analytics";
import { installBotTestIpc } from "../main/bots/test-dom";
import type { AnalyticsStatusView } from "../shared/analytics";
import type { OnboardingSnapshot } from "../shared/onboarding";
import { OnboardingFlow } from "./onboarding-flow";
import { Toaster } from "./ui";
import { UsageDataNotice, UsageDataOnboardingRow, UsageDataSettings } from "./usage-data";

afterEach(cleanup);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const SWITCH = { name: "Share anonymous usage and crash data" } as const;

function status(overrides: Partial<AnalyticsStatusView> = {}): AnalyticsStatusView {
  return { enabled: true, envDisabled: false, hasKey: true, noticePending: false, ...overrides };
}

function channelCalls(calls: { channel: string; args: unknown[] }[], channel: string): unknown[][] {
  return calls.filter((call) => call.channel === channel).map((call) => call.args);
}

test("the Settings switch shows the saved choice and turns usage data off", async () => {
  let saved = status();
  const calls = installBotTestIpc({
    "analytics:status": () => saved,
    "analytics:setEnabled": (enabled) => (saved = status({ enabled: enabled as boolean })),
  });
  render(<UsageDataSettings />);
  await flush();

  const control = screen.getByRole("switch", SWITCH);
  assert.equal(control.getAttribute("aria-checked"), "true");
  fireEvent.click(control);
  assert.equal(control.getAttribute("aria-checked"), "false", "the switch moves before main answers");
  await flush();

  assert.deepEqual(channelCalls(calls, "analytics:setEnabled"), [[false]]);
  assert.equal(screen.getByRole("switch", SWITCH).getAttribute("aria-checked"), "false");
});

test("a failed save puts the switch back and says so once", async () => {
  installBotTestIpc({
    "analytics:status": () => status(),
    "analytics:setEnabled": () => {
      throw new Error("disk full");
    },
  });
  render(
    <>
      <UsageDataSettings />
      <Toaster />
    </>,
  );
  await flush();

  fireEvent.click(screen.getByRole("switch", SWITCH));
  await flush();

  assert.equal(screen.getByRole("switch", SWITCH).getAttribute("aria-checked"), "true");
  assert.equal((await screen.findAllByText("Aiden could not save the usage data setting.")).length, 1);
});

test("DO_NOT_TRACK shows the switch off and locked, with the reason", async () => {
  const calls = installBotTestIpc({
    "analytics:status": () => status({ enabled: true, envDisabled: true }),
  });
  render(<UsageDataSettings />);
  await flush();

  const control = screen.getByRole("switch", SWITCH);
  assert.equal(control.getAttribute("aria-checked"), "false");
  assert.equal((control as HTMLButtonElement).disabled, true);
  assert.ok(screen.getByText("Turned off by your environment (DO_NOT_TRACK)"));
  fireEvent.click(control);
  await flush();
  assert.deepEqual(channelCalls(calls, "analytics:setEnabled"), []);
});

test("What's sent lists the real events and their allowed values", async () => {
  installBotTestIpc({
    "analytics:status": () => status(),
    "analytics:registry": () => analyticsRegistryView(),
  });
  render(<UsageDataSettings />);
  await flush();

  fireEvent.click(screen.getByRole("button", { name: "View" }));
  await flush();

  const sheet = screen.getByRole("dialog", { name: "What’s sent" });
  const events = within(sheet).getByRole("region", { name: "Events" });
  assert.ok(within(events).getByText("app_opened"));
  assert.match(events.textContent ?? "", /launch_kind: one of cold, after_update, after_crash/u);
  assert.ok(within(events).getByText("web_search_used"));
  const crashes = within(sheet).getByRole("region", { name: "Crash and error reports" });
  assert.ok(within(crashes).getByText("app_crashed"));
  assert.match(within(sheet).getByRole("region", { name: "With every event" }).textContent ?? "", /app_version/u);
  assert.match(sheet.textContent ?? "", /Never sent: chats, prompts, replies/u);
});

test("onboarding shows the row on, and turning it off saves the choice", async () => {
  const calls = installBotTestIpc({
    "analytics:status": () => status({ hasKey: false }),
    "analytics:setEnabled": (enabled) => status({ enabled: enabled as boolean, hasKey: false }),
  });
  render(<UsageDataOnboardingRow />);
  await flush();

  const row = screen.getByRole("group", SWITCH);
  assert.match(row.textContent ?? "", /Never includes your chats, files or keys\./u);
  assert.ok(within(row).getByRole("button", { name: "What’s sent" }));
  const control = within(row).getByRole("switch", SWITCH);
  assert.equal(control.getAttribute("aria-checked"), "true");

  fireEvent.click(control);
  await flush();
  assert.deepEqual(channelCalls(calls, "analytics:setEnabled"), [[false]]);
});

for (const [button, choice] of [
  ["OK", "ok"],
  ["Turn off", "turn-off"],
  ["Dismiss", "ok"],
] as const) {
  test(`the one-time notice records ${button} as "${choice}" and goes away`, async () => {
    const calls = installBotTestIpc({
      "analytics:status": () => status({ noticePending: true }),
      "analytics:markNoticeShown": (value) => status({ enabled: value !== "turn-off" }),
    });
    render(<UsageDataNotice />);
    await flush();

    const notice = screen.getByRole("region", { name: "Aiden now shares anonymous usage data" });
    fireEvent.click(within(notice).getByRole("button", { name: button }));
    await flush();

    assert.deepEqual(channelCalls(calls, "analytics:markNoticeShown"), [[choice]]);
    assert.equal(screen.queryByRole("region", { name: "Aiden now shares anonymous usage data" }), null);
  });
}

test("the notice stays hidden when main has nothing pending", async () => {
  installBotTestIpc({ "analytics:status": () => status({ noticePending: false }) });
  render(<UsageDataNotice />);
  await flush();
  assert.equal(screen.queryByRole("region"), null);
});

function onboardingSnapshot(outcome: OnboardingSnapshot["outcome"]): OnboardingSnapshot {
  return { version: 2, outcome, lastSatisfiedStep: outcome === "incomplete" ? "none" : "tour", profileReady: true, providerReady: true };
}

function renderOnboarding(outcome: OnboardingSnapshot["outcome"]) {
  const calls = installBotTestIpc({
    "app:getOnboardingState": () => onboardingSnapshot(outcome),
    "app:setOnboardingOutcome": () => onboardingSnapshot("incomplete"),
    "profile:get": () => ({ name: "Ada" }),
    "analytics:status": () => status({ noticePending: true }),
    "analytics:markNoticeShown": () => status(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <OnboardingFlow />
    </QueryClientProvider>,
  );
  return calls;
}

const NOTICE = { name: "Aiden now shares anonymous usage data" } as const;

for (const outcome of ["completed", "deferred"] as const) {
  test(`an install that already ${outcome === "completed" ? "finished" : "deferred"} onboarding gets the one-time notice on launch`, async () => {
    const calls = renderOnboarding(outcome);
    await flush();
    await flush();

    const notice = screen.getByRole("region", NOTICE);
    fireEvent.click(within(notice).getByRole("button", { name: "OK" }));
    await flush();

    assert.deepEqual(channelCalls(calls, "analytics:markNoticeShown"), [["ok"]]);
    assert.equal(screen.queryByRole("region", NOTICE), null);
  });
}

test("a new install sees onboarding instead of the notice, and reopening onboarding hides it", async () => {
  renderOnboarding("incomplete");
  await flush();
  await flush();
  assert.equal(screen.queryByRole("region", NOTICE), null);
  cleanup();

  renderOnboarding("completed");
  await flush();
  await flush();
  assert.ok(screen.getByRole("region", NOTICE));
  await act(async () => {
    window.dispatchEvent(new Event("aiden:show-onboarding"));
  });
  await flush();
  await flush();
  assert.equal(screen.queryByRole("region", NOTICE), null);
});
