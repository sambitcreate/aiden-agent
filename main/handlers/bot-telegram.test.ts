import assert from "node:assert/strict";
import test from "node:test";
import { BotMutationGate } from "../services/bot-mutation-gate.js";
import type { TelegramBotBinding, TelegramBotBindingInput } from "../services/telegram/telegram-bot-binding-store.js";
import {
  TELEGRAM_PROFILE_CHANGED_MESSAGE,
  TelegramProfileMutationFence,
} from "../services/telegram/telegram-profile-mutation-fence.js";
import { WorkspaceMutationGate } from "../services/workspace-mutation-gate.js";
import {
  registerBotTelegramHandlers,
  type BotTelegramHandlerDependencies,
  type BotTelegramProfile,
  type BotTelegramTarget,
} from "./bot-telegram.js";

const OWNER = 4242;
const BACKING_CHAT = "chat-backing-sentinel";
const BOT_HOME = "ws-bot-home";

const PROFILES: BotTelegramProfile[] = [
  {
    name: "work",
    hasToken: true,
    settings: {
      enabled: true,
      allowedUserId: OWNER,
      workspaceId: "ws-direct",
      providerId: "provider-telegram",
      model: "model-telegram",
    },
  },
  { name: "unpaired", hasToken: true, settings: { workspaceId: "ws-direct" } },
  { name: "tokenless", hasToken: false, settings: { allowedUserId: OWNER, workspaceId: "ws-direct" } },
];
const TARGETS: Record<string, BotTelegramTarget[]> = {
  work: [
    { threadId: 9, chatId: OWNER, name: "Research", workspaceId: "ws-thread" },
    { threadId: 10, chatId: 777, name: "Someone else's group", workspaceId: "ws-thread" },
    { threadId: 11, chatId: OWNER, name: "Unplaced" },
  ],
};

interface ExistingChat {
  botId?: string;
  workspaceId?: string;
}

function setup(options: {
  existingChat?: ExistingChat;
  chatPolicyBotId?: string;
  createChat?: (input: { assertCurrent?: () => void }) => Promise<void>;
  botMutationUnavailable?: boolean;
} = {}) {
  const events: string[] = [];
  const bound: TelegramBotBindingInput[] = [];
  const createdChats: Array<Record<string, unknown>> = [];
  const disabled: string[] = [];
  const mutatedBots: string[] = [];
  const fence = new TelegramProfileMutationFence();
  const workspaceGate = new WorkspaceMutationGate();
  const botMutationGate = new BotMutationGate();
  const service = {
    async withBotMutation<Result>(
      botId: string,
      action: (operations: {
        createChat(input: Record<string, unknown>): Promise<unknown>;
        managedWorkspace: { workspaceId: string };
      }) => Promise<Result>,
    ): Promise<Result> {
      if (options.botMutationUnavailable) throw new Error("Bot storage is unavailable.");
      mutatedBots.push(botId);
      events.push("mutation:start");
      try {
        return await action({
          createChat: async (input) => {
            createdChats.push({ ...input, botId });
            await options.createChat?.(input as { assertCurrent?: () => void });
            (input.assertCurrent as (() => void) | undefined)?.();
            return { id: input.chatId, botId };
          },
          managedWorkspace: { workspaceId: BOT_HOME },
        });
      } finally {
        events.push("mutation:end");
      }
    },
    async getChatAccess(chatId: string) {
      events.push(`policy:${chatId}`);
      return { botId: options.chatPolicyBotId ?? "bot-1" };
    },
  };
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerBotTelegramHandlers<unknown>({
    handle: (channel, handler) => handlers.set(channel, handler),
    service: service as unknown as BotTelegramHandlerDependencies<unknown>["service"],
    telegram: {
      listProfiles: async () => PROFILES,
      listTargets: async (profile) => TARGETS[profile] ?? [],
    },
    bindings: {
      get: async () => null,
      bind: async (input) => {
        bound.push(input);
        return {
          ...input,
          backingChatId: BACKING_CHAT,
          createdAt: 1,
          updatedAt: 1,
          enabled: true,
        } satisfies TelegramBotBinding;
      },
    },
    bindingAuthority: {
      disableBot: async (botId) => {
        disabled.push(botId);
        events.push(`disable:${botId}`);
        return {} as TelegramBotBinding;
      },
    },
    profileFence: fence,
    botMutationGate,
    workspaceGate,
    workspaces: {
      list: async () => [
        { id: "ws-direct", name: "Direct" },
        { id: "ws-thread", name: "Thread" },
      ],
      get: async (workspaceId) => (workspaceId.startsWith("ws-") ? { id: workspaceId } : undefined),
    },
    chats: { get: async () => options.existingChat ?? null },
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    return Promise.resolve().then(() => handler({}, ...args));
  };
  return {
    invoke,
    bound,
    createdChats,
    disabled,
    mutatedBots,
    events,
    fence,
    workspaceGate,
    botMutationGate,
  };
}

test("a direct-message binding targets the paired owner and creates the backing chat inside the Bot mutation", async () => {
  const { invoke, bound, createdChats, mutatedBots, events } = setup();
  const binding = (await invoke("bots:bindTelegram", { botId: "bot-1", profile: "Work" })) as TelegramBotBinding;
  assert.equal(binding.backingChatId, BACKING_CHAT);
  assert.deepEqual(mutatedBots, ["bot-1"]);
  assert.deepEqual(bound, [
    {
      botId: "bot-1",
      profile: "work",
      chatId: OWNER,
      ownerUserId: OWNER,
      workspaceId: "ws-direct",
      backingWorkspaceId: BOT_HOME,
    },
  ]);
  assert.equal(createdChats.length, 1);
  const { assertCurrent, ...chat } = createdChats[0]!;
  assert.equal(typeof assertCurrent, "function");
  assert.deepEqual(chat, {
    audienceId: `telegram:work:owner:${OWNER}`,
    chatId: BACKING_CHAT,
    providerId: "provider-telegram",
    model: "model-telegram",
    botId: "bot-1",
  });
  assert.deepEqual(events, ["mutation:start", "mutation:end"]);
});

test("a thread binding only accepts the paired owner's own placed thread", async () => {
  const { invoke, bound } = setup();
  await invoke("bots:bindTelegram", { botId: "bot-1", profile: "work", threadId: 9 });
  assert.deepEqual(bound.map(({ chatId, threadId, workspaceId }) => ({ chatId, threadId, workspaceId })), [
    { chatId: OWNER, threadId: 9, workspaceId: "ws-thread" },
  ]);

  bound.length = 0;
  await assert.rejects(
    invoke("bots:bindTelegram", { botId: "bot-1", profile: "work", threadId: 10 }),
    /no longer available/u,
  );
  await assert.rejects(
    invoke("bots:bindTelegram", { botId: "bot-1", profile: "work", threadId: 11 }),
    /live folder workspace/u,
  );
  for (const malformed of [
    { botId: "bot-1", profile: "work", chatId: 777 },
    { botId: "bot-1", profile: "work", threadId: 0 },
    { botId: "bot-1", profile: "work", threadId: "9" },
    { botId: "../bot", profile: "work" },
    ["bot-1", "work"],
  ]) {
    await assert.rejects(invoke("bots:bindTelegram", malformed), Error, JSON.stringify(malformed));
  }
  assert.deepEqual(bound, [], "no forged or foreign target reaches the binding store");
});

test("binding requires a profile with both a token and a paired owner", async () => {
  const { invoke, bound } = setup();
  for (const profile of ["unpaired", "tokenless", "absent"]) {
    await assert.rejects(
      invoke("bots:bindTelegram", { botId: "bot-1", profile }),
      /token and paired owner/u,
    );
  }
  assert.deepEqual(bound, []);
});

test("an existing backing chat is reused only when it belongs to the same Bot home and policy", async () => {
  const reused = setup({ existingChat: { botId: "bot-1", workspaceId: BOT_HOME } });
  await reused.invoke("bots:bindTelegram", { botId: "bot-1", profile: "work" });
  assert.deepEqual(reused.createdChats, []);
  assert.deepEqual(reused.disabled, []);
  assert.ok(reused.events.includes(`policy:${BACKING_CHAT}`));

  for (const [label, fixture, message] of [
    ["another Bot", { existingChat: { botId: "bot-2", workspaceId: BOT_HOME } }, /different backing home/u],
    ["another home", { existingChat: { botId: "bot-1", workspaceId: "ws-other" } }, /different backing home/u],
    [
      "another policy",
      { existingChat: { botId: "bot-1", workspaceId: BOT_HOME }, chatPolicyBotId: "bot-2" },
      /invalid access state/u,
    ],
  ] as const) {
    const context = setup(fixture);
    await assert.rejects(context.invoke("bots:bindTelegram", { botId: "bot-1", profile: "work" }), message, label);
    assert.deepEqual(context.disabled, ["bot-1"], `${label} rolls the new binding back`);
    assert.deepEqual(context.createdChats, []);
  }
});

test("a profile reset or workspace change during binding fences the backing chat and rolls back", async () => {
  let reset: Promise<unknown> | undefined;
  const profileChanged = setup({
    createChat: async () => {
      // Reset/delete invalidates synchronously, before its serialized lane runs.
      reset = profileChangedFence().runDestructive("work", async () => "reset");
    },
  });
  const profileChangedFence = () => profileChanged.fence;
  await assert.rejects(
    profileChanged.invoke("bots:bindTelegram", { botId: "bot-1", profile: "work" }),
    { message: TELEGRAM_PROFILE_CHANGED_MESSAGE },
  );
  assert.deepEqual(profileChanged.disabled, ["bot-1"]);
  assert.equal(await reset, "reset", "the destructive mutation runs after the binding settles");

  let release: (() => void) | undefined;
  const workspaceChanged = setup({
    createChat: async () => {
      release = workspaceChangedGate().begin("ws-direct");
    },
  });
  const workspaceChangedGate = () => workspaceChanged.workspaceGate;
  await assert.rejects(
    workspaceChanged.invoke("bots:bindTelegram", { botId: "bot-1", profile: "work" }),
    /workspace changed before binding completed/u,
  );
  assert.deepEqual(workspaceChanged.disabled, ["bot-1"]);
  release?.();
  // The admission was released, so the workspace can change again afterwards.
  workspaceChanged.workspaceGate.begin("ws-direct")();
});

test("unbinding narrows authority even when Bot mutation is unavailable, serialized per Bot", async () => {
  const { invoke, disabled, mutatedBots, botMutationGate } = setup({ botMutationUnavailable: true });
  let finishRunning: () => void = () => {};
  const running = botMutationGate.run("bot-1", () => new Promise<void>((resolve) => {
    finishRunning = resolve;
  }));
  const unbinding = invoke("bots:unbindTelegram", "bot-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(disabled, [], "unbind waits for the in-flight Bot lifecycle mutation");
  finishRunning();
  await running;
  await unbinding;
  assert.deepEqual(disabled, ["bot-1"]);
  assert.deepEqual(mutatedBots, [], "unbinding never needs Bot application admission");
  await assert.rejects(invoke("bots:unbindTelegram", "../bot"), /bot id/u);
});

test("binding targets list paired direct messages and placed threads with workspace names", async () => {
  const { invoke } = setup();
  const options = (await invoke("bots:listTelegramTargets")) as Array<Record<string, unknown>>;
  const work = options.filter((option) => option.profile === "work");
  assert.deepEqual(
    work.map(({ label, chatId, threadId, workspaceName }) => ({ label, chatId, threadId, workspaceName })),
    [
      { label: "work · Direct message", chatId: OWNER, threadId: undefined, workspaceName: "Direct" },
      { label: "work · Research", chatId: OWNER, threadId: 9, workspaceName: "Thread" },
      { label: "work · Someone else's group", chatId: 777, threadId: 10, workspaceName: "Thread" },
      { label: "work · Unplaced", chatId: OWNER, threadId: 11, workspaceName: undefined },
    ],
  );
  assert.equal(
    options.some((option) => option.profile === "unpaired" && String(option.label).endsWith("Direct message")),
    false,
    "an unpaired profile offers no direct-message target",
  );
});
