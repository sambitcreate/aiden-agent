import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { CodexProviderService } from "./codex-provider.js";

test("reports stored OAuth as configured without claiming live connectivity", async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({
    type: "oauth",
    access: "expired-access",
    refresh: "expired-refresh",
    expires: 0,
  }));
  const service = new CodexProviderService(builtinModels({ credentials }));

  const snapshot = await service.snapshot();
  assert.equal(snapshot.configured, true);
  assert.equal("signedIn" in snapshot, false);
  assert.ok(snapshot.models.length > 0);
});

test("uses an injected Models collection instead of constructing a private registry", () => {
  const models = builtinModels();
  const service = new CodexProviderService(models);
  assert.equal(service.getModel("gpt-5.4"), models.getModel("openai-codex", "gpt-5.4"));
});
