import assert from "node:assert/strict";
import { DEFAULT_ASSISTANT_CONFIG } from "../handlers/assistant-parse.js";
import test from "node:test";
import {
  AppControlsService,
  appControlRevision,
  newChatModelChoices,
  type AppControlState,
  type StoredAppOperation,
  type AppControlContext,
} from "./app-controls-core.js";
import {
  parseAppControlPanels,
  parseAppControlOperation,
} from "../../renderer/shared/app-controls.js";
import { aidenAppGuidance, readAidenHelp } from "./aiden-app-knowledge.js";

function fixture() {
  const state: AppControlState = {
    settings: { memoryEnabled: true },
    workspace: { id: "work", name: "Project", memoryEnabled: true },
  };
  let durable: StoredAppOperation[] = [];
  let commits = 0,
    current = true,
    crash = false;
  const service = new AppControlsService({
    read: async () => structuredClone(state),
    loadOperations: async () => structuredClone(durable),
    saveOperations: async (items) => {
      durable = structuredClone(items);
    },
    onChanged() {},
    commit: async (op, context) => {
      if (!context.isCurrent()) throw new Error("revoked");
      commits++;
      if (crash) throw new Error("interrupted publication");
      state.settings.memoryEnabled = op.value as boolean;
    },
  });
  const context: AppControlContext = {
    actor: "user",
    workspaceId: "work",
    target: "This desktop",
    humanGesture: true,
    isCurrent: () => current,
  };
  const operation = () => ({
    control: "memory.enabled",
    value: false,
    expectedRevision: appControlRevision(state, "memory.enabled"),
    operationId: "first",
  });
  return {
    state,
    service,
    context,
    operation,
    commits: () => commits,
    revoke: () => {
      current = false;
    },
    crash: () => {
      crash = true;
    },
  };
}
test("viewing controls and restoring descriptors never writes preferences", async () => {
  const f = fixture();
  const snapshot = await f.service.snapshot("memory", f.context);
  assert.deepEqual(
    snapshot.rows.map((row) => [row.label, row.value, row.scope]),
    [
      ["Memory", true, "This desktop"],
      ["Workspace memory", true, "Workspace — Project"],
    ],
  );
  const panel = { version: 1, id: "panel", topic: "memory", fallback: "Memory controls" };
  assert.equal(parseAppControlPanels([panel])?.[0].id, "panel");
  assert.equal(f.commits(), 0);
});
test("a duplicate operation returns its durable result without flipping again", async () => {
  const f = fixture(),
    operation = f.operation();
  assert.equal((await f.service.apply(operation, f.context)).status, "applied");
  assert.equal(f.state.settings.memoryEnabled, false);
  assert.equal((await f.service.apply(operation, f.context)).status, "applied");
  assert.equal(f.commits(), 1);
  assert.equal(
    (
      await f.service.apply(
        {
          operationId: operation.operationId,
          expectedRevision: operation.expectedRevision,
          value: operation.value,
          control: operation.control,
        },
        f.context,
      )
    ).status,
    "applied",
  );
  assert.equal(f.commits(), 1);
  await assert.rejects(f.service.apply({ ...operation, value: true }, f.context), /already used/u);
});
test("unknown effects retain intent and cannot run again after interrupted publication", async () => {
  const f = fixture(),
    operation = f.operation();
  f.crash();
  await assert.rejects(f.service.apply(operation, f.context), /interrupted/u);
  assert.equal((await f.service.apply(operation, f.context)).status, "outcome_unknown");
  assert.equal(f.commits(), 1);
});
test("stale revisions, revoked owners and read-only device grants deny effects", async () => {
  const f = fixture(),
    operation = f.operation();
  f.state.settings.memoryEnabled = false;
  await assert.rejects(f.service.apply(operation, f.context), /Settings changed/u);
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, allowedControls: new Set() }),
    /not authorized/u,
  );
  f.revoke();
  await assert.rejects(f.service.apply(f.operation(), f.context), /no longer available/u);
  assert.equal(f.commits(), 0);
});
test("Ask policy and enablement require a human gesture independently of workspace access", async () => {
  const f = fixture();
  f.state.settings.appControlPolicy = "ask";
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, humanGesture: false }),
    /confirmation/u,
  );
  f.state.settings.appControlPolicy = "safe";
  f.state.settings.memoryEnabled = false;
  await assert.rejects(
    f.service.apply({ ...f.operation(), value: true }, { ...f.context, humanGesture: false }),
    /confirmation/u,
  );
  f.state.settings.appControlPolicy = "disabled";
  assert.ok(
    (await f.service.snapshot("memory", f.context)).rows.every((row) => row.disabledReason),
  );
  await assert.rejects(f.service.apply(f.operation(), f.context), /not authorized/u);
});
test("paired clients need current serving-owner consent even with a valid control", async () => {
  const f = fixture();
  await assert.rejects(
    f.service.apply(f.operation(), { ...f.context, remote: true }),
    /Paired-host/u,
  );
  assert.equal(f.commits(), 0);
});
test("portable profile rejects executable or malformed descriptors and operations", () => {
  const panel = { version: 1, id: "id", topic: "memory", fallback: "Help" };
  assert.equal(parseAppControlPanels([{ ...panel, on: { mount: "execute" } }]), undefined);
  assert.equal(parseAppControlPanels([panel, panel]), undefined);
  assert.equal(
    parseAppControlPanels(Array.from({ length: 5 }, (_, n) => ({ ...panel, id: String(n) }))),
    undefined,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "provider.key",
        value: "secret",
        expectedRevision: "r",
        operationId: "o",
      }),
    /Invalid/u,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "memory.enabled",
        value: "false",
        expectedRevision: "r",
        operationId: "o",
      }),
    /boolean/u,
  );
  assert.throws(
    () =>
      parseAppControlOperation({
        control: "appearance.mode",
        value: "script",
        expectedRevision: "r",
        operationId: "o",
      }),
    /Unsupported/u,
  );
});
test("offline product help is bounded and cannot read arbitrary paths", () => {
  const help = readAidenHelp("how-agents-work");
  assert.equal(help.topics.length, 1);
  assert.ok(help.topics[0].text.includes("Pi"));
  assert.equal(readAidenHelp("unknown product topic").topics.length, 0);
  assert.throws(() => readAidenHelp("../../secrets"), /topic/u);
  assert.throws(() => readAidenHelp("a".repeat(257)), /topic/u);
});
test("product help finds topics from everyday wording, not only exact words", () => {
  const first = (query: string) => readAidenHelp(query).topics[0]?.id;
  assert.equal(first("Turn on dark mode please"), "appearance");
  assert.equal(first("how do I change the text size"), "appearance");
  assert.equal(first("what do you remember about me"), "memory");
  assert.equal(first("which model am I using"), "models");
  assert.equal(first("can you turn on voice dictation"), "voice");
  assert.equal(first("set up a bot routine"), "bots");
  // "mode" is not "model": matching is by whole word.
  assert.ok(!readAidenHelp("dark mode").topics.some((topic) => topic.id === "models"));
  // A miss still tells the agent which topics exist.
  const miss = readAidenHelp("unknown product topic");
  assert.deepEqual(miss.topics, []);
  assert.ok(miss.available.includes("changing-settings"));
  assert.match(readAidenHelp("changing-settings").topics[0].text, /Everything else stays in Settings/u);
});
test("app guidance only describes the app tools a chat really has", () => {
  const full = aidenAppGuidance(
    new Set(["aiden_help", "aiden_get_state", "aiden_show_controls", "aiden_set_preference", "aiden_open"]),
  );
  assert.match(full, /only settings you can change are the rows aiden_get_state returns/u);
  assert.match(full, /aiden_open/u);
  // A phone chat has help and panels only.
  const phone = aidenAppGuidance(new Set(["aiden_help", "aiden_show_controls"]));
  assert.doesNotMatch(phone, /aiden_get_state|aiden_set_preference|aiden_open/u);
  assert.match(phone, /cannot read live values or change settings yourself in this chat; show the controls/u);
  // Reading without changing: told to read live values, and only that it cannot change them.
  const readOnly = aidenAppGuidance(new Set(["aiden_help", "aiden_get_state"]));
  assert.match(readOnly, /aiden_get_state before stating a value/u);
  assert.match(readOnly, /cannot change settings yourself in this chat\./u);
  assert.doesNotMatch(readOnly, /cannot read live values/u);
});

test("authorization is rechecked after the durable intent and unknown policy fails closed", async () => {
  const f = fixture();
  let checks = 0;
  await assert.rejects(
    f.service.apply(f.operation(), {
      ...f.context,
      authorize: async () => {
        if (++checks === 2) throw new Error("authority changed");
      },
    }),
    /authority changed/,
  );
  assert.equal(f.commits(), 0);
  assert.equal((await f.service.apply(f.operation(), f.context)).status, "outcome_unknown");
  const legacy = fixture();
  legacy.state.settings.assistant = { ...DEFAULT_ASSISTANT_CONFIG, settingsPermission: "none" };
  assert.equal((await legacy.service.snapshot("memory", legacy.context)).policy, "disabled");
  legacy.state.settings.remoteAppControlsEnabled = true;
  assert.equal((await legacy.service.snapshot("memory", legacy.context)).policy, "disabled");
  await assert.rejects(legacy.service.apply(legacy.operation(), legacy.context), /not authorized/u);
  assert.equal(legacy.commits(), 0);
  legacy.state.settings.appControlPolicy = "safe";
  assert.equal((await legacy.service.snapshot("memory", legacy.context)).policy, "safe");
  const unknown = fixture();
  unknown.state.settings.appControlPolicy = "future-policy" as "safe";
  await assert.rejects(
    unknown.service.apply(unknown.operation(), unknown.context),
    /not authorized/,
  );
});

test("new-chat model choices list ready, visible models with pinned and recent first", () => {
  const choices = newChatModelChoices(
    [
      { id: "lmstudio", label: "LM Studio", models: ["qwen3-8b", "llama-4"], hasKey: false, needsKey: false },
      { id: "openai", label: "OpenAI", models: ["gpt-5.5"], hasKey: true, needsKey: true },
      { id: "anthropic", label: "Anthropic", models: ["claude-x"], hasKey: false, needsKey: true },
    ],
    {
      hiddenModelsByProvider: { lmstudio: ["llama-4"] },
      pinnedModels: ["openai::gpt-5.5"],
      recentModels: ["anthropic::claude-x", "lmstudio::qwen3-8b"],
    },
  );
  assert.deepEqual(choices.options, [
    { value: "openai::gpt-5.5", label: "OpenAI · gpt-5.5" },
    { value: "lmstudio::qwen3-8b", label: "LM Studio · qwen3-8b" },
  ]);
  // A provider without its key is not ready; a hidden model is not offered.
  assert.equal(choices.selectable.has("anthropic::claude-x"), false);
});

test("new-chat model choices leave out embedding and reranking models", async () => {
  const choices = newChatModelChoices(
    [
      {
        id: "custom",
        label: "Custom",
        models: ["chat-a", "text-embedding-nomic-embed-text-v1.5", "bge-reranker-v2-m3", "vision-x"],
        hasKey: true,
        needsKey: true,
        modelMetadata: { "vision-x": { type: "image" } },
      },
    ],
    {},
  );
  assert.deepEqual([...choices.selectable], ["custom::chat-a"]);
  assert.deepEqual(choices.options.map((option) => option.value), ["custom::chat-a"]);
  // And the control refuses one even when asked by value.
  const state: AppControlState = { settings: { appControlPolicy: "safe" }, newChatModels: choices };
  const service = new AppControlsService({
    read: async () => structuredClone(state),
    loadOperations: async () => [],
    saveOperations: async () => {},
    onChanged() {},
    commit: async () => assert.fail("a non-chat model must never be committed"),
  });
  const user: AppControlContext = { actor: "user", target: "This desktop", humanGesture: true, isCurrent: () => true };
  await assert.rejects(
    service.apply(
      {
        control: "models.newChat",
        value: "custom::text-embedding-nomic-embed-text-v1.5",
        expectedRevision: appControlRevision(state, "models.newChat"),
        operationId: "op-embed",
      },
      user,
    ),
    /not available for new chats/u,
  );
});

test("theme and new-chat model controls: custom colors need a click, unknown models are refused, phones never see them", async () => {
  const { getPresetVariant, normalizeAppearanceConfig } = await import("../../renderer/shared/appearance.js");
  const appearance = normalizeAppearanceConfig(undefined);
  const state: AppControlState = {
    settings: {
      appControlPolicy: "safe",
      lastProviderId: "lmstudio",
      lastModel: "qwen3-8b",
      appearance: { ...appearance, light: { ...getPresetVariant("aiden", "light"), preset: "custom", accent: "#123456" } },
    },
    newChatModels: { options: [{ value: "lmstudio::qwen3-8b", label: "LM Studio · qwen3-8b" }], selectable: new Set(["lmstudio::qwen3-8b"]) },
  };
  let commits = 0;
  const service = new AppControlsService({
    read: async () => structuredClone(state),
    loadOperations: async () => [],
    saveOperations: async () => {},
    onChanged() {},
    commit: async () => {
      commits++;
    },
  });
  const agent: AppControlContext = { actor: "agent", target: "This desktop", humanGesture: false, isCurrent: () => true };
  const appearanceRows = await service.snapshot("appearance", agent);
  const theme = appearanceRows.rows.find((row) => row.id === "appearance.theme")!;
  assert.equal(theme.value, "custom");
  assert.ok(theme.options?.some((option) => option.value === "moss"));
  await assert.rejects(
    service.apply({ control: "appearance.theme", value: "moss", expectedRevision: theme.revision, operationId: "t" }, agent),
    /foreground confirmation/u,
  );
  const model = (await service.snapshot("models", agent)).rows[0];
  assert.equal(model.value, "lmstudio::qwen3-8b");
  await assert.rejects(
    service.apply({ control: "models.newChat", value: "openai::nope", expectedRevision: model.revision, operationId: "m" }, agent),
    /not available for new chats/u,
  );
  assert.equal(commits, 0);
  // Paired phones reject cards with rows they do not know, so they get the v1 rows only.
  const phone = await service.snapshot("appearance", { ...agent, remote: true });
  assert.deepEqual(phone.rows.map((row) => row.id), ["appearance.mode", "appearance.chatWidth", "appearance.reduceMotion"]);
  assert.deepEqual((await service.snapshot("models", { ...agent, remote: true })).rows, []);
});
