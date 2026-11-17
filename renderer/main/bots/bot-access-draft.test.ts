// Advanced → Tools replaced the Everything / Only what I choose picker. The
// stored access is unchanged, so these fixtures check reach from what the save
// sends: an existing Custom Bot sends exactly its old grants, and turning a
// tool off from Everything only ever narrows.

import assert from "node:assert/strict";
import test from "node:test";
import type { BotAccessState } from "../../lib/ipc";
import { BOT_WEB_SEARCH_CAPABILITY_LABEL, type BotCapabilityCatalog } from "../../shared/bot-capabilities";
import {
  accessDraftFromState,
  botToolsOf,
  buildBotAccessUpdate,
  disableBotTool,
  enableBotTool,
} from "./bot-access-draft";
import { catalogFixture } from "./test-fixtures";

function catalog(): BotCapabilityCatalog {
  return {
    ...catalogFixture(),
    fileScopes: [
      { id: "fs-mac", label: "Your whole Mac", kind: "full_mac", available: true },
      { id: "fs-home", label: "Its own folder", kind: "bot_home", available: true },
      { id: "fs-docs", label: "Documents", kind: "approved_location", available: true },
    ],
    connections: [
      { id: "conn-mail", label: "Mail", available: true },
      { id: "conn-cal", label: "Calendar", available: true },
      { id: "conn-gone", label: "Old app", available: false },
    ],
    skills: [{ id: "skill-notes", label: "Notes", available: true }],
    otherCapabilities: [
      { id: "cap-web", label: BOT_WEB_SEARCH_CAPABILITY_LABEL, available: true },
      { id: "cap-browser", label: "Browser", available: true },
    ],
  };
}

function state(access: BotAccessState["access"], webSearchEnabled?: boolean): BotAccessState {
  return {
    access,
    modelSelection: { providerId: "prov-vision", modelId: "model-vision" },
    ...(webSearchEnabled === undefined ? {} : { webSearchEnabled }),
  } as BotAccessState;
}

const CUSTOM = {
  providerId: "prov-vision",
  modelId: "model-vision",
  fileScopeIds: ["fs-home", "fs-docs"],
  shellEnabled: false,
  connectionIds: ["conn-mail"],
  skillIds: [],
  otherCapabilityIds: ["cap-web"],
};

test("an existing Custom Bot saves exactly the grants it had: the new page reads them as tools that are off", () => {
  const current = catalog();
  const draft = accessDraftFromState(state({ botId: "b", revision: "r", policyEpoch: "e", summary: "", accessMode: "custom", custom: CUSTOM } as never), current);
  const update = buildBotAccessUpdate(draft, current);
  assert.equal(update.accessMode, "custom");
  assert.deepEqual(update.accessMode === "custom" ? update.custom : undefined, CUSTOM);
  const { on, off } = botToolsOf(current, draft);
  assert.deepEqual(on.map((tool) => tool.label), ["Mail", BOT_WEB_SEARCH_CAPABILITY_LABEL]);
  assert.deepEqual(off.map((tool) => tool.label).sort(), ["Browser", "Calendar", "Notes", "Run commands"]);
  // Turning one back on adds that grant alone.
  const calendar = off.find((tool) => tool.label === "Calendar")!;
  const widened = buildBotAccessUpdate(enableBotTool(draft, calendar), current);
  assert.deepEqual(widened.accessMode === "custom" ? widened.custom.connectionIds : undefined, ["conn-mail", "conn-cal"]);
});

test("disabling a tool on an Everything Bot keeps every other available tool and the whole Mac, and nothing it lacked", () => {
  const current = catalog();
  for (const webSearchEnabled of [true, false]) {
    const draft = accessDraftFromState(state({ botId: "b", revision: "r", policyEpoch: "e", summary: "", accessMode: "full" } as never, webSearchEnabled), current);
    const { on } = botToolsOf(current, draft);
    assert.ok(!on.some((tool) => tool.label === "Old app"), "an unavailable app is never a tool");
    const mail = on.find((tool) => tool.label === "Mail")!;
    const update = buildBotAccessUpdate(disableBotTool(current, draft, mail), current);
    assert.equal(update.accessMode, "custom");
    if (update.accessMode !== "custom") continue;
    assert.deepEqual(update.custom.fileScopeIds, ["fs-mac"]);
    assert.equal(update.custom.shellEnabled, true);
    assert.deepEqual(update.custom.connectionIds, ["conn-cal"]);
    assert.deepEqual(update.custom.skillIds, ["skill-notes"]);
    // Web search stays exactly as it was in Everything.
    assert.deepEqual(update.custom.otherCapabilityIds, webSearchEnabled ? ["cap-web", "cap-browser"] : ["cap-browser"]);
  }
});

test("Web search on an Everything Bot is its own switch: off keeps Full access", () => {
  const current = catalog();
  const draft = accessDraftFromState(state({ botId: "b", revision: "r", policyEpoch: "e", summary: "", accessMode: "full" } as never, true), current);
  const web = botToolsOf(current, draft).on.find((tool) => tool.key === "webSearch")!;
  const update = buildBotAccessUpdate(disableBotTool(current, draft, web), current);
  assert.equal(update.accessMode, "full");
  assert.equal(update.accessMode === "full" ? update.webSearchEnabled : undefined, false);
  assert.equal(botToolsOf(current, draft).on.filter((tool) => tool.label === BOT_WEB_SEARCH_CAPABILITY_LABEL).length, 1, "listed once");
});

test("without the whole Mac on offer, an Everything Bot keeps its own folder and every approved folder", () => {
  const current = { ...catalog(), fileScopes: catalog().fileScopes.filter((scope) => scope.kind !== "full_mac") };
  const draft = accessDraftFromState(state({ botId: "b", revision: "r", policyEpoch: "e", summary: "", accessMode: "full" } as never, true), current);
  const update = buildBotAccessUpdate(disableBotTool(current, draft, { key: "shell", id: "shell" }), current);
  assert.deepEqual(update.accessMode === "custom" ? [update.custom.fileScopeIds, update.custom.shellEnabled] : undefined, [["fs-home", "fs-docs"], false]);
});
