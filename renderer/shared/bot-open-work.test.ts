import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseBotOpenWorkMutation, parseBotOpenWorkSnapshot, parseBotOpenWorkEvidence, parseBotOpenWorkResult } from "./bot-open-work.js";

const mutationId = "22222222-2222-4222-8222-222222222222";
test("person mutations retain stable identities and cannot manufacture source/result/execution authority", () => {
  const add = { action: "add", mutationId, expectedRevision: "initial", title: "Review the brief", note: "Check the assumptions." };
  assert.deepEqual(parseBotOpenWorkMutation(add), add);
  for (const extra of [{ source: { kind: "routine", routineId: "private" } }, { result: { entryId: "7" } }, { execution: { canStop: true } }]) assert.throws(() => parseBotOpenWorkMutation({ ...add, ...extra }));
  assert.throws(() => parseBotOpenWorkMutation({ action: "edit", mutationId, expectedRevision: "r2", id: "item", patch: { state: "waiting" } }));
  assert.throws(() => parseBotOpenWorkMutation({ action: "edit", mutationId, expectedRevision: "r2", id: "item", patch: { state: "done", waitingReason: "Old reason" } }));
});
test("text bounds use Unicode scalars and UTF-8 bytes without truncating accepted instructions", () => {
  const add = { action: "add", mutationId, expectedRevision: "initial", title: "😀".repeat(160), note: "界".repeat(682) };
  assert.deepEqual(parseBotOpenWorkMutation(add), add);
  for (const change of [{ title: "😀".repeat(161) }, { note: "界".repeat(683) }, { title: "invalid\uD83D" }, { note: "invalid\0text" }]) assert.throws(() => parseBotOpenWorkMutation({ ...add, ...change }));
  let accessed = 0;
  assert.throws(() => parseBotOpenWorkMutation(Object.defineProperty({}, "action", { enumerable: true, get() { accessed++; return "add"; } })));
  assert.equal(accessed, 0);
});
test("shared Open work fixtures decode and public evidence never accepts caller paths or entry substitutions", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-open-work.json", import.meta.url), "utf8"));
  assert.equal(parseBotOpenWorkSnapshot(fixture.snapshot).items[0]!.title, "Review the project brief");
  assert.equal(parseBotOpenWorkResult(fixture.result).ok, true);
  assert.equal(parseBotOpenWorkResult(fixture.stale).ok, false);
  assert.equal(parseBotOpenWorkEvidence(fixture.evidenceSource).text, "Review the project brief and note any open questions.");
  assert.throws(() => parseBotOpenWorkEvidence({ ...fixture.evidenceSource, path: "/private/file" }));
  assert.throws(() => parseBotOpenWorkSnapshot({ ...fixture.snapshot, items: [{ ...fixture.item, createdAt: Number.MAX_SAFE_INTEGER + 1 }] }));
  assert.throws(() => parseBotOpenWorkSnapshot({ ...fixture.snapshot, items: [{ ...fixture.item, source: { kind: "person", submissionId: "10" } }] }));
  assert.throws(() => parseBotOpenWorkEvidence({ ...fixture.evidenceSource, text: "界".repeat(10923) }));
});
