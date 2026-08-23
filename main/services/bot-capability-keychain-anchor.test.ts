import assert from "node:assert/strict";
import test from "node:test";
import {
  botCapabilityKeychainAccountForCanonicalRoot,
  createBotCapabilityKeychainAnchor,
  createBotCapabilityKeychainBootstrapMarker,
  createTelegramBotBindingKeychainAnchor,
  createTelegramBotBindingKeychainBootstrapMarker,
  type BotCapabilitySecurityCommand,
} from "./bot-capability-keychain-anchor.js";

const TEST_ACCOUNT = botCapabilityKeychainAccountForCanonicalRoot(
  "/private/aiden-test-profile",
);

test("Keychain authority sends its value only through bounded stdin", async () => {
  let stored: string | null = null;
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const command: BotCapabilitySecurityCommand = async (args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    if (args[0] === "find-generic-password") {
      return stored === null
        ? { exitCode: 44, stdout: "", stderr: "item could not be found" }
        : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
    }
    assert.equal(args[args.length - 1], "-w");
    assert.ok(stdin);
    stored = stdin;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const anchor = createBotCapabilityKeychainAnchor({
    account: TEST_ACCOUNT,
    command,
  });
  const value = '{"signed":"authority-value"}';
  await anchor.store(value, null);
  assert.equal(await anchor.load(), value);
  assert.equal(
    calls.some(({ args }) => args.includes(value)),
    false,
  );
  assert.deepEqual(
    calls
      .filter(({ args }) => args[0] === "add-generic-password")
      .map(({ stdin }) => stdin),
    [value],
  );
});

test("Keychain authority uses compare-before-store and fails closed on command errors", async () => {
  const conflict = createBotCapabilityKeychainAnchor({
    account: TEST_ACCOUNT,
    command: async () => ({ exitCode: 0, stdout: "current\n", stderr: "" }),
  });
  await assert.rejects(conflict.store("next", null), /changed outside/u);

  const unavailable = createBotCapabilityKeychainAnchor({
    account: TEST_ACCOUNT,
    command: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
  });
  await assert.rejects(unavailable.load(), /unavailable/u);
});

test("canonical user-data roots isolate distinct authority and bootstrap marker items", async () => {
  const values = new Map<string, string>();
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const command: BotCapabilitySecurityCommand = async (args, stdin) => {
    calls.push({ args: [...args], ...(stdin === undefined ? {} : { stdin }) });
    const accountIndex = args.indexOf("-a") + 1;
    const account = args[accountIndex];
    const serviceIndex = args.indexOf("-s") + 1;
    const service = args[serviceIndex];
    assert.ok(account);
    assert.ok(service);
    const item = `${service}/${account}`;
    if (args[0] === "find-generic-password") {
      const stored = values.get(item);
      return stored === undefined
        ? { exitCode: 44, stdout: "", stderr: "item could not be found" }
        : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
    }
    assert.ok(stdin);
    values.set(item, stdin);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const productionAccount = botCapabilityKeychainAccountForCanonicalRoot(
    "/Users/test/Library/Application Support/Aiden Agent",
  );
  const developmentAccount = botCapabilityKeychainAccountForCanonicalRoot(
    "/Users/test/Library/Application Support/Aiden Agent Dev",
  );
  assert.notEqual(productionAccount, developmentAccount);
  assert.equal(
    productionAccount,
    botCapabilityKeychainAccountForCanonicalRoot(
      "/Users/test/Library/Application Support/../Application Support/Aiden Agent",
    ),
  );

  const production = createBotCapabilityKeychainAnchor({
    account: productionAccount,
    command,
  });
  const development = createBotCapabilityKeychainAnchor({
    account: developmentAccount,
    command,
  });
  const productionMarker = createBotCapabilityKeychainBootstrapMarker({
    account: productionAccount,
    command,
  });
  const developmentMarker = createBotCapabilityKeychainBootstrapMarker({
    account: developmentAccount,
    command,
  });
  const telegramBindings = createTelegramBotBindingKeychainAnchor({
    account: productionAccount,
    command,
  });
  const telegramBootstrap = createTelegramBotBindingKeychainBootstrapMarker({
    account: productionAccount,
    command,
  });
  const productionProof = "a".repeat(64);
  const developmentProof = "b".repeat(64);
  await production.store("production-head", null);
  await development.store("development-head", null);
  await productionMarker.store(
    { phase: "pending", keyProof: productionProof },
    null,
  );
  await productionMarker.store(
    { phase: "consumed", keyProof: productionProof },
    { phase: "pending", keyProof: productionProof },
  );
  await developmentMarker.store(
    { phase: "pending", keyProof: developmentProof },
    null,
  );
  await telegramBindings.store("7:" + "c".repeat(64), null);
  await telegramBootstrap.store("consumed", null);
  await developmentMarker.store(
    { phase: "consumed", keyProof: developmentProof },
    { phase: "pending", keyProof: developmentProof },
  );
  assert.equal(await production.load(), "production-head");
  assert.equal(await development.load(), "development-head");
  assert.deepEqual(await productionMarker.load(), {
    phase: "consumed",
    keyProof: productionProof,
  });
  assert.deepEqual(await developmentMarker.load(), {
    phase: "consumed",
    keyProof: developmentProof,
  });
  assert.equal(await telegramBindings.load(), "7:" + "c".repeat(64));
  assert.equal(await telegramBootstrap.load(), "consumed");
  assert.equal(values.size, 6);
  assert.equal(
    new Set([...values.keys()].map((key) => key.split("/", 1)[0])).size,
    4,
  );
  const secrets = [
    "production-head",
    "development-head",
    `pending:${productionProof}`,
    `consumed:${productionProof}`,
    `pending:${developmentProof}`,
    `consumed:${developmentProof}`,
    "7:" + "c".repeat(64),
    "consumed",
  ];
  assert.ok(
    calls.every(({ args }) =>
      secrets.every((secret) => !args.includes(secret)),
    ),
  );
  assert.ok(
    calls
      .filter(({ args }) => args[0] === "add-generic-password")
      .every(
        ({ args, stdin }) => args[args.length - 1] === "-w" && Boolean(stdin),
      ),
  );
});

test("bootstrap marker rejects corrupt values and non-monotonic transitions", async () => {
  let stored: string | null = null;
  const command: BotCapabilitySecurityCommand = async (args, stdin) => {
    if (args[0] === "find-generic-password") {
      return stored === null
        ? { exitCode: 44, stdout: "", stderr: "item could not be found" }
        : { exitCode: 0, stdout: `${stored}\n`, stderr: "" };
    }
    assert.ok(stdin);
    stored = stdin;
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const marker = createBotCapabilityKeychainBootstrapMarker({
    account: TEST_ACCOUNT,
    command,
  });
  const proof = "c".repeat(64);
  await assert.rejects(
    marker.store({ phase: "consumed", keyProof: proof }, null),
    /transition is invalid/u,
  );
  stored = "pending:not-a-proof";
  await assert.rejects(marker.load(), /marker is invalid/u);
});
