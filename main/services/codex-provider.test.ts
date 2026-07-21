import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryCredentialStore, type Models, type OAuthCredential } from "@earendil-works/pi-ai";
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
  const service = new CodexProviderService(builtinModels({ credentials }), credentials);

  const snapshot = await service.snapshot();
  assert.equal(snapshot.configured, true);
  assert.equal("signedIn" in snapshot, false);
  assert.ok(snapshot.models.length > 0);
});

test("uses an injected Models collection instead of constructing a private registry", () => {
  const credentials = new InMemoryCredentialStore();
  const models = builtinModels({ credentials });
  const service = new CodexProviderService(models, credentials);
  assert.equal(service.getModel("gpt-5.4"), models.getModel("openai-codex", "gpt-5.4"));
});

test("stages OAuth credentials until the owning flow explicitly commits", async () => {
  const credentials = new InMemoryCredentialStore();
  const credential: OAuthCredential = {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: Date.now() + 60_000,
  };
  const models = {
    getProvider: () => ({
      auth: { oauth: { login: async () => credential } },
    }),
  } as unknown as Models;
  const service = new CodexProviderService(models, credentials);

  const staged = await service.authenticate({
    prompt: async () => "unused",
    notify: () => undefined,
  });
  assert.equal(await credentials.read("openai-codex"), undefined);

  await service.commitCredential(staged);
  assert.deepEqual(await credentials.read("openai-codex"), credential);
});
