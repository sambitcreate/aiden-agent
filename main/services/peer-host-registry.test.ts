import assert from "node:assert/strict";
import test from "node:test";
import {
  PeerHostRegistry,
  type StoredPeerHost,
  type PeerClient,
} from "./peer-host-registry.js";
import {
  EncryptedPeerHostStorage,
  type PeerEncryptedDocument,
} from "./peer-host-storage.js";
import { peerRequestUrl } from "./peer-transport.js";
import { hostResourceKey } from "../../renderer/shared/peer-host.js";

const trust = {
  endpoint: "https://server.example/api/aiden/v1",
  serverSpkiSha256: `sha256/${Buffer.alloc(32).toString("base64")}`,
};
function saved(id = "host_a"): StoredPeerHost {
  return {
    ...trust,
    id,
    name: "Same name",
    deviceId: "device_a",
    credential: "a".repeat(43),
    enabled: true,
    capabilities: ["chat:read"],
    features: [],
  };
}
function registry(
  hosts: StoredPeerHost[],
  client: PeerClient,
  save = async (_next: StoredPeerHost[]) => {},
) {
  return new PeerHostRegistry({
    storage: { load: async () => hosts, save },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: (trust) => ({
      json: (input) =>
        input.path === "/server"
          ? Promise.resolve({
              protocolVersion: 1,
              instanceId: (trust as StoredPeerHost).id,
              capabilities: ["chat:read"],
              features: [],
            })
          : client.json(input),
      events: (input, onFrame) => client.events(input, onFrame),
    }),
  });
}

test("host identities do not collide and routes cannot escape the fixed API", () => {
  assert.notEqual(
    hostResourceKey({ hostId: "a", resourceId: "same" }),
    hostResourceKey({ hostId: "b", resourceId: "same" }),
  );
  for (const path of [
    "//evil.example",
    "/../../settings",
    "/%2e%2e/secret",
    "/\\evil",
    "/chats#fragment",
  ]) {
    assert.throws(() => peerRequestUrl(trust.endpoint, path));
  }
  assert.equal(
    peerRequestUrl(trust.endpoint, "/chats?cursor=abc").origin,
    "https://server.example",
  );
});

test("disabled peers make no requests; views contain no trust or credential data", async () => {
  let calls = 0;
  const store = registry([{ ...saved(), enabled: false }], {
    json: async () => {
      calls++;
    },
    events: async () => {},
  });
  await assert.rejects(store.request("host_a", { path: "/chats" }));
  assert.equal(calls, 0);
  const [view] = await store.list();
  assert.deepEqual(
    Object.keys(view!).sort(),
    ["id", "name", "enabled", "state", "features", "capabilities"].sort(),
  );
});

test("restored peers verify installation identity before any operation", async () => {
  const paths: string[] = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => [saved()], save: async () => {} },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async (input) => {
        paths.push(input.path);
        return {
          protocolVersion: 1,
          instanceId: "replacement",
          capabilities: [],
        };
      },
      events: async () => {
        throw new Error("Unexpected event request");
      },
    }),
  });
  await assert.rejects(
    store.request("host_a", { method: "POST", path: "/chats", body: {} }),
    /identity changed/,
  );
  assert.deepEqual(paths, ["/server"]);
  assert.equal((await store.list())[0]?.state, "unavailable");
});

test("shutdown during initial storage load prevents network admission", async () => {
  let release!: () => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const store = new PeerHostRegistry({
    storage: {
      load: async () => {
        started();
        await pending;
        return [saved()];
      },
      save: async () => {},
    },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: async () => {
        calls++;
        return {};
      },
      events: async () => {
        calls++;
      },
    }),
  });
  const request = store.request("host_a", {
    method: "POST",
    path: "/chats",
    body: {},
  });
  const rejected = assert.rejects(request, /closed/);
  await loading;
  store.close();
  release();
  await rejected;
  assert.equal(calls, 0);
});

test("concurrent identity checks retain independent cancellation", async () => {
  const checks: Array<() => void> = [];
  const store = new PeerHostRegistry({
    storage: { load: async () => [saved()], save: async () => {} },
    localInstanceId: async () => "self",
    deviceName: "Desktop",
    clientVersion: "1",
    platform: "mac",
    client: () => ({
      json: (input) =>
        input.path === "/server"
          ? new Promise((resolve, reject) => {
              input.signal?.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
              checks.push(() =>
                resolve({
                  protocolVersion: 1,
                  instanceId: "host_a",
                  capabilities: [],
                }),
              );
            })
          : Promise.resolve({ ok: true }),
      events: async () => {},
    }),
  });
  const controller = new AbortController();
  const first = store.request("host_a", {
    path: "/chats",
    signal: controller.signal,
  });
  const rejected = assert.rejects(first, /aborted/);
  const second = store.request("host_a", { path: "/chats" });
  for (let i = 0; checks.length < 2 && i < 50; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks.length, 2);
  controller.abort();
  checks[1]!();
  await rejected;
  assert.deepEqual(await second, { ok: true });
});

test("disabling one peer cancels and fences only that peer's late responses", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = registry([saved(), saved("host_b")], {
    json: async () => {
      await pending;
      return { ok: true };
    },
    events: async () => {},
  });
  const a = store.request("host_a", { path: "/chats" });
  const rejection = assert.rejects(a, /superseded/);
  const b = store.request("host_b", { path: "/chats" });
  await store.setEnabled("host_a", false);
  release();
  await rejection;
  assert.deepEqual(await b, { ok: true });
});

test("failed persistence leaves peer enabled and credentials are never published before storage", async () => {
  const store = registry(
    [saved()],
    { json: async () => ({}), events: async () => {} },
    async () => {
      throw new Error("disk full");
    },
  );
  await assert.rejects(store.setEnabled("host_a", false), /disk full/);
  assert.equal((await store.list())[0]!.enabled, true);
});

test("paired-host encrypted store rejects unavailable encryption and corrupt data", async () => {
  let document: PeerEncryptedDocument = { version: 1, ciphertext: null };
  let available = true;
  const store = new EncryptedPeerHostStorage(
    {
      load: async () => document,
      save: async (next) => {
        document = next;
      },
    },
    {
      isEncryptionAvailable: () => available,
      encryptString: (text) =>
        Buffer.from(Buffer.from(text).map((byte) => byte ^ 0x55)),
      decryptString: (bytes) =>
        Buffer.from(Buffer.from(bytes).map((byte) => byte ^ 0x55)).toString(),
    },
  );
  await store.save([saved()]);
  assert.ok(!JSON.stringify(document).includes(saved().credential));
  assert.deepEqual(await store.load(), [saved()]);
  available = false;
  await assert.rejects(store.save([]), /secure storage/);
  await assert.rejects(store.load(), /secure storage/);
  available = true;
  document = { version: 1, ciphertext: "AAAA" };
  await assert.rejects(store.load());
});

test("pairing rejects self before network and authenticates identity before publishing", async () => {
  let calls = 0;
  const store = registry([], {
    json: async () => {
      calls++;
      return {};
    },
    events: async () => {},
  });
  await assert.rejects(
    store.pair({
      ...trust,
      instanceId: "self",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }),
    /current Aiden/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    store.pair({
      ...trust,
      instanceId: "other",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    }),
    /identity/,
  );
  assert.deepEqual(await store.list(), []);
});

test("a stalled pairing does not delay disconnecting another host, and cancellation fences persistence", async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const network = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  const store = registry(
    [saved()],
    {
      json: async () => {
        entered();
        return network;
      },
      events: async () => {},
    },
    async () => {
      writes++;
    },
  );
  const controller = new AbortController();
  const pairing = store.pair(
    {
      ...trust,
      instanceId: "host_b",
      secret: "b".repeat(43),
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    },
    controller.signal,
  );
  const rejected = assert.rejects(pairing, /cancelled/);
  await started;
  await store.setEnabled("host_a", false);
  assert.equal((await store.list())[0]!.enabled, false);
  controller.abort();
  release({});
  await rejected;
  assert.equal(writes, 1);
  assert.equal((await store.list()).length, 1);
});

test("shutdown rejects future operations and cancels pending pairing", async () => {
  let release!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const network = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const store = registry([], {
    json: async () => {
      entered();
      return network;
    },
    events: async () => {},
  });
  const pairing = store.pair({
    ...trust,
    instanceId: "other",
    secret: "b".repeat(43),
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  });
  const rejected = assert.rejects(pairing, /cancelled/);
  await started;
  store.close();
  release({});
  await rejected;
  await assert.rejects(store.list(), /closed/);
});
