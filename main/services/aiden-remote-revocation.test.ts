import assert from "node:assert/strict";
import test from "node:test";
import { revokeAidenRemoteRuntimeDevice } from "./aiden-remote-revocation.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  defaultAidenRemoteStateDependencies,
} from "./aiden-remote-state.js";
import { AidenRemoteStreamService, type AidenRemoteStreamSnapshot } from "./aiden-remote-streams.js";

test("runtime revocation is durable, cleans device resources, retries persistence, and preserves device B", async () => {
  let stateDocument = createDefaultAidenRemoteState(() => Buffer.alloc(24, 4));
  let now = 1_000;
  let randomCounter = 0;
  const state = new AidenRemoteStateRegistry({
    load: async () => structuredClone(stateDocument),
    save: async (document) => { stateDocument = structuredClone(document); },
  }, {
    ...defaultAidenRemoteStateDependencies(),
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++randomCounter),
  });
  await state.initialize();
  const deviceA = await state.issueDevice({
    name: "Personal iPhone", type: "iphone", clientVersion: "1",
  });
  const deviceB = await state.issueDevice({
    name: "Travel iPhone", type: "iphone", clientVersion: "1",
  });

  let streamSnapshot: AidenRemoteStreamSnapshot = { version: 1, streams: [] };
  let failStreamSave = false;
  const deniedApprovals: string[] = [];
  const streams = new AidenRemoteStreamService({
    now: () => now,
    cancel: () => true,
    approve: (approvalId, decision) => {
      deniedApprovals.push(`${approvalId}:${decision}`);
      return true;
    },
    persist: async (snapshot) => {
      if (failStreamSave) throw new Error("stream disk unavailable");
      streamSnapshot = structuredClone(snapshot);
    },
  });
  const ownerA = streams.create(deviceA.device.id, "stream-a", "chat-a", "turn-a");
  ownerA.owner.send("chat:approval", { approvalId: "approval-a", summary: "Write a file" });
  streams.create(deviceB.device.id, "stream-b", "chat-b", "turn-b");
  await streams.settlePersistence();

  const chatRevocations: string[] = [];
  const ownerRevocations: string[] = [];
  const resources = {
    state,
    streams,
    chats: { revokeDevice: (deviceId: string) => { chatRevocations.push(deviceId); } },
    workspaceOwners: { revokeDevice: (deviceId: string) => { ownerRevocations.push(deviceId); } },
  };

  failStreamSave = true;
  await assert.rejects(
    revokeAidenRemoteRuntimeDevice(resources, deviceA.device.id),
    /stream disk unavailable/u,
  );
  assert.equal((await state.authenticate(deviceA.credential))?.revoked, true);
  assert.equal((await state.authenticate(deviceB.credential))?.revoked, false);
  assert.throws(() => streams.status(deviceA.device.id, "stream-a"));
  assert.equal(streams.status(deviceB.device.id, "stream-b").state, "queued");
  assert.deepEqual(chatRevocations, [deviceA.device.id]);
  assert.deepEqual(ownerRevocations, [deviceA.device.id]);
  assert.deepEqual(deniedApprovals, ["approval-a:deny"]);

  failStreamSave = false;
  now += 1;
  assert.equal(await revokeAidenRemoteRuntimeDevice(resources, deviceA.device.id), false);
  assert.equal(streamSnapshot.streams.some(({ deviceId }) => deviceId === deviceA.device.id), false);
  assert.equal(streamSnapshot.streams.some(({ deviceId }) => deviceId === deviceB.device.id), true);

  const restartedStreams = new AidenRemoteStreamService({
    now: () => now,
    cancel: () => false,
    approve: () => false,
    snapshot: streamSnapshot,
  });
  assert.throws(() => restartedStreams.status(deviceA.device.id, "stream-a"));
  assert.equal(restartedStreams.status(deviceB.device.id, "stream-b").state, "interrupted");
});
