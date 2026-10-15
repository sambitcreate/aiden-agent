import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  PAIRING_REQUEST_SETTINGS_FILE,
  createAidenPairingRequestNotifier,
  createAidenPairingRequestSettingsStore,
} from "./aiden-remote-pairing-request-host.js";
import type { AidenPairingRequestPrompt } from "./aiden-remote-pairing-requests.js";

async function tmpDir(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-pairing-settings-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("connection requests are accepted on first run and a saved choice survives a restart", async (t) => {
  const directory = await tmpDir(t);
  assert.equal(await createAidenPairingRequestSettingsStore(() => directory).load(), true);

  await createAidenPairingRequestSettingsStore(() => directory).save(false);
  assert.equal(await createAidenPairingRequestSettingsStore(() => directory).load(), false);

  await createAidenPairingRequestSettingsStore(() => directory).save(true);
  assert.equal(await createAidenPairingRequestSettingsStore(() => directory).load(), true);
});

test("a damaged or unfamiliar settings file keeps connection requests off until the person chooses", async (t) => {
  for (const contents of [
    "{ not json",
    JSON.stringify({ version: 2, acceptPairingRequests: true }),
    JSON.stringify({ version: 1, acceptPairingRequests: "yes" }),
    JSON.stringify({ version: 1, acceptPairingRequests: true, extra: 1 }),
    JSON.stringify([true]),
  ]) {
    const directory = await tmpDir(t);
    await fs.writeFile(path.join(directory, PAIRING_REQUEST_SETTINGS_FILE), contents);
    const store = createAidenPairingRequestSettingsStore(() => directory);
    assert.equal(await store.load(), false, contents);
    // Choosing again replaces the damaged file.
    await store.save(true);
    assert.equal(await createAidenPairingRequestSettingsStore(() => directory).load(), true, contents);
  }
});

function prompt(requestId: string, deviceName: string): AidenPairingRequestPrompt {
  return {
    requestId,
    deviceName,
    deviceType: "mac",
    transport: "lan",
    matchCode: "123456",
    expiresAt: new Date(0).toISOString(),
    approving: false,
  };
}

function notifierHarness(options: { supported?: boolean; failCreate?: boolean } = {}) {
  let prompts: AidenPairingRequestPrompt[] = [];
  let broadcasts = 0;
  let focused = 0;
  const errors: string[] = [];
  const shown: Array<{ title: string; body: string; click: () => void }> = [];
  const notify = createAidenPairingRequestNotifier({
    list: () => prompts,
    broadcast: () => {
      broadcasts += 1;
    },
    isSupported: () => options.supported ?? true,
    create: (content) => {
      if (options.failCreate) throw new Error("native failure for Travel MacBook");
      let click = () => {};
      return {
        on: (_event, listener) => {
          click = listener;
        },
        show: () => shown.push({ ...content, click: () => click() }),
      };
    },
    focusApp: () => {
      focused += 1;
    },
    hostNoun: "Mac",
    onError: (stage) => errors.push(stage),
  });
  return {
    notify,
    setPrompts: (next: AidenPairingRequestPrompt[]) => {
      prompts = next;
    },
    shown,
    errors,
    broadcasts: () => broadcasts,
    focused: () => focused,
  };
}

test("each connection request is announced once, by device name and without its code", () => {
  const harness = notifierHarness();
  harness.setPrompts([prompt("pairreq_a", "Travel MacBook")]);
  harness.notify();
  harness.notify();
  harness.setPrompts([prompt("pairreq_a", "Travel MacBook"), prompt("pairreq_b", "Studio Linux")]);
  harness.notify();

  assert.equal(harness.broadcasts(), 3);
  assert.deepEqual(
    harness.shown.map(({ title, body }) => ({ title, body })),
    [
      {
        title: "Connection request",
        body: "Travel MacBook wants to control this Mac. Open Aiden to compare the code.",
      },
      {
        title: "Connection request",
        body: "Studio Linux wants to control this Mac. Open Aiden to compare the code.",
      },
    ],
  );
  assert.ok(harness.shown.every(({ body }) => !body.includes("123456")));

  harness.shown[0]!.click();
  assert.equal(harness.focused(), 1);
});

test("a request that closes and a new one that arrives are told apart", () => {
  const harness = notifierHarness();
  harness.setPrompts([prompt("pairreq_a", "Travel MacBook")]);
  harness.notify();
  harness.setPrompts([]);
  harness.notify();
  harness.setPrompts([prompt("pairreq_c", "Travel MacBook")]);
  harness.notify();
  assert.equal(harness.shown.length, 2);
});

test("notification failures still refresh the app and report only the phase", () => {
  const unsupported = notifierHarness({ supported: false });
  unsupported.setPrompts([prompt("pairreq_a", "Travel MacBook")]);
  unsupported.notify();
  assert.equal(unsupported.broadcasts(), 1);
  assert.equal(unsupported.shown.length, 0);

  const failing = notifierHarness({ failCreate: true });
  failing.setPrompts([prompt("pairreq_a", "Travel MacBook")]);
  failing.notify();
  assert.equal(failing.broadcasts(), 1);
  assert.deepEqual(failing.errors, ["delivery"]);
});
