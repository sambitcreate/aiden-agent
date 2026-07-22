import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { Credential } from "@earendil-works/pi-ai";
import { EncryptedPiCredentialStore, type CredentialCipher } from "./pi-credential-store-core.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function cipher(overrides: Partial<CredentialCipher> = {}): CredentialCipher {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => {
      const text = value.toString("utf8");
      if (!text.startsWith("encrypted:")) throw new Error("bad ciphertext");
      return text.slice("encrypted:".length);
    },
    ...overrides,
  };
}

async function fixture(
  overrides: Partial<CredentialCipher> = {},
  storeOptions: {
    onLockQueued?: (scope: string) => void;
    onDurabilityWarning?: (error: Error) => void;
    syncDirectory?: (directory: string) => Promise<void>;
  } = {},
) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-pi-credentials-"));
  temporaryDirectories.push(directory);
  const file = path.join(directory, "credentials.json");
  const makeStore = () =>
    new EncryptedPiCredentialStore({
      filePath: () => file,
      cipher: cipher(overrides),
      ...storeOptions,
    });
  return {
    file,
    makeStore,
    store: makeStore(),
  };
}

const TEST_EXPIRY = 2_000_000_000_000;

const oauth = (access: string, refresh = `refresh-${access}`): Credential => ({
  type: "oauth",
  access,
  refresh,
  expires: TEST_EXPIRY,
  accountId: "account-test",
});

test("stores full credentials encrypted and lists metadata only", async () => {
  const { file, store } = await fixture();
  await store.modify("openai-codex", async () => oauth("access-secret"));

  assert.deepEqual(await store.read("openai-codex"), oauth("access-secret"));
  assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);
  const raw = await fs.readFile(file, "utf8");
  assert.doesNotMatch(raw, /access-secret|refresh-access-secret|account-test/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("a post-commit directory sync failure warns without rejecting the committed credential", async () => {
  const warnings: Error[] = [];
  const { store } = await fixture(
    {},
    {
      syncDirectory: async () => {
        throw new Error("directory sync unsupported");
      },
      onDurabilityWarning: (error) => warnings.push(error),
    },
  );
  await store.modify("artificial-analysis", async () => ({ type: "api_key", key: "secret" }));
  assert.deepEqual(await store.read("artificial-analysis"), { type: "api_key", key: "secret" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /unsupported/u);
});

test("a throwing durability reporter cannot turn a committed credential write into a failure", async () => {
  const { store } = await fixture(
    {},
    {
      syncDirectory: async () => {
        throw new Error("directory sync unsupported");
      },
      onDurabilityWarning: () => {
        throw new Error("diagnostic failure");
      },
    },
  );
  await store.modify("artificial-analysis", async () => ({ type: "api_key", key: "secret" }));
  assert.deepEqual(await store.read("artificial-analysis"), { type: "api_key", key: "secret" });
});

test("serializes same-provider refreshes and preserves rotated credentials", async () => {
  const { store } = await fixture();
  await store.modify("openai-codex", async () => oauth("old"));

  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const seen: string[] = [];
  const first = store.modify("openai-codex", async (current) => {
    seen.push((current as { access: string }).access);
    firstStarted();
    await firstMayFinish;
    return oauth("first");
  });
  await firstDidStart;
  const second = store.modify("openai-codex", async (current) => {
    seen.push((current as { access: string }).access);
    return oauth("second");
  });
  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(seen, ["old", "first"]);
  assert.deepEqual(await store.read("openai-codex"), oauth("second"));
});

test("does not lose entries when different providers update concurrently", async () => {
  const { store, makeStore } = await fixture();
  const otherStore = makeStore();
  await Promise.all([
    store.modify("openai-codex", async () => oauth("codex")),
    otherStore.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-secret" })),
  ]);

  assert.equal((await store.read("openai-codex"))?.type, "oauth");
  assert.deepEqual(await store.read("anthropic"), { type: "api_key", key: "anthropic-secret" });
});

test("serializes refresh and logout across independent store instances", async () => {
  const { store, file } = await fixture();
  await store.modify("openai-codex", async () => oauth("old"));

  let releaseRefresh!: () => void;
  const refreshMayFinish = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshStarted!: () => void;
  const refreshDidStart = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const refresh = store.modify("openai-codex", async () => {
    refreshStarted();
    await refreshMayFinish;
    return oauth("rotated");
  });
  await refreshDidStart;

  let logoutQueued!: () => void;
  const logoutDidQueue = new Promise<void>((resolve) => {
    logoutQueued = resolve;
  });
  const otherStore = new EncryptedPiCredentialStore({
    filePath: () => file,
    cipher: cipher(),
    onLockQueued: (scope) => {
      if (scope === "provider:openai-codex") logoutQueued();
    },
  });
  const logout = otherStore.delete("openai-codex");
  await logoutDidQueue;
  releaseRefresh();
  await Promise.all([refresh, logout]);
  assert.equal(await store.read("openai-codex"), undefined);
});

test("a second store instance observes a rotated token before modifying", async () => {
  const { store, makeStore } = await fixture();
  const otherStore = makeStore();
  await store.modify("openai-codex", async () => oauth("old"));
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstDidStart = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = store.modify("openai-codex", async () => {
    firstStarted();
    await firstMayFinish;
    return oauth("first");
  });
  await firstDidStart;
  const second = otherStore.modify("openai-codex", async (current) =>
    oauth(`after-${(current as { access: string }).access}`),
  );
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(await store.read("openai-codex"), oauth("after-first"));
});

test("undefined and rejected modifiers leave the current credential intact", async () => {
  const { store } = await fixture();
  await store.modify("openai-codex", async () => oauth("current"));
  assert.deepEqual(await store.modify("openai-codex", async () => undefined), oauth("current"));
  await assert.rejects(
    store.modify("openai-codex", async () => {
      throw new Error("refresh failed");
    }),
    /refresh failed/,
  );
  assert.deepEqual(await store.read("openai-codex"), oauth("current"));
});

test("delete is serialized with modify", async () => {
  const { store } = await fixture();
  await store.modify("openai-codex", async () => oauth("current"));
  await store.delete("openai-codex");
  assert.equal(await store.read("openai-codex"), undefined);
  assert.deepEqual(await store.list(), []);
});

test("fails closed for unavailable secure storage, corrupt files, and bad ciphertext", async () => {
  const unavailable = await fixture({ isEncryptionAvailable: () => false });
  await assert.rejects(
    unavailable.store.modify("openai-codex", async () => oauth("secret")),
    /Secure storage is unavailable/,
  );

  const corrupt = await fixture();
  await fs.writeFile(corrupt.file, "not json", "utf8");
  await assert.rejects(corrupt.store.list(), /not valid JSON/);

  const undecryptable = await fixture();
  await undecryptable.store.modify("openai-codex", async () => oauth("secret"));
  const brokenReader = new EncryptedPiCredentialStore({
    filePath: () => undecryptable.file,
    cipher: cipher({
      decryptString: () => {
        throw new Error("keychain failure");
      },
    }),
  });
  await assert.rejects(brokenReader.read("openai-codex"), /could not be decrypted/);

  const sentinel = "sentinel-access-token-should-never-leak";
  const malformedReader = new EncryptedPiCredentialStore({
    filePath: () => undecryptable.file,
    cipher: cipher({ decryptString: () => `{"access":"${sentinel}` }),
  });
  await assert.rejects(malformedReader.read("openai-codex"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /invalid or corrupted/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    return true;
  });
});
