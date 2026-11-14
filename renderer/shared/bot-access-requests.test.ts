import assert from "node:assert/strict";
import { test } from "node:test";
import {
  botAccessAuthorizationOf,
  botAccessCardTitle,
  botAccessChoicesFor,
  botAccessResultLine,
  botPendingAccessRequestOf,
  botWholeComputerLabel,
  parseBotAccessChoice,
} from "./bot-access-requests.js";
import { botIssueActionOf, botIssueKindOf } from "./bot-issues.js";

const card = {
  botId: "ada",
  waitId: "wait-1",
  toolCallId: "call",
  target: "folder",
  label: "Taxes",
  place: "~/Taxes",
  why: "Prepare the return",
  choices: ["not_now", "always", "once"],
};
test("whole Mac is only ever Allow once", () => {
  assert.deepEqual(botAccessChoicesFor({ target: "whole_mac", alwaysOffered: true }), [
    "not_now",
    "once",
  ]);
  assert.equal(
    botPendingAccessRequestOf({
      ...card,
      target: "whole_mac",
      choices: ["not_now", "once", "always"],
    }),
    null,
  );
});
test("a whole-computer card names the host's platform and both spellings parse", () => {
  assert.equal(botWholeComputerLabel("darwin"), "your whole Mac");
  assert.equal(botWholeComputerLabel("linux"), "your whole computer");
  const whole = { ...card, target: "whole_mac", place: undefined, choices: ["not_now", "once"] };
  for (const label of ["your whole Mac", "your whole computer"])
    assert.equal(botPendingAccessRequestOf({ ...whole, label })?.label, label);
  assert.equal(botPendingAccessRequestOf({ ...whole, label: "your whole disk" }), null);
});
test("a folder offers Always only when allowed", () => {
  assert.deepEqual(botAccessChoicesFor({ target: "folder", alwaysOffered: true }), [
    "not_now",
    "always",
    "once",
  ]);
  assert.deepEqual(botAccessChoicesFor({ target: "folder", alwaysOffered: false }), [
    "not_now",
    "once",
  ]);
});
test("strict cards enforce shape, ordering, bounds and readable text", () => {
  assert.deepEqual(botPendingAccessRequestOf(card), card);
  for (const bad of [
    { extra: true },
    { why: " " },
    { why: "x".repeat(401) },
    { choices: ["once", "not_now"] },
    { choices: ["not_now", "once", "once"] },
    { place: "relative" },
    { waitId: "has space" },
    { label: "x".repeat(121) },
  ]) {
    assert.equal(botPendingAccessRequestOf({ ...card, ...bad }), null);
  }
  assert.equal(botPendingAccessRequestOf({ ...card, why: "\u202EPrepare\u0000" })?.why, "Prepare");
  assert.equal(botPendingAccessRequestOf({ ...card, label: "\u202ETaxes" })?.label, "Taxes");
  assert.equal(
    botPendingAccessRequestOf({ ...card, target: "whole_mac", choices: ["not_now", "once"] }),
    null,
  );
});
test("titles, choices and result lines match the card", () => {
  assert.equal(
    botAccessCardTitle("Ada", { target: "folder", label: "Taxes" }),
    "Ada wants to use Taxes",
  );
  assert.equal(
    botAccessCardTitle("Ada", { target: "whole_mac", label: "your whole computer" }),
    "Ada wants to use your whole computer",
  );
  assert.equal(
    botAccessCardTitle("Ada", { target: "whole_mac", label: "ignored" }),
    `Ada wants to use ${botWholeComputerLabel()}`,
  );
  for (const choice of ["once", "always", "not_now"])
    assert.equal(parseBotAccessChoice(choice), choice);
  assert.equal(parseBotAccessChoice("allow"), null);
  assert.equal(
    botAccessResultLine({ target: "folder", label: "Taxes", outcome: "once" }),
    "Allowed Taxes once",
  );
  assert.equal(
    botAccessResultLine({ target: "folder", label: "Taxes", outcome: "always" }),
    "Always allowed Taxes",
  );
  assert.equal(
    botAccessResultLine({ target: "folder", label: "Taxes", outcome: "not_now" }),
    "Not now: Taxes",
  );
});
test("access changed is an explicit non-decline result", () => {
  assert.equal(botAccessResultLine({ target: "folder", label: "Taxes", outcome: "access_changed" }), "Access changed for Taxes");
});
test("authorization parsing requires a bounded exact pinned snapshot and never saves Whole Mac Always", () => {
  const auth = {
    policyRevision: "rev1",
    requestIds: ["r1"],
    target: "folder",
    root: "/Taxes",
    identity: { device: "1", inode: "2" },
    choices: ["not_now", "always", "once"],
  };
  assert.deepEqual(botAccessAuthorizationOf(auth), auth);
  for (const bad of [
    { extra: true },
    { requestIds: [] },
    { identity: undefined },
    { identity: { device: "1", inode: "-1" } },
    { root: "relative" },
    { requestIds: ["r1", "r1"] },
  ])
    assert.equal(botAccessAuthorizationOf({ ...auth, ...bad }), null);
  assert.equal(
    botAccessAuthorizationOf({
      policyRevision: "rev1",
      requestIds: ["r1"],
      target: "whole_mac",
      root: "/",
      choices: ["not_now", "always", "once"],
    }),
    null,
  );
});
test("new access issue vocabulary requires explicit opt-in, keeping legacy Remote parsers closed", () => {
  assert.equal(botIssueKindOf("access_needed"), null);
  assert.equal(botIssueActionOf({ kind: "allow_folder" }), null);
  assert.equal(botIssueKindOf("access_needed", true), "access_needed");
  assert.deepEqual(botIssueActionOf({ kind: "allow_folder" }, true), { kind: "allow_folder" });
  assert.equal(botIssueActionOf({ kind: "allow_folder", folderPath: "/injected" }, true), null);
});

test("approval count is public only for an Always-eligible folder and an integer from 3 through 20", () => {
  assert.equal(botPendingAccessRequestOf({ ...card, approvalCount: 3 })?.approvalCount, 3);
  assert.equal(botPendingAccessRequestOf({ ...card, approvalCount: 20 })?.approvalCount, 20);
  for (const approvalCount of [2, 21, 3.5, "3", NaN]) assert.equal(botPendingAccessRequestOf({ ...card, approvalCount }), null);
  assert.equal(botPendingAccessRequestOf({ ...card, choices: ["not_now", "once"], approvalCount: 3 }), null);
  assert.equal(botPendingAccessRequestOf({ ...card, target: "whole_mac", label: "your whole Mac", place: undefined, choices: ["not_now", "once"], approvalCount: 3 }), null);
});
