import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import { invokeAssistantLiveStatus } from "./assistant-live-status.js";

const owner = {
  id: 1,
  documentId: "1:1:doc",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
} satisfies RendererDocumentOwner;

test("Assistant Live status boundary normalizes sync and async service failures", async () => {
  for (const availability of [
    () => {
      throw new Error(
        "wss://provider.example KEY_SENTINEL SYNC_STATUS_SENTINEL",
      );
    },
    async () => {
      throw new Error(
        "wss://provider.example KEY_SENTINEL ASYNC_STATUS_SENTINEL",
      );
    },
  ]) {
    const status = await invokeAssistantLiveStatus({ availability }, owner);
    assert.deepEqual(status, {
      available: false,
      reason: "live_model_unverified",
      state: "idle",
    });
    assert.doesNotMatch(
      JSON.stringify(status),
      /provider\.example|KEY_SENTINEL|SYNC_STATUS_SENTINEL|ASYNC_STATUS_SENTINEL/u,
    );
  }
});

test("Assistant Live status boundary preserves a known safe status", async () => {
  const expected = {
    available: false,
    reason: "missing_google_credential",
    state: "idle",
  } as const;
  assert.equal(
    await invokeAssistantLiveStatus(
      { availability: async () => expected },
      owner,
    ),
    expected,
  );
});
