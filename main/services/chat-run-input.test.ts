import assert from "node:assert/strict";
import test from "node:test";
import { createChatRunInputAdmission } from "./chat-run-input.js";
import { parseChatRunInput } from "../../renderer/shared/chat-run-input.js";
const request = { requestId: "019a0000-0000-4000-8000-000000000001", mode: "steer" as const, text: "Change direction" };

test("input parser rejects extra authority, blank/oversized text and invalid identity", () => {
  for (const input of [null, {}, { ...request, chatId: "injected" }, { ...request, requestId: "x" }, { ...request, text: " " }, { ...request, text: "😀".repeat(4097) }, { ...request, mode: "interrupt" }]) {
    assert.throws(() => parseChatRunInput(input), /Invalid/);
  }
  assert.deepEqual(parseChatRunInput(request), request);
});

test("host persistence precedes acceptance and concurrent identical retries coalesce", async () => {
  let persistCalls = 0;
  let queueCalls = 0;
  const submit = createChatRunInputAdmission({ streamId: "stream", ownerDocumentId: "owner", isCurrent: () => true,
    revalidate: async () => {}, persist: async () => { persistCalls++; },
    queue: async (_input, persist) => { queueCalls++; await persist(); return { accepted: true, queue: "steer" }; },
  });
  const [first, retry] = await Promise.all([submit(request), submit(request)]);
  assert.deepEqual(first, retry);
  assert.equal(first.accepted, true);
  assert.equal(persistCalls, 1);
  assert.equal(queueCalls, 1);
  assert.throws(() => submit({ ...request, text: "different" }), /reused/);
});

test("revocation during revalidation never persists or queues input", async () => {
  let current = true;
  const submit = createChatRunInputAdmission({ streamId: "stream", ownerDocumentId: "owner", isCurrent: () => current,
    revalidate: async () => { current = false; }, persist: async () => assert.fail("must not persist"), queue: async () => assert.fail("must not queue"),
  });
  assert.deepEqual(await submit(request), { requestId: request.requestId, streamId: "stream", mode: "steer", accepted: false, reason: "cancelled" });
});

test("failed durable admission cannot be replayed as another append", async () => {
  let writes = 0;
  const submit = createChatRunInputAdmission({ streamId: "stream", ownerDocumentId: "owner", isCurrent: () => true,
    revalidate: async () => {}, persist: async () => { writes++; throw new Error("storage failed"); },
    queue: async (_input, persist) => { await persist(); return { accepted: true, queue: "steer" }; },
  });
  await assert.rejects(submit(request), /storage failed/);
  await assert.rejects(submit(request), /storage failed/);
  assert.equal(writes, 1);
});
