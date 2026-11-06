import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBotPeerApi } from "./bot-peers-api";

const fixture = JSON.parse(readFileSync(new URL("../../protocol/aiden-remote/v1/fixtures/bot-peers.json", import.meta.url), "utf8"));
test("peer IPC client preserves original owner commands, string evidence IDs and missing records", async () => {
  const requests: unknown[] = [];
  const api = createBotPeerApi(async (channel, input) => {
    requests.push({ channel, input });
    if (channel.endsWith(":mutate")) return fixture.accepted;
    if (channel.endsWith(":evidence")) return fixture.evidence;
    return null;
  });
  const command = structuredClone(fixture.approve);
  assert.equal((await api.mutate(command)).ok, true);
  assert.deepEqual(requests[0], { channel: "bots:peers:mutate", input: fixture.approve });
  const evidence = await api.evidence(fixture.settings.botId, fixture.detail.id, "source");
  assert.equal(evidence!.submissionId, "9007199254740993"); assert.equal(evidence!.entryId, "9007199254740995");
  assert.equal(await api.exchange(fixture.settings.botId, fixture.detail.id), null);
});
test("peer IPC client rejects extra command authority, changed receipts and wrong-resource replies", async () => {
  let calls = 0, reply = fixture.accepted;
  const api = createBotPeerApi(async () => { calls++; return reply; });
  await assert.rejects(api.mutate({ ...fixture.approve, rootBotId: "caller" })); assert.equal(calls, 0);
  reply = { ...fixture.accepted, mutationId: fixture.stop.mutationId }; await assert.rejects(api.mutate(fixture.approve));
  reply = { ...fixture.settings, botId: "other_bot" }; await assert.rejects(api.settings(fixture.settings.botId));
  reply = { ...fixture.detail, id: "other_exchange" }; await assert.rejects(api.exchange(fixture.settings.botId, fixture.detail.id));
  reply = { ...fixture.evidence, kind: "result" }; await assert.rejects(api.evidence(fixture.settings.botId, fixture.detail.id, "source"));
  reply = { ...fixture.detail, privateSourceClaim: "hidden" }; await assert.rejects(api.exchange(fixture.settings.botId, fixture.detail.id));
});
