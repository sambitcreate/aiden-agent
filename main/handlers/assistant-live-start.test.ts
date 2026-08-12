import assert from "node:assert/strict";
import test from "node:test";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";
import { GeminiLiveStartError } from "../services/gemini-live/service.js";
import { GeminiLiveConnectionError } from "../services/gemini-live/owned-sdk-connector.js";
import { invokeAssistantLiveStart } from "./assistant-live-start.js";

const owner = {
  id: 1,
  documentId: "1:1:doc",
  isDestroyed: () => false,
  send: () => undefined,
  onInvalidated: () => () => undefined,
} satisfies RendererDocumentOwner;
const intent = { microphone: false, screen: false } as const;

test("Assistant Live handler boundary replaces unexpected service detail with one fixed rejection", async () => {
  await assert.rejects(
    invokeAssistantLiveStart(
      {
        start: async () => {
          throw new Error(
            "wss://provider.example KEY_SENTINEL HANDLER_SENTINEL",
          );
        },
      },
      owner,
      intent,
    ),
    (error: unknown) => {
      assert.ok(error instanceof GeminiLiveStartError);
      assert.equal(error.reason, "live_start_failed");
      assert.equal(error.message, "The Live session could not start.");
      assert.doesNotMatch(
        error.message,
        /provider\.example|KEY_SENTINEL|HANDLER_SENTINEL/u,
      );
      return true;
    },
  );
});

test("Assistant Live handler boundary preserves already-safe eligibility rejections", async () => {
  const expected = new GeminiLiveStartError("missing_google_credential");
  await assert.rejects(
    invokeAssistantLiveStart(
      {
        start: async () => {
          throw expected;
        },
      },
      owner,
      intent,
    ),
    (error: unknown) => error === expected,
  );
});

test("Assistant Live handler maps provider failures to fixed actionable messages", async () => {
  for (const [code, reason] of [
    ["authentication", "google_live_authentication_failed"],
    ["quota", "google_live_quota_exceeded"],
    ["model_unavailable", "google_live_model_unavailable"],
    ["service_unavailable", "google_live_service_unavailable"],
    ["unsupported_configuration", "google_live_configuration_unsupported"],
    ["network", "google_live_network_failed"],
  ] as const) {
    await assert.rejects(
      invokeAssistantLiveStart(
        {
          start: async () => {
            throw new GeminiLiveConnectionError(code);
          },
        },
        owner,
        intent,
      ),
      (error: unknown) =>
        error instanceof GeminiLiveStartError && error.reason === reason,
    );
  }
});
