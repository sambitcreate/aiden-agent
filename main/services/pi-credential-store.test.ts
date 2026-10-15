import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { build } from "esbuild";
import type { CredentialStore } from "@earendil-works/pi-ai";

// Exercises the production wiring of `piCredentialStore` (file location,
// secureStorage cipher, Bot-authority fencing) against a synthetic Electron
// boundary. The store's own semantics are covered by pi-credential-store-core.test.ts.

const CHAT_SENTINEL = "sk-or-SENTINEL-chat-41b7";
const IMAGE_SENTINEL = "fal-SENTINEL-image-c90e";

interface WiredModules {
  piCredentialStore: CredentialStore;
  botRuntimeInventoryLeases: { revision(): number };
  createImageCredentialView(base: CredentialStore): CredentialStore;
}

const servicesDirectory = fileURLToPath(new URL(".", import.meta.url));

const bundled = build({
  stdin: {
    contents: [
      `export { piCredentialStore } from "./pi-credential-store.js";`,
      `export { botRuntimeInventoryLeases } from "./bot-runtime-inventory-lease.js";`,
      `export { createImageCredentialView } from "./image-generation/credential-view.js";`,
    ].join("\n"),
    resolveDir: servicesDirectory,
    loader: "ts",
    sourcefile: "pi-credential-store-wiring.ts",
  },
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
          contents: "module.exports = globalThis.__aidenPiCredentialTestPlatform;",
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

async function harness() {
  const userData = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-pi-wiring-"));
  temporaryDirectories.push(userData);
  const safeStorage = {
    available: true,
    isEncryptionAvailable() {
      return this.available;
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from("v10"), Buffer.from(value, "utf8").map((byte) => byte ^ 0x33)]),
    decryptString: (value: Buffer) =>
      Buffer.from(value.subarray(3).map((byte) => byte ^ 0x33)).toString("utf8"),
  };
  (globalThis as Record<string, unknown>).__aidenPiCredentialTestPlatform = {
    app: { getPath: (name: string) => (name === "userData" ? userData : assert.fail(name)) },
    safeStorage,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  const module = { exports: {} as WiredModules };
  new Function("require", "module", "exports", await bundled)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  return { ...module.exports, safeStorage, userData };
}

async function diskContents(directory: string): Promise<string> {
  const names = await fs.readdir(directory);
  const contents = await Promise.all(
    names.map((name) => fs.readFile(path.join(directory, name), "utf8")),
  );
  return contents.join("\n");
}

function assertNoPlaintext(contents: string, secret: string) {
  assert.equal(contents.includes(secret), false, "plaintext secret was written to disk");
}

test("credentials persist encrypted in the userData credential file", async () => {
  const h = await harness();
  await h.piCredentialStore.modify("openrouter", async () => ({
    type: "api_key",
    key: CHAT_SENTINEL,
  }));

  assert.deepEqual(await fs.readdir(h.userData), ["pi-provider-credentials.json"]);
  assertNoPlaintext(await diskContents(h.userData), CHAT_SENTINEL);
  assert.deepEqual(await h.piCredentialStore.read("openrouter"), {
    type: "api_key",
    key: CHAT_SENTINEL,
  });
});

test("unavailable OS encryption refuses writes and reads without leaking the key", async () => {
  const h = await harness();
  await h.piCredentialStore.modify("openrouter", async () => ({
    type: "api_key",
    key: CHAT_SENTINEL,
  }));
  const before = await diskContents(h.userData);
  h.safeStorage.available = false;

  await assert.rejects(
    h.piCredentialStore.modify("anthropic", async () => ({ type: "api_key", key: CHAT_SENTINEL })),
    (error: Error) => /Secure storage is unavailable/.test(error.message) &&
      !error.message.includes(CHAT_SENTINEL),
  );
  await assert.rejects(h.piCredentialStore.read("openrouter"), /Secure storage is unavailable/);
  assert.equal(await diskContents(h.userData), before);
});

test("image-generation writes leave Bot authority intact while chat credential changes fence it", async () => {
  const h = await harness();
  const images = h.createImageCredentialView(h.piCredentialStore);
  const start = h.botRuntimeInventoryLeases.revision();

  await images.modify("fal", async () => ({ type: "api_key", key: IMAGE_SENTINEL }));
  await images.delete("fal");
  assert.equal(h.botRuntimeInventoryLeases.revision(), start);

  await h.piCredentialStore.modify("openrouter", async () => ({
    type: "api_key",
    key: CHAT_SENTINEL,
  }));
  const afterLogin = h.botRuntimeInventoryLeases.revision();
  assert.ok(afterLogin > start, "a chat key change invalidates Bot runtime authority");

  // Re-saving the same API key is not a grant change.
  await h.piCredentialStore.modify("openrouter", async () => ({
    type: "api_key",
    key: CHAT_SENTINEL,
  }));
  assert.equal(h.botRuntimeInventoryLeases.revision(), afterLogin);
});

test("image keys and chat keys share the file but never authorize each other", async () => {
  const h = await harness();
  const images = h.createImageCredentialView(h.piCredentialStore);
  await images.modify("fal", async () => ({ type: "api_key", key: IMAGE_SENTINEL }));
  await h.piCredentialStore.modify("openrouter", async () => ({
    type: "api_key",
    key: CHAT_SENTINEL,
  }));

  assert.equal(await h.piCredentialStore.read("fal"), undefined);
  assert.equal(await images.read("openrouter"), undefined);
  assert.deepEqual(await images.list(), [{ providerId: "fal", type: "api_key" }]);
  assert.deepEqual(await images.read("fal"), { type: "api_key", key: IMAGE_SENTINEL });
  const contents = await diskContents(h.userData);
  assertNoPlaintext(contents, IMAGE_SENTINEL);
  assertNoPlaintext(contents, CHAT_SENTINEL);
});
