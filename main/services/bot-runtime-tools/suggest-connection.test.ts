import assert from "node:assert/strict";
import test from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import { suggestConnectionCandidate } from "../bot-runtime/bot-tool-candidates.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import { getMcpPreset, serverFromPreset } from "../mcp-presets.js";
import type { McpServer } from "../types.js";
import {
  connectionSourceIdFor,
  createSuggestConnectionTool,
  isBotConnectionReady,
  resolveConnectCardStatus,
  type SuggestConnectionDeps,
} from "./suggest-connection.js";

function harness(overrides: Partial<SuggestConnectionDeps> = {}) {
  const cards: Array<{ botId: string; card: ConnectCardEntry }> = [];
  const deps: SuggestConnectionDeps = {
    isConnected: () => false,
    isDismissed: () => false,
    appendConnectCard: (botId, card) => {
      cards.push({ botId, card });
    },
    ...overrides,
  };
  return { tool: createSuggestConnectionTool("bot-a", deps), cards };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("");
}

test("the tool is named suggest_connection and declares pluginId and reason", () => {
  const { tool } = harness();
  assert.equal(tool.name, "suggest_connection");
  const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(Object.keys(properties).sort(), ["pluginId", "reason"]);
});

test("suggesting a plugin appends one pending connect card for this Bot", async () => {
  const { tool, cards } = harness();
  const result = await tool.execute("call-1", {
    pluginId: "notion",
    reason: "  So I can keep your meal plans in Notion.  ",
  });
  assert.deepEqual(cards, [
    {
      botId: "bot-a",
      card: {
        type: "connect_card",
        pluginId: "notion",
        reason: "So I can keep your meal plans in Notion.",
        status: "pending",
      },
    },
  ]);
  assert.equal((result.details as { status: string }).status, "suggested");
  assert.match(text(result), /Notion/u);
});

test("already connected plugins are refused without a card", async () => {
  const asked: string[] = [];
  const { tool, cards } = harness({
    isConnected: async (pluginId) => {
      asked.push(pluginId);
      return pluginId === "gmail";
    },
  });
  const result = await tool.execute("call-1", { pluginId: "gmail", reason: "Read your inbox." });
  assert.equal(cards.length, 0);
  assert.equal((result.details as { status: string }).status, "already_connected");
  assert.match(text(result), /already connected/iu);
  assert.deepEqual(asked, ["gmail"]);
});

test("an app connected in Aiden but left out of this Bot's access gets a card to add it", async () => {
  const { tool, cards } = harness({
    isConnected: (pluginId) => pluginId === "notion",
    botLacksConnection: (botId, pluginId) => botId === "bot-a" && pluginId === "notion",
  });
  const result = await tool.execute("call-1", { pluginId: "notion", reason: "Keep your notes." });
  assert.equal((result.details as { status: string }).status, "suggested");
  assert.deepEqual(cards.map(({ card }) => [card.pluginId, card.status]), [["notion", "pending"]]);
  assert.match(text(result), /doesn't include it/u);
  assert.doesNotMatch(text(result), /already connected/iu);
});

test("an app the Bot has but this chat's narrower access leaves out gets no card and no claim it works", async () => {
  const { tool, cards } = harness({
    isConnected: (pluginId) => pluginId === "notion",
    botLacksConnection: () => false,
    chatLacksConnection: (botId, pluginId) => botId === "bot-a" && pluginId === "notion",
  });
  const result = await tool.execute("call-1", { pluginId: "notion", reason: "Keep your notes." });
  assert.equal((result.details as { status: string }).status, "chat_restricted");
  assert.equal(cards.length, 0, "Add to this Bot could not change this chat's access");
  assert.match(text(result), /can't use it here/u);
  assert.doesNotMatch(text(result), /Use it instead/u);
});

test("a pending card reads connected, add to this Bot, not now, or still waiting", async () => {
  const card: ConnectCardEntry = { type: "connect_card", pluginId: "notion", reason: "Inbox.", status: "pending" };
  const connected = new Set<string>();
  const lacking = new Set<string>();
  const dismissed = new Set<string>();
  const deps = {
    isConnected: (pluginId: string) => connected.has(pluginId),
    botLacksConnection: (botId: string, sourceId: string) => lacking.has(`${botId}:${sourceId}`),
    isDismissed: (botId: string, pluginId: string) => dismissed.has(`${botId}:${pluginId}`),
  };
  assert.equal(await resolveConnectCardStatus("bot-a", card, deps), "pending");
  dismissed.add("bot-a:notion");
  assert.equal(await resolveConnectCardStatus("bot-a", card, deps), "dismissed");
  dismissed.clear();
  connected.add("notion");
  const notionServer = connectionSourceIdFor("notion")!;
  lacking.add(`bot-a:${notionServer}`);
  assert.equal(await resolveConnectCardStatus("bot-a", card, deps), "needs_access");
  assert.equal(await resolveConnectCardStatus("bot-b", card, deps), "connected", "another Bot has it");
  // Not now on Add to this Bot settles the card; nothing was granted.
  dismissed.add("bot-a:notion");
  assert.equal(await resolveConnectCardStatus("bot-a", card, deps), "dismissed");
  assert.ok(lacking.has(`bot-a:${notionServer}`));
  // Once the Bot can use the app, the card reads Connected even after Not now.
  lacking.clear();
  assert.equal(await resolveConnectCardStatus("bot-a", card, deps), "connected");
  assert.equal(connectionSourceIdFor("gmail"), undefined, "apps reached through Composio have no connection of their own");
});

test("plugins dismissed for this Bot are refused, but other Bots are unaffected", async () => {
  const dismissed = new Set(["bot-a:gmail"]);
  const cards: Array<{ botId: string; card: ConnectCardEntry }> = [];
  const deps: SuggestConnectionDeps = {
    isConnected: () => false,
    isDismissed: (botId, pluginId) => dismissed.has(`${botId}:${pluginId}`),
    appendConnectCard: (botId, card) => {
      cards.push({ botId, card });
    },
  };
  const refused = await createSuggestConnectionTool("bot-a", deps).execute("c1", {
    pluginId: "gmail",
    reason: "Inbox help.",
  });
  assert.equal((refused.details as { status: string }).status, "dismissed");
  assert.match(text(refused), /Not now/u);
  await createSuggestConnectionTool("bot-b", deps).execute("c2", {
    pluginId: "gmail",
    reason: "Inbox help.",
  });
  assert.deepEqual(cards.map((entry) => entry.botId), ["bot-b"]);
});

test("at most one pending card per plugin when the caller can report pending cards", async () => {
  const pending = new Set<string>();
  const { tool, cards } = harness({
    hasPendingCard: (_botId, pluginId) => pending.has(pluginId),
    appendConnectCard: (botId, card) => {
      pending.add(card.pluginId);
      cards.push({ botId, card });
    },
  });
  await tool.execute("c1", { pluginId: "notion", reason: "Notes." });
  const second = await tool.execute("c2", { pluginId: "notion", reason: "Notes again." });
  assert.equal(cards.length, 1);
  assert.equal((second.details as { status: string }).status, "pending");
});

test("unknown plugins and blank reasons are refused", async () => {
  const { tool, cards } = harness();
  const unknown = await tool.execute("c1", { pluginId: "made-up", reason: "Because." });
  assert.equal((unknown.details as { status: string }).status, "unknown_plugin");
  await assert.rejects(tool.execute("c2", { pluginId: "notion", reason: "   " }), /reason/iu);
  await assert.rejects(tool.execute("c3", { pluginId: 7, reason: "x" }), /pluginId/iu);
  assert.equal(cards.length, 0);
});

test("long reasons are shortened to one card-sized sentence", async () => {
  const { tool, cards } = harness();
  await tool.execute("c1", { pluginId: "notion", reason: "x".repeat(2_000) });
  assert.ok((cards[0]?.card.reason.length ?? 0) <= 280);
});

test("an aborted call appends nothing", async () => {
  const { tool, cards } = harness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute("c1", { pluginId: "notion", reason: "Notes." }, controller.signal),
  );
  assert.equal(cards.length, 0);
});

test("a plugin counts as connected only when its preset is enabled and signed in", async () => {
  const notion = serverFromPreset(getMcpPreset("notion")!);
  const composio = serverFromPreset(getMcpPreset("composio")!);
  let servers: McpServer[] = [notion, composio];
  const signedIn = new Set<string>();
  const keys = new Set<string>();
  const deps = {
    listServers: async () => servers,
    hasPresetKey: async (server: McpServer) => keys.has(server.id),
    hasOAuthTokens: async (server: McpServer) => signedIn.has(server.id),
  };
  // Saved but never signed in: the Bot must still be able to suggest it.
  assert.equal(await isBotConnectionReady("notion", deps), false);
  signedIn.add(notion.id);
  assert.equal(await isBotConnectionReady("notion", deps), true);
  servers = [{ ...notion, enabled: false }, composio];
  assert.equal(await isBotConnectionReady("notion", deps), false);
  // Switched off for the model: the Bot can't use it, so it is not "connected".
  servers = [{ ...notion, exposure: "hidden" }, composio];
  assert.equal(await isBotConnectionReady("notion", deps), false);
  servers = [{ ...notion, exposure: "direct", hiddenTools: ["search"] }, composio];
  assert.equal(await isBotConnectionReady("notion", deps), true);
  servers = [notion, composio];

  // An API-key preset is connected only once its key is saved.
  assert.equal(await isBotConnectionReady("composio", deps), false);
  keys.add(composio.id);
  assert.equal(await isBotConnectionReady("composio", deps), true);
  // Apps reached through Composio are never reported: Aiden can't see inside it.
  assert.equal(await isBotConnectionReady("gmail", deps), false);

  // A record that is not a valid preset server is not usable.
  servers = [{ ...notion, url: "https://attacker.invalid/mcp" }, composio];
  assert.equal(await isBotConnectionReady("notion", deps), false);
  assert.equal(await isBotConnectionReady("not-a-plugin", deps), false);
});

test("bound to a Bot call, the card is written into that call's conversation, and a card the chat still shows is pending", async () => {
  // The calling conversation as a call reads it: newest first.
  const log: EntryRecord[] = [];
  const call = {
    entries: async () => [...log].reverse(),
    appendEntry: async (kind: string, data: unknown) => {
      log.push({ id: log.length + 1, kind, data } as unknown as EntryRecord);
    },
  } as unknown as BotToolCall;
  const candidate = suggestConnectionCandidate("bot-a", { isConnected: () => false, isDismissed: () => false });
  const suggest = async () =>
    ((await candidate.bind!(call).execute("call-1", { pluginId: "notion", reason: "Keep plans in Notion." })).details as { status: string })
      .status;

  assert.equal(await suggest(), "suggested");
  assert.deepEqual(
    log.map((entry) => [entry.kind, (entry.data as unknown as ConnectCardEntry).pluginId, (entry.data as unknown as ConnectCardEntry).status]),
    [["aiden.connect-card", "notion", "pending"]],
  );
  assert.equal(await suggest(), "pending", "the card already waits in the chat");
  assert.equal(log.length, 1);

  // A compaction whose kept context starts after the card: the chat no longer shows it, so it may be offered again.
  log.push({ id: log.length + 1, kind: "pi.compaction", head: log.length + 1 } as unknown as EntryRecord);
  assert.equal(await suggest(), "suggested");
  assert.equal(log.filter((entry) => entry.kind === "aiden.connect-card").length, 2);

  await assert.rejects(
    candidate.tool.execute("call-2", { pluginId: "gmail", reason: "Read your mail." }),
    /needs a Bot conversation/u,
    "unbound, it writes nowhere",
  );
});
