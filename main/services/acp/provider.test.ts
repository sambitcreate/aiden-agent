import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";

import { AcpHostRegistry } from "./host.js";
import { ACP_MANAGED_CREDENTIAL, createAcpHarnessProvider } from "./provider.js";
import { AcpHarnessRuntime } from "./runtime.js";
import { AcpSessionStore } from "./session-store.js";
import { FAKE_FLASH, FAKE_PRO, FakeLauncher, fakeAgentEnv, fakeDefinition, tempDir } from "./test-support.js";

function setup(discovered: Model<Api>[] = [FAKE_PRO]) {
  const dir = tempDir();
  const runtime = new AcpHarnessRuntime(
    fakeDefinition,
    new FakeLauncher(fakeAgentEnv(dir)),
    new AcpHostRegistry(),
    new AcpSessionStore(path.join(dir, "sessions.json")),
  );
  let discoveries = 0;
  let signIns = 0;
  const provider = createAcpHarnessProvider({
    definition: fakeDefinition,
    stream: (model, context, options) => runtime.stream(model, context, options),
    signIn: {
      name: "Fake sign-in",
      loginLabel: "Sign in with Fake",
      async signIn() {
        signIns += 1;
      },
    },
    async discoverModels() {
      discoveries += 1;
      return discovered;
    },
  });
  const credentials = new InMemoryCredentialStore();
  const store = new InMemoryModelsStore();
  const models = createModels({ credentials, modelsStore: store });
  models.setProvider(provider);
  return { provider, models, credentials, store, runtime, counts: () => ({ discoveries, signIns }) };
}

test("before sign-in the provider is listed but unconfigured, with its fallback catalog", async () => {
  const { models, provider } = setup();
  assert.equal(await models.checkAuth(provider.id), undefined);
  assert.deepEqual(provider.getModels().map((model) => model.id), [FAKE_FLASH.id, FAKE_PRO.id]);
  assert.deepEqual(Object.keys(provider.auth), ["oauth"]);
});

test("sign-in stores only a marker credential and makes the provider available", async () => {
  const { models, provider, credentials, counts } = setup();
  const credential = await provider.auth.oauth!.login!(
    { signal: new AbortController().signal, prompt: async () => "", notify() {} },
    { getDeviceId: () => "device" },
  );
  assert.equal(counts().signIns, 1);
  assert.equal(credential.type, "oauth");
  assert.equal((credential as { access: string }).access, ACP_MANAGED_CREDENTIAL);
  await credentials.modify(provider.id, async () => credential);
  assert.ok(await models.checkAuth(provider.id));
  assert.ok((await models.getAvailable(provider.id)).length > 0);
});

test("background catalog refreshes never start the agent; sign-in or a forced refresh does", async () => {
  const { models, provider, credentials, counts } = setup();
  await credentials.modify(provider.id, async () => ({
    type: "oauth",
    refresh: ACP_MANAGED_CREDENTIAL,
    access: ACP_MANAGED_CREDENTIAL,
    expires: Number.MAX_SAFE_INTEGER,
  }));
  await models.refresh({ allowNetwork: true, providers: [provider.id] });
  assert.equal(counts().discoveries, 0);

  await models.refresh({ allowNetwork: true, providers: [provider.id], force: true });
  assert.equal(counts().discoveries, 1);
  assert.deepEqual(provider.getModels().map((model) => model.id), [FAKE_PRO.id]);

  await provider.auth.oauth!.login!(
    { signal: new AbortController().signal, prompt: async () => "", notify() {} },
    { getDeviceId: () => "device" },
  );
  await models.refresh({ allowNetwork: true, providers: [provider.id] });
  assert.equal(counts().discoveries, 2);
});

test("a discovered catalog survives a restart without starting the agent", async () => {
  const first = setup();
  await first.credentials.modify(first.provider.id, async () => ({
    type: "oauth",
    refresh: ACP_MANAGED_CREDENTIAL,
    access: ACP_MANAGED_CREDENTIAL,
    expires: Number.MAX_SAFE_INTEGER,
  }));
  await first.models.refresh({ allowNetwork: true, providers: [first.provider.id], force: true });
  const persisted = await first.store.read(first.provider.id);
  assert.deepEqual(persisted?.models.map((model) => model.id), [FAKE_PRO.id]);

  const second = setup();
  await second.store.write(second.provider.id, persisted!);
  await second.models.refresh({ allowNetwork: false, providers: [second.provider.id] });
  assert.deepEqual(second.provider.getModels().map((model) => model.id), [FAKE_PRO.id]);
  assert.equal(second.counts().discoveries, 0);
});
