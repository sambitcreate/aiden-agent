import assert from "node:assert/strict";
import test from "node:test";
import {
  botCustomSelectionIsSubset,
  intersectBotCustomSelections,
  parseBotAccessUpdate,
  type BotCustomSelection,
  type BotFileScopeOption,
} from "./bot-capabilities.js";

const scopes: BotFileScopeOption[] = [
  { id: "home", label: "Bot folder", available: true, kind: "bot_home" },
  { id: "documents", label: "Documents", available: true, kind: "approved_location" },
  { id: "full", label: "Full Mac", available: true, kind: "full_mac" },
];

function selection(fileScopeIds: string[]): BotCustomSelection {
  return {
    providerId: "provider",
    modelId: "model",
    fileScopeIds,
    shellEnabled: false,
    connectionIds: [],
    skillIds: [],
    otherCapabilityIds: [],
  };
}

test("Full Mac is a semantic ceiling for Bot-home and approved-location chat reductions", () => {
  const full = selection(["full"]);
  assert.equal(botCustomSelectionIsSubset(selection(["home"]), full, scopes), true);
  assert.equal(
    botCustomSelectionIsSubset(selection(["home", "documents"]), full, scopes),
    true,
  );
  assert.equal(botCustomSelectionIsSubset(full, selection(["home"]), scopes), false);
});

test("Full Bot access accepts only an exact optional provider/model pair", () => {
  assert.deepEqual(parseBotAccessUpdate({
    accessMode: "full",
    catalogRevision: "catalog:1",
    confirmedForeground: true,
    providerId: "provider:opaque",
    modelId: "model/selected",
  }), {
    accessMode: "full",
    catalogRevision: "catalog:1",
    confirmedForeground: true,
    providerId: "provider:opaque",
    modelId: "model/selected",
  });
  assert.throws(() => parseBotAccessUpdate({
    accessMode: "full",
    catalogRevision: "catalog:1",
    confirmedForeground: true,
    providerId: "provider:opaque",
  }), /Full Access/u);
});

test("file-scope intersection preserves a chat reduction below Full Mac", () => {
  assert.deepEqual(
    intersectBotCustomSelections(selection(["home", "documents"]), selection(["full"]), scopes)
      .fileScopeIds,
    ["home", "documents"],
  );
  assert.deepEqual(
    intersectBotCustomSelections(selection(["full"]), selection(["home"]), scopes).fileScopeIds,
    ["home"],
  );
});
