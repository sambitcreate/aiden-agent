import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectCardEntry } from "../../../renderer/shared/bot-connections.js";
import {
  createSuggestConnectionTool,
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
