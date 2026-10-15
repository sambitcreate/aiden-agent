import assert from "node:assert/strict";
import test from "node:test";
import { BOT_FULL_ACCESS_NOTICE_VERSION } from "../../renderer/shared/bot-capabilities.js";
import { BotCapabilityRevisionConflictError } from "../services/bot-capability-store-core.js";
import { BotRuntimeInventoryLeaseInvalidError } from "../services/bot-runtime-inventory-lease.js";
import {
  registerBotAccessHandlers,
  type BotAccessHandlerDependencies,
  type BotAccessTelegramProfile,
} from "./bot-access.js";
import { BOT_CREATE_RETRY_MESSAGE } from "./bot-renderer-errors.js";

interface FakeEvent {
  document: { destroyed: boolean } | null;
}

const DESKTOP = "desktop:sentinel-audience";
const BOT_FIELDS = {
  name: "Reviewer",
  description: "Checks work",
  instructions: "Be precise.",
  avatar: { version: 1 as const, shape: "hex" as const, color: "sun" as const },
};
const FULL_ACCESS = {
  accessMode: "full" as const,
  catalogRevision: "bot_catalog_deadbeef",
  confirmedForeground: true,
  providerId: "bc_provider_9zzLPOGDo0Cdjuvu6xdhjutPM",
  modelId: "bc_model_I_zCzuPPxmjgUmte8tPqPAs1",
};
const ACKNOWLEDGEMENT = {
  version: BOT_FULL_ACCESS_NOTICE_VERSION,
  decision: "continue_full" as const,
  confirmedForeground: true as const,
};

function setup(options: {
  profiles?: BotAccessTelegramProfile[];
  createBot?: () => Promise<unknown>;
  updateBotAccess?: () => Promise<unknown>;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const warnings: string[] = [];
  const record = (method: string, result: (...args: unknown[]) => unknown = () => ({ method })) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result(...args);
    };
  const service = {
    noticeStatus: record("noticeStatus", (audienceId) => ({ audienceId, acknowledged: false })),
    acknowledgeNotice: record("acknowledgeNotice", (audienceId, _ack, assertCurrent) => {
      (assertCurrent as () => void)();
      return { audienceId, acknowledged: true };
    }),
    createBot: record("createBot", options.createBot ?? (() => ({ id: "bot-created" }))),
    capabilityCatalog: record("capabilityCatalog", () => ({ revision: "catalog" })),
    getBotAccess: record("getBotAccess", () => ({ revision: "policy" })),
    modelSelection: record("modelSelection", () => ({ providerId: "p", modelId: "m" })),
    visionModelSelection: record("visionModelSelection", () => undefined),
    updateBotAccess: record("updateBotAccess", options.updateBotAccess ?? (() => ({ revision: "next" }))),
  };
  const handlers = new Map<string, (event: FakeEvent, ...args: unknown[]) => unknown>();
  registerBotAccessHandlers<FakeEvent>({
    handle: (channel, handler) => handlers.set(channel, handler),
    service: service as unknown as BotAccessHandlerDependencies<FakeEvent>["service"],
    desktopAudienceId: DESKTOP,
    documentOwner: (event) => {
      const document = event.document;
      if (!document) throw new Error("Bot access notice requires the active application document.");
      return { isDestroyed: () => document.destroyed };
    },
    telegramProfiles: async () => options.profiles ?? [],
    warn: (message) => warnings.push(message),
  });
  const liveEvent = (): FakeEvent => ({ document: { destroyed: false } });
  const invoke = (channel: string, ...args: unknown[]) => invokeFrom(liveEvent(), channel, ...args);
  const invokeFrom = (event: FakeEvent, channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `${channel} is registered`);
    return Promise.resolve().then(() => handler(event, ...args));
  };
  const audiences = (method: string) =>
    calls.filter((call) => call.method === method).map((call) => call.args[0]);
  return { calls, warnings, invoke, invokeFrom, audiences };
}

test("Bot creation acts as the desktop audience and refuses a renderer-named audience", async () => {
  const { calls, invoke } = setup();
  assert.deepEqual(await invoke("bots:create", { bot: BOT_FIELDS, access: FULL_ACCESS }), {
    id: "bot-created",
  });
  assert.deepEqual(calls, [
    {
      method: "createBot",
      args: [{ audienceId: DESKTOP, bot: BOT_FIELDS, access: FULL_ACCESS }],
    },
  ]);

  calls.length = 0;
  for (const forged of [
    { bot: BOT_FIELDS, access: FULL_ACCESS, audienceId: "telegram:work:owner:1" },
    { bot: { ...BOT_FIELDS, systemPrompt: "forged" }, access: FULL_ACCESS },
    { bot: BOT_FIELDS, access: FULL_ACCESS, chatId: "chat-forged" },
  ]) {
    await assert.rejects(invoke("bots:create", forged), Error, JSON.stringify(forged));
  }
  assert.deepEqual(calls, [], "malformed creation never reaches the Bot application service");
});

test("Bot creation failures cross IPC as renderer recovery guidance", async () => {
  const { invoke, warnings } = setup({
    createBot: () => {
      throw new BotRuntimeInventoryLeaseInvalidError();
    },
  });
  await assert.rejects(invoke("bots:create", { bot: BOT_FIELDS, access: FULL_ACCESS }), {
    message: BOT_CREATE_RETRY_MESSAGE,
  });
  assert.deepEqual(warnings, ["Bot creation failed."]);
});

test("the Bot editor reads catalog, access, and models as the desktop audience", async () => {
  const { calls, invoke, audiences } = setup();
  await invoke("bots:getCapabilityCatalog", undefined);
  await invoke("bots:getCapabilityCatalog", "bot-1");
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [DESKTOP, undefined],
      [DESKTOP, "bot-1"],
    ],
  );
  await assert.rejects(invoke("bots:getCapabilityCatalog", "../bot"), /bot id/u);

  calls.length = 0;
  assert.deepEqual(await invoke("bots:getBotAccess", "bot-1"), {
    access: { revision: "policy" },
    modelSelection: { providerId: "p", modelId: "m" },
    visionModelSelection: undefined,
  });
  assert.deepEqual(audiences("modelSelection"), [DESKTOP]);
  assert.deepEqual(audiences("visionModelSelection"), [DESKTOP]);
  assert.deepEqual(audiences("getBotAccess"), ["bot-1"]);
});

test("Bot access updates are revisioned, desktop-owned, and exact", async () => {
  const { calls, invoke } = setup();
  const update = { botId: "bot-1", expectedRevision: "revision:policy:16", access: FULL_ACCESS };
  await invoke("bots:updateBotAccess", update);
  assert.deepEqual(calls, [
    { method: "updateBotAccess", args: [{ audienceId: DESKTOP, ...update }] },
  ]);

  calls.length = 0;
  await assert.rejects(
    invoke("bots:updateBotAccess", { ...update, audienceId: "telegram:work:owner:1" }),
    /Invalid bot access update fields/u,
  );
  await assert.rejects(
    invoke("bots:updateBotAccess", { botId: "bot-1", access: FULL_ACCESS }),
    /bot revision/u,
  );
  assert.deepEqual(calls, []);
});

test("Bot access update conflicts become refresh guidance instead of raw service errors", async () => {
  const { invoke } = setup({
    updateBotAccess: () => {
      throw new BotCapabilityRevisionConflictError("revision:policy:17");
    },
  });
  await assert.rejects(
    invoke("bots:updateBotAccess", {
      botId: "bot-1",
      expectedRevision: "revision:policy:16",
      access: FULL_ACCESS,
    }),
    { message: "This Bot changed. Refresh it before trying again." },
  );
});

test("the desktop one-time notice is read and acknowledged only as the desktop audience", async () => {
  const { calls, invoke, invokeFrom, audiences } = setup();
  assert.deepEqual(await invoke("bots:getAccessNotice", "telegram:work:owner:1"), {
    audienceId: DESKTOP,
    acknowledged: false,
  });
  assert.deepEqual(await invoke("bots:acknowledgeAccessNotice", ACKNOWLEDGEMENT), {
    audienceId: DESKTOP,
    acknowledged: true,
  });
  assert.deepEqual(audiences("noticeStatus"), [DESKTOP]);
  assert.deepEqual(audiences("acknowledgeNotice"), [DESKTOP]);
  assert.deepEqual(calls[calls.length - 1]?.args[1], ACKNOWLEDGEMENT);

  calls.length = 0;
  for (const malformed of [
    { ...ACKNOWLEDGEMENT, confirmedForeground: false },
    { ...ACKNOWLEDGEMENT, version: "bot-full-access-v0" },
    { ...ACKNOWLEDGEMENT, audienceId: "telegram:work:owner:1" },
  ]) {
    await assert.rejects(invoke("bots:acknowledgeAccessNotice", malformed), /notice acknowledgement/u);
  }
  await assert.rejects(
    invokeFrom({ document: null }, "bots:acknowledgeAccessNotice", ACKNOWLEDGEMENT),
    /active application document/u,
  );
  assert.deepEqual(calls, []);

  // A document replaced before the store commits cannot complete the acknowledgement.
  await assert.rejects(
    invokeFrom({ document: { destroyed: true } }, "bots:acknowledgeAccessNotice", ACKNOWLEDGEMENT),
    /application changed before Bot access was confirmed/u,
  );
});

test("Telegram notices belong to the paired owner of a main-resolved profile", async () => {
  const { calls, invoke, audiences } = setup({
    profiles: [
      { name: "work", settings: { allowedUserId: 4242 } },
      { name: "home", settings: { allowedUserId: 7 } },
      { name: "spare", settings: {} },
    ],
  });
  await invoke("bots:getTelegramAccessNotice", " Work ");
  await invoke("bots:acknowledgeTelegramAccessNotice", {
    profile: "home",
    acknowledgement: ACKNOWLEDGEMENT,
  });
  assert.deepEqual(audiences("noticeStatus"), ["telegram:work:owner:4242"]);
  assert.deepEqual(audiences("acknowledgeNotice"), ["telegram:home:owner:7"]);

  calls.length = 0;
  await assert.rejects(invoke("bots:getTelegramAccessNotice", "spare"), /paired owner/u);
  await assert.rejects(invoke("bots:getTelegramAccessNotice", "absent"), /paired owner/u);
  await assert.rejects(invoke("bots:getTelegramAccessNotice", "main"), /reserved/u);
  for (const malformed of [
    { profile: "work" },
    { profile: "work", acknowledgement: ACKNOWLEDGEMENT, audienceId: "desktop:local" },
    { profile: "work", acknowledgement: { ...ACKNOWLEDGEMENT, decision: "skip" } },
    { profile: "spare", acknowledgement: ACKNOWLEDGEMENT },
    ["work", ACKNOWLEDGEMENT],
  ]) {
    await assert.rejects(
      invoke("bots:acknowledgeTelegramAccessNotice", malformed),
      Error,
      JSON.stringify(malformed),
    );
  }
  assert.deepEqual(calls, [], "no unpaired or malformed principal reaches the notice store");
});
