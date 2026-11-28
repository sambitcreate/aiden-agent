import assert from "node:assert/strict";
import test from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MCP_PRESETS, presetServerId } from "../mcp-presets.js";
import type { StoredProvider } from "../types.js";
import {
  reportChatMessageSent,
  reportConnectorAdded,
  reportCustomProviderConnected,
  reportDesignCommentsSent,
} from "./analytics-feature-reports.js";
import {
  analyticsModelId,
  analyticsProviderId,
  analyticsRunTrigger,
  analyticsWorkspaceKind,
} from "./analytics-ids.js";
import { analyticsSettled, captureAnalyticsEvents } from "./test-support.js";
import { reportAnalyticsEvent, setAnalyticsReporter } from "./analytics-report.js";
import { goalRoundBucket } from "../../../renderer/shared/goal.js";

test("a built-in provider and its catalog model are sent, folded to the registry's lowercase", () => {
  assert.equal(analyticsProviderId("anthropic"), "anthropic");
  assert.equal(analyticsModelId("anthropic", "not-a-listed-model"), "custom");
  const listed = builtinProviders()
    .flatMap((provider) =>
      provider.getModels().map((model) => ({ provider: provider.id, id: model.id })),
    )
    .find((model) => /^[A-Z]/u.test(model.id) && model.id.length < 80);
  assert.ok(listed, "the bundled catalog carries a mixed-case model id");
  assert.equal(analyticsModelId(listed.provider, listed.id), listed.id.toLowerCase());
});

test("names and addresses a person chose never leave as an id", () => {
  for (const value of [
    "my-private-gateway",
    "https://llm.example.test/v1",
    "/Users/person/model",
    "",
    undefined,
  ]) {
    assert.equal(analyticsProviderId(value as string), "custom");
    assert.equal(analyticsModelId("anthropic", value as string), "custom");
    assert.equal(analyticsModelId(value as string, "gpt-5.4"), "custom");
  }
});

test("a workspace is named by its kind, and a hidden No workspace folder is not a workspace", () => {
  assert.equal(analyticsWorkspaceKind({}), "folder");
  assert.equal(analyticsWorkspaceKind({ scratch: true }), "scratch");
  assert.equal(analyticsWorkspaceKind({ noWorkspace: true, scratch: true }), "none");
  assert.equal(analyticsWorkspaceKind(undefined), "none");
});

test("an event-started run is named by its source", () => {
  assert.equal(analyticsRunTrigger({ kind: "manual", key: "k" }), "manual");
  assert.equal(analyticsRunTrigger({ kind: "automatic", fireTime: 1 }), "automatic");
});

test("a sent message reports registry-valid properties and never waits on the workspace lookup", async (t) => {
  const sent = captureAnalyticsEvents(t);
  let finishLookup!: (inWorkspace: boolean) => void;
  reportChatMessageSent({
    providerId: "my-private-gateway",
    model: "secret-model",
    thinkingLevel: "high",
    origin: "desktop",
    inWorkspace: () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
  });
  await analyticsSettled();
  assert.deepEqual(sent, [], "the send has already returned; the report follows the lookup");
  finishLookup(true);
  await analyticsSettled();
  assert.deepEqual(sent, [
    {
      event: "chat_message_sent",
      props: {
        provider_id: "custom",
        model_id: "custom",
        in_workspace: true,
        thinking: "high",
        origin: "desktop",
      },
    },
  ]);
});

test("a workspace lookup that fails still counts the message, as outside a workspace", async (t) => {
  const sent = captureAnalyticsEvents(t);
  reportChatMessageSent({
    providerId: "anthropic",
    model: "unlisted",
    origin: "phone",
    inWorkspace: async () => {
      throw new Error("config unreadable");
    },
  });
  await analyticsSettled();
  assert.deepEqual(sent, [
    {
      event: "chat_message_sent",
      props: {
        provider_id: "anthropic",
        model_id: "custom",
        in_workspace: false,
        thinking: "other",
        origin: "phone",
      },
    },
  ]);
});

test("a person's own provider is only ever custom, and a loopback or keyless one is local", (t) => {
  const sent = captureAnalyticsEvents(t);
  const provider = (fields: Partial<StoredProvider>) =>
    ({
      id: "p",
      kind: "openai",
      label: "Office gateway",
      baseUrl: "https://llm.example.test/v1",
      models: [],
      needsKey: true,
      ...fields,
    }) as StoredProvider;
  reportCustomProviderConnected(provider({}));
  reportCustomProviderConnected(provider({ baseUrl: "http://127.0.0.1:11434/v1" }));
  reportCustomProviderConnected(provider({ needsKey: false }));
  assert.deepEqual(
    sent.map((entry) => entry.props),
    [
      { provider_id: "custom", auth: "key" },
      { provider_id: "custom", auth: "local" },
      { provider_id: "custom", auth: "local" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(sent), /Office gateway|example\.test/u);
});

test("a connector from the catalog sends its preset id, and a person's own sends custom", (t) => {
  const sent = captureAnalyticsEvents(t);
  const preset = MCP_PRESETS[0]!;
  reportConnectorAdded({ id: presetServerId(preset.id), transport: "http" });
  reportConnectorAdded({ id: "my-own-server", transport: "stdio" });
  assert.deepEqual(sent, [
    { event: "connector_added", props: { preset_id: preset.id.toLowerCase(), transport: "http" } },
    { event: "connector_added", props: { preset_id: "custom", transport: "stdio" } },
  ]);
});

/** Four stops: two efforts of one model, an unassigned stop and a second model. */
const FOUR_STOP_SLIDER = {
  version: 1,
  stops: [
    {
      id: "stop_00000001",
      label: "Quick",
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "low",
    },
    {
      id: "stop_00000002",
      label: "Careful",
      providerId: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    },
    { id: "stop_00000003", label: "Later" },
    {
      id: "stop_00000004",
      label: "Private",
      providerId: "my-private-gateway",
      model: "secret-model",
    },
  ],
  homeStopId: "stop_00000002",
};

async function sliderProps(
  t: Parameters<typeof captureAnalyticsEvents>[0],
  sent: { providerId: string; model: string; thinkingLevel?: "low" | "high" },
  read:
    | Awaited<ReturnType<NonNullable<Parameters<typeof reportChatMessageSent>[0]["agentSlider"]>>>
    | Error,
) {
  const events = captureAnalyticsEvents(t);
  reportChatMessageSent({
    ...sent,
    origin: "desktop",
    inWorkspace: () => false,
    agentSlider: async () => {
      if (read instanceof Error) throw read;
      return read;
    },
  });
  await analyticsSettled();
  assert.equal(events.length, 1);
  return events[0]!.props;
}

test("a chat on a stop reports that stop, 1-based, and how many stops there are", async (t) => {
  const props = await sliderProps(
    t,
    { providerId: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "high" },
    { slider: FOUR_STOP_SLIDER, chatThinkingLevel: "high" },
  );
  assert.equal(props?.slider_stop, "2");
  assert.equal(props?.slider_stop_count, 4);
  assert.equal(props?.thinking, "high");
  assert.doesNotMatch(JSON.stringify(props), /Careful|stop_0/u);
});

test("the chat's own level picks the stop, and a private model's stop sends only its number", async (t) => {
  // Sent with the per-model level, but the chat itself has no level: no stop of this model matches.
  const custom = await sliderProps(
    t,
    { providerId: "anthropic", model: "claude-sonnet-4-5", thinkingLevel: "low" },
    { slider: FOUR_STOP_SLIDER },
  );
  assert.equal(custom?.slider_stop, "custom");
  assert.equal(custom?.slider_stop_count, 4);

  const privateStop = await sliderProps(
    t,
    { providerId: "my-private-gateway", model: "secret-model" },
    { slider: FOUR_STOP_SLIDER },
  );
  assert.equal(privateStop?.slider_stop, "4");
  assert.equal(privateStop?.provider_id, "custom");
  assert.doesNotMatch(JSON.stringify(privateStop), /my-private-gateway|secret-model|Private/u);
});

test("without a readable slider the message is still counted, with no slider properties", async (t) => {
  for (const read of [
    undefined,
    { slider: undefined },
    {
      slider: {
        version: 1,
        stops: [{ id: "stop_00000001", label: "Only one" }],
        homeStopId: "stop_00000001",
      },
    },
    new Error("config unreadable"),
  ]) {
    const props = await sliderProps(
      t,
      { providerId: "anthropic", model: "claude-sonnet-4-5" },
      read,
    );
    assert.equal(props?.origin, "desktop");
    assert.equal("slider_stop" in (props ?? {}), false);
    assert.equal("slider_stop_count" in (props ?? {}), false);
  }
});

test("a delayed message cannot move to a replacement analytics sender", async (t) => {
  const first = captureAnalyticsEvents(t);
  let finish!: (value: boolean) => void;
  const workspace = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  reportChatMessageSent({
    providerId: "anthropic",
    model: "unlisted",
    origin: "desktop",
    inWorkspace: () => workspace,
  });
  const replacement = captureAnalyticsEvents(t);
  finish(true);
  await analyticsSettled();
  assert.deepEqual(first, []);
  assert.deepEqual(replacement, []);
  reportChatMessageSent({
    providerId: "anthropic",
    model: "unlisted",
    origin: "desktop",
    inWorkspace: () => false,
  });
  await analyticsSettled();
  assert.equal(replacement.length, 1);
});

test("an action before any sender exists cannot be reported by a sender registered later", async (t) => {
  setAnalyticsReporter(undefined);
  let finish!: (value: boolean) => void;
  const workspace = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  reportChatMessageSent({
    providerId: "anthropic",
    model: "unlisted",
    origin: "desktop",
    inWorkspace: () => workspace,
  });
  const later = captureAnalyticsEvents(t);
  finish(true);
  await analyticsSettled();
  assert.deepEqual(later, []);
});

test("a message carrying design comments reports only how many, from the person's latest message", (t) => {
  const events = captureAnalyticsEvents(t);
  const block = (count: number) =>
    `<attached-design-comments>\nComments the person made.\n${JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        commentId: `c${index}`,
        note: "Make the button primary at /Users/person",
      })),
    )}\n</attached-design-comments>`;
  reportDesignCommentsSent([{ role: "user", content: `Fix these\n\n${block(3)}` }]);
  reportDesignCommentsSent([
    { role: "user", content: block(12) },
    { role: "assistant", content: "Done." },
    { role: "user", content: "Thanks, nothing attached this time" },
  ]);
  reportDesignCommentsSent([{ role: "user", content: block(1) }]);
  assert.deepEqual(events, [
    { event: "design_comments_sent", props: { count_bucket: "2-3" } },
    { event: "design_comments_sent", props: { count_bucket: "1" } },
  ]);
});

test("goal events carry only their source, outcome and round bucket", async (t) => {
  const events = captureAnalyticsEvents(t);
  reportAnalyticsEvent("goal_started", { source: "menu" });
  reportAnalyticsEvent("goal_settled", { outcome: "paused", rounds: goalRoundBucket(50) });
  reportAnalyticsEvent("goal_settled", { outcome: "done", rounds: goalRoundBucket(7) });
  // An objective or a raw count is never a property the registry keeps.
  reportAnalyticsEvent("goal_started", { source: "Ship the release" } as never);
  reportAnalyticsEvent("goal_settled", { outcome: "done", rounds: "37" } as never);
  await analyticsSettled();
  assert.deepEqual(events, [
    { event: "goal_started", props: { source: "menu" } },
    { event: "goal_settled", props: { outcome: "paused", rounds: "50" } },
    { event: "goal_settled", props: { outcome: "done", rounds: "6-10" } },
    { event: "goal_started", props: undefined },
    { event: "goal_settled", props: undefined },
  ]);
});
