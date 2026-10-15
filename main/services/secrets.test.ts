import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { build } from "esbuild";

// The real secrets service runs against a synthetic Electron boundary: a fake
// safeStorage (a reversible byte transform that never contains the plaintext)
// and an `app.getPath("userData")` pointing at a throwaway directory.

const SENTINEL = "sk-SENTINEL-provider-9f3c2a";
const IMAGE_SENTINEL = "fal-SENTINEL-image-77d1e0";
const CIPHER_PREFIX = Buffer.from("v10", "utf8");

interface FakeSafeStorage {
  available: boolean;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface SecretsApi {
  setKey(id: string, key: string, isCurrent?: () => boolean): Promise<void>;
  setInternalKey(id: string, value: string, maxLength: number): Promise<void>;
  getKey(id: string): Promise<string | null>;
  getKeyStrict(id: string): Promise<string | null>;
  getProviderKey(id: string, binding: string): Promise<string | null>;
  getOrBindLegacyProviderKey(id: string, binding: string): Promise<string | null>;
  setProviderKey(id: string, key: string, binding: string): Promise<void>;
  migrateProviderKeysWithBindings(
    migrations: Array<{ legacyProviderId: string; providerId: string; binding: string }>,
  ): Promise<boolean>;
  quarantineUnboundProviderKey(id: string): Promise<void>;
  reconcileProviderKeyQuarantine(id: string, desiredBinding: string | null): Promise<void>;
  hasKey(id: string): Promise<boolean>;
  deleteKey(id: string): Promise<void>;
  deleteKeyFamily(id: string): Promise<void>;
  clearAll(): Promise<void>;
}

const bundled = build({
  entryPoints: [fileURLToPath(new URL("./secrets.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  packages: "external",
  plugins: [
    {
      name: "synthetic-platform",
      setup(builder) {
        builder.onResolve({ filter: /^\.\.\/platform\.js$/ }, () => ({
          path: "platform",
          namespace: "synthetic",
        }));
        builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({
          loader: "js",
          contents: "module.exports = globalThis.__aidenSecretsTestPlatform;",
        }));
      },
    },
  ],
}).then((result) => result.outputFiles[0].text);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function fakeSafeStorage(): FakeSafeStorage {
  return {
    available: true,
    isEncryptionAvailable() {
      return this.available;
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString(value) {
      if (!this.available) throw new Error("fake safeStorage is locked");
      const body = Buffer.from(value, "utf8").map((byte) => byte ^ 0x5a);
      return Buffer.concat([CIPHER_PREFIX, body]);
    },
    decryptString(value) {
      if (!this.available) throw new Error("fake safeStorage is locked");
      if (!value.subarray(0, CIPHER_PREFIX.length).equals(CIPHER_PREFIX)) {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      }
      return Buffer.from(value.subarray(CIPHER_PREFIX.length).map((byte) => byte ^ 0x5a)).toString(
        "utf8",
      );
    },
  };
}

async function harness() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-secrets-"));
  temporaryDirectories.push(userData);
  const safeStorage = fakeSafeStorage();
  const logged: unknown[][] = [];
  (globalThis as Record<string, unknown>).__aidenSecretsTestPlatform = {
    app: { getPath: (name: string) => (name === "userData" ? userData : assert.fail(name)) },
    safeStorage,
    logger: {
      debug() {},
      info() {},
      warn: (...values: unknown[]) => logged.push(values),
      error: (...values: unknown[]) => logged.push(values),
    },
  };
  const module = { exports: {} as { secrets: SecretsApi } };
  new Function("require", "module", "exports", await bundled)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const file = path.join(userData, "provider-keys.json");
  return {
    secrets: module.exports.secrets,
    safeStorage,
    logged,
    userData,
    file,
    /** Every byte written under userData, for plaintext scans. */
    async diskContents(): Promise<string> {
      const names = await fs.readdir(userData);
      const contents = await Promise.all(
        names.map((name) => fs.readFile(path.join(userData, name), "utf8")),
      );
      return contents.join("\n");
    },
  };
}

function logText(logged: unknown[][]): string {
  return logged
    .flat()
    .map((value) =>
      value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value),
    )
    .join("\n");
}

function assertNoPlaintext(contents: string, secret: string) {
  assert.equal(contents.includes(secret), false, "plaintext secret was written to disk");
  assert.equal(
    contents.includes(Buffer.from(secret, "utf8").toString("base64")),
    false,
    "base64-encoded plaintext secret was written to disk",
  );
}

test("a key round-trips through the encrypted store and survives a fresh service instance", async () => {
  const h = await harness();
  assert.equal(await h.secrets.getKey("openrouter"), null);
  assert.equal(await h.secrets.hasKey("openrouter"), false);

  await h.secrets.setKey("openrouter", SENTINEL);

  assert.equal(await h.secrets.getKey("openrouter"), SENTINEL);
  assert.equal(await h.secrets.getKeyStrict("openrouter"), SENTINEL);
  assert.equal(await h.secrets.hasKey("openrouter"), true);
  assertNoPlaintext(await h.diskContents(), SENTINEL);
  // Only the published map remains; staged temp files are cleaned up.
  assert.deepEqual(await fs.readdir(h.userData), ["provider-keys.json"]);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(h.file)).mode & 0o777, 0o600);
  }
  // A ciphertext that does not decrypt under the fake safeStorage proves the
  // stored value went through encryptString rather than plain base64.
  const stored = JSON.parse(await fs.readFile(h.file, "utf8")) as Record<string, string>;
  assert.notEqual(Buffer.from(stored.openrouter, "base64").toString("utf8"), SENTINEL);
});

test("concurrent writes to different ids are serialized and none is lost", async () => {
  const h = await harness();
  const ids = Array.from({ length: 8 }, (_, index) => `provider-${index}`);
  await Promise.all(ids.map((id) => h.secrets.setKey(id, `${SENTINEL}-${id}`)));
  for (const id of ids) assert.equal(await h.secrets.getKey(id), `${SENTINEL}-${id}`);
});

test("when encryption is unavailable, saves are refused and no plaintext reaches disk", async () => {
  const h = await harness();
  h.safeStorage.available = false;

  await assert.rejects(h.secrets.setKey("openrouter", SENTINEL), /Cannot save the API key/);
  await assert.rejects(
    h.secrets.setProviderKey("openrouter", SENTINEL, "https://openrouter.ai/api/v1"),
    /Cannot save the API key/,
  );
  await assert.rejects(
    h.secrets.setInternalKey("aiden-internal:tts", SENTINEL, 1024),
    /Cannot save the API key/,
  );

  assert.deepEqual(await fs.readdir(h.userData), []);
  assert.equal(await h.secrets.hasKey("openrouter"), false);
});

test("a stored key cannot be read while encryption is unavailable, and reads recover afterwards", async () => {
  const h = await harness();
  await h.secrets.setKey("openrouter", SENTINEL);
  h.safeStorage.available = false;

  assert.equal(await h.secrets.getKey("openrouter"), null);
  await assert.rejects(h.secrets.getKeyStrict("openrouter"), /Secure storage is unavailable/);
  // The ciphertext is kept, so presence is still reported.
  assert.equal(await h.secrets.hasKey("openrouter"), true);
  assertNoPlaintext(logText(h.logged), SENTINEL);

  h.safeStorage.available = true;
  assert.equal(await h.secrets.getKey("openrouter"), SENTINEL);
});

test("garbled ciphertext reads as absent for lenient callers and as an error for strict callers", async () => {
  const h = await harness();
  await h.secrets.setKey("openrouter", SENTINEL);
  const stored = JSON.parse(await fs.readFile(h.file, "utf8")) as Record<string, string>;
  stored.openrouter = Buffer.from("not-a-ciphertext").toString("base64");
  await fs.writeFile(h.file, JSON.stringify(stored));

  assert.equal(await h.secrets.getKey("openrouter"), null);
  await assert.rejects(h.secrets.getKeyStrict("openrouter"), /decrypting the ciphertext/);
  assert.equal(await h.secrets.getProviderKey("openrouter", "anything"), null);
  assert.equal(h.logged.length > 0, true, "the read failure is logged");
});

for (const [label, contents] of [
  ["truncated JSON", `{"openrouter": "dj`],
  ["a JSON array", `["${SENTINEL}"]`],
] as const) {
  test(`a corrupt store (${label}) fails closed without being overwritten`, async () => {
    const h = await harness();
    await fs.writeFile(h.file, contents);

    assert.equal(await h.secrets.getKey("openrouter"), null);
    assert.equal(await h.secrets.hasKey("openrouter"), false);
    await assert.rejects(h.secrets.getKeyStrict("openrouter"));
    // A write must not replace the unreadable map (which may hold recoverable
    // ciphertext for other providers) with a fresh one.
    await assert.rejects(h.secrets.setKey("anthropic", SENTINEL));
    assert.equal(await fs.readFile(h.file, "utf8"), contents);
    assertNoPlaintext(logText(h.logged), SENTINEL);
  });
}

test("a non-string entry is treated as absent rather than decrypted", async () => {
  const h = await harness();
  await fs.writeFile(h.file, JSON.stringify({ openrouter: { future: "shape" } }));
  assert.equal(await h.secrets.getKey("openrouter"), null);
  assert.equal(await h.secrets.getKeyStrict("openrouter"), null);
  assert.equal(await h.secrets.hasKey("openrouter"), false);
});

test("length bounds and a stale mutation guard refuse the write without touching disk", async () => {
  const h = await harness();
  await assert.rejects(h.secrets.setInternalKey("aiden-internal:tts", "x".repeat(17), 16), /16 characters/);
  await assert.rejects(
    h.secrets.setKey("openrouter", SENTINEL, () => false),
    /no longer active/,
  );
  assert.deepEqual(await fs.readdir(h.userData), []);
});

test("an image-generation slot and a chat provider slot never satisfy each other", async () => {
  const h = await harness();
  await h.secrets.setKey("aiden-internal:image-gen:fal", IMAGE_SENTINEL);
  await h.secrets.setProviderKey("openrouter", SENTINEL, "https://openrouter.ai/api/v1");

  assert.equal(await h.secrets.getKey("fal"), null);
  assert.equal(await h.secrets.getProviderKey("fal", "https://fal.run"), null);
  assert.equal(await h.secrets.getKey("aiden-internal:image-gen:openrouter"), null);
  assert.equal(await h.secrets.getKey("aiden-internal:image-gen:fal"), IMAGE_SENTINEL);
  assert.equal(
    await h.secrets.getProviderKey("openrouter", "https://openrouter.ai/api/v1"),
    SENTINEL,
  );
});

test("deleting a credential family removes its children only, at a colon boundary", async () => {
  const h = await harness();
  await h.secrets.setKey("aiden-internal:image-gen:fal", IMAGE_SENTINEL);
  await h.secrets.setKey("aiden-internal:image-gen:replicate", IMAGE_SENTINEL);
  await h.secrets.setKey("aiden-internal:image-generator", "unrelated-prefix-match");
  await h.secrets.setProviderKey("openrouter", SENTINEL, "https://openrouter.ai/api/v1");
  await h.secrets.setKey("open", "short-id");

  await h.secrets.deleteKeyFamily("aiden-internal:image-gen");
  await h.secrets.deleteKeyFamily("open");

  assert.equal(await h.secrets.hasKey("aiden-internal:image-gen:fal"), false);
  assert.equal(await h.secrets.hasKey("aiden-internal:image-gen:replicate"), false);
  assert.equal(await h.secrets.getKey("aiden-internal:image-generator"), "unrelated-prefix-match");
  assert.equal(await h.secrets.hasKey("open"), false);
  assert.equal(
    await h.secrets.getProviderKey("openrouter", "https://openrouter.ai/api/v1"),
    SENTINEL,
  );
});

test("a bound provider key is released only for its exact binding", async () => {
  const h = await harness();
  await h.secrets.setProviderKey("custom", SENTINEL, "https://api.example.test/v1");

  assert.equal(await h.secrets.getProviderKey("custom", "https://api.example.test/v1"), SENTINEL);
  assert.equal(await h.secrets.getProviderKey("custom", "https://attacker.example.test/v1"), null);
  assertNoPlaintext(await h.diskContents(), "https://api.example.test/v1");

  await h.secrets.deleteKey("custom");
  assert.equal(await h.secrets.getProviderKey("custom", "https://api.example.test/v1"), null);
  assert.deepEqual(JSON.parse(await fs.readFile(h.file, "utf8")), {});
});

test("an unbound key never satisfies a bound read until it is explicitly adopted once", async () => {
  const h = await harness();
  await h.secrets.setKey("context7", SENTINEL);
  assert.equal(await h.secrets.getProviderKey("context7", "https://mcp.context7.com"), null);

  assert.equal(
    await h.secrets.getOrBindLegacyProviderKey("context7", "https://mcp.context7.com"),
    SENTINEL,
  );
  assert.equal(await h.secrets.getProviderKey("context7", "https://mcp.context7.com"), SENTINEL);
  // Once bound, a different endpoint can no longer adopt the key.
  assert.equal(
    await h.secrets.getOrBindLegacyProviderKey("context7", "https://other.example.test"),
    null,
  );
});

test("quarantining an unbound legacy key hides it from every active read", async () => {
  const h = await harness();
  await h.secrets.setKey("legacy", SENTINEL);
  await h.secrets.setProviderKey("bound", SENTINEL, "https://bound.example.test");

  await h.secrets.quarantineUnboundProviderKey("legacy");
  await h.secrets.quarantineUnboundProviderKey("bound");

  assert.equal(await h.secrets.getKey("legacy"), null);
  assert.equal(await h.secrets.getOrBindLegacyProviderKey("legacy", "https://x.example.test"), null);
  assert.equal(await h.secrets.getProviderKey("bound", "https://bound.example.test"), SENTINEL);
  assertNoPlaintext(await h.diskContents(), SENTINEL);
});

test("reconciling an endpoint rotation swaps the matching quarantined key back", async () => {
  const h = await harness();
  const first = "https://one.example.test";
  const second = "https://two.example.test";
  await h.secrets.setProviderKey("custom", `${SENTINEL}-one`, first);

  await h.secrets.reconcileProviderKeyQuarantine("custom", second);
  assert.equal(await h.secrets.getProviderKey("custom", first), null);
  assert.equal(await h.secrets.getProviderKey("custom", second), null);

  await h.secrets.setProviderKey("custom", `${SENTINEL}-two`, second);
  await h.secrets.reconcileProviderKeyQuarantine("custom", first);
  assert.equal(await h.secrets.getProviderKey("custom", first), `${SENTINEL}-one`);
  assert.equal(await h.secrets.getProviderKey("custom", second), null);

  await h.secrets.reconcileProviderKeyQuarantine("custom", second);
  assert.equal(await h.secrets.getProviderKey("custom", second), `${SENTINEL}-two`);
});

test("alias migration moves and binds a key, and leaves the map untouched on conflict", async () => {
  const h = await harness();
  await h.secrets.setKey("old-alias", SENTINEL);
  assert.equal(
    await h.secrets.migrateProviderKeysWithBindings([
      { legacyProviderId: "old-alias", providerId: "new-id", binding: "https://new.example.test" },
    ]),
    true,
  );
  assert.equal(await h.secrets.getKey("old-alias"), null);
  assert.equal(await h.secrets.getProviderKey("new-id", "https://new.example.test"), SENTINEL);

  await h.secrets.setKey("second-alias", "other");
  const before = await fs.readFile(h.file, "utf8");
  assert.equal(
    await h.secrets.migrateProviderKeysWithBindings([
      { legacyProviderId: "second-alias", providerId: "new-id", binding: "https://new.example.test" },
    ]),
    false,
  );
  assert.equal(await fs.readFile(h.file, "utf8"), before);
});

test("clearAll removes every stored credential", async () => {
  const h = await harness();
  await h.secrets.setKey("openrouter", SENTINEL);
  await h.secrets.setKey("aiden-internal:image-gen:fal", IMAGE_SENTINEL);
  await h.secrets.clearAll();
  assert.equal(await h.secrets.hasKey("openrouter"), false);
  assert.equal(await h.secrets.hasKey("aiden-internal:image-gen:fal"), false);
  assertNoPlaintext(await h.diskContents(), SENTINEL);
});
