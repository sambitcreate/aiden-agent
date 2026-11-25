import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBotComputersStore, parseBotComputersState } from "./store.js";

test("state round-trips through an owner-only file and concurrent updates all land", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p8-store-"));
  const file = path.join(dir, "bot-computers", "state.json");
  const store = createBotComputersStore(file);
  assert.deepEqual((await store.read()).settings, { maxRunning: 2, idleStopMinutes: 10, defaultComputerMode: "shared" });
  await Promise.all(
    ["a", "b", "c"].map((botId, index) =>
      store.update((state) => {
        const vmName = `aiden-bot-${String(index).repeat(16)}`;
        state.vms[vmName] = { id: vmName, name: `Computer ${index + 1}`, kind: "dedicated", vmName, baseBuild: "25G83", createdAt: index };
        state.assignments[botId] = vmName;
      }),
    ),
  );
  const state = await store.read();
  assert.deepEqual(Object.keys(state.computers).sort(), ["a", "b", "c"]);
  assert.deepEqual(Object.keys(state.assignments).sort(), ["a", "b", "c"]);
  assert.equal(Object.keys(state.vms).length, 3);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
});

test("a damaged file keeps what is valid and drops foreign VM names and bad settings", async () => {
  const parsed = parseBotComputersState({
    settings: { maxRunning: 5, idleStopMinutes: 15, defaultComputerMode: "invalid" },
    setup: { baseBuild: "25G83", ipswPath: "relative.ipsw" },
    computers: {
      good: { vmName: "aiden-bot-0123456789abcdef", baseBuild: "25G83", createdAt: 1, lastUsedAt: 2 },
      foreign: { vmName: "my-own-vm", baseBuild: "25G83", createdAt: 1 },
      broken: "nope",
    },
  });
  assert.deepEqual(parsed.settings, { maxRunning: 2, idleStopMinutes: 15, defaultComputerMode: "shared" });
  assert.deepEqual(parsed.setup, { baseBuild: "25G83" });
  assert.deepEqual(Object.keys(parsed.computers), ["good"]);
  assert.equal(parsed.assignments.good, "aiden-bot-0123456789abcdef");
  assert.equal(parsed.vms["aiden-bot-0123456789abcdef"]?.kind, "dedicated");

  const dir = mkdtempSync(path.join(tmpdir(), "p8-store-bad-"));
  const file = path.join(dir, "state.json");
  writeFileSync(file, "{not json");
  assert.deepEqual((await createBotComputersStore(file).read()).computers, {});
});

test("shared and dedicated VMs with multiple assignments round-trip and drop dangling assignments", () => {
  const parsed = parseBotComputersState({
    settings: { maxRunning: 3, idleStopMinutes: 15, defaultComputerMode: "dedicated" },
    setup: { guestOs: "linux", baseBuild: "20261123-2671" },
    vms: {
      shared: {
        id: "shared",
        name: "Shared computer",
        kind: "shared",
        vmName: "aiden-vm-shared",
        baseBuild: "20261123-2671",
        createdAt: 10,
      },
      "vm-abc123": {
        id: "vm-abc123",
        name: "Research Linux",
        kind: "dedicated",
        vmName: "aiden-vm-0123456789abcdef",
        baseBuild: "20261123-2671",
        createdAt: 20,
      },
    },
    assignments: {
      ada: "shared",
      ben: "shared",
      cyd: "vm-abc123",
      ghost: "vm-missing",
    },
  });
  assert.equal(parsed.settings.defaultComputerMode, "dedicated");
  assert.deepEqual(parsed.assignments, { ada: "shared", ben: "shared", cyd: "vm-abc123" });
  assert.equal(parsed.computers.ada?.vmName, "aiden-vm-shared");
  assert.equal(parsed.computers.ben?.vmName, "aiden-vm-shared");
  assert.equal(parsed.computers.cyd?.vmName, "aiden-vm-0123456789abcdef");
  assert.equal(parsed.computers.ghost, undefined);
});

test("the guest driver flag is kept for a base and its computers only when it is well formed", () => {
  const driver = { version: "0.38.0", home: "/Users/lume", uid: 501 };
  const parsed = parseBotComputersState({
    setup: { baseBuild: "25G83", guestDriver: driver },
    computers: {
      ada: { vmName: `aiden-bot-${"a".repeat(16)}`, baseBuild: "25G83", createdAt: 1, guestDriver: driver },
      bea: { vmName: `aiden-bot-${"b".repeat(16)}`, baseBuild: "25G83", createdAt: 2, guestDriver: { ...driver, home: "/var/root" } },
      cy: { vmName: `aiden-bot-${"c".repeat(16)}`, baseBuild: "25G83", createdAt: 3, guestDriver: { ...driver, version: "latest" } },
    },
  });
  assert.deepEqual(parsed.setup.guestDriver, driver);
  assert.deepEqual(parsed.computers.ada?.guestDriver, driver);
  assert.equal(parsed.computers.bea?.guestDriver, undefined, "a home outside /Users is dropped, the computer kept");
  assert.equal(parsed.computers.cy?.guestDriver, undefined);
  // Without a base there is nothing the flag could describe.
  assert.equal(parseBotComputersState({ setup: { guestDriver: driver } }).setup.guestDriver, undefined);

  // Linux bases allow /home/<user> guest homes and maxRunning up to 4.
  const linuxDriver = { version: "0.38.0", home: "/home/lume", uid: 1000 };
  const linuxParsed = parseBotComputersState({
    settings: { maxRunning: 4, idleStopMinutes: 10 },
    setup: { guestOs: "linux", baseBuild: "20261123-2671", guestDriver: linuxDriver },
    computers: {
      ada: { vmName: `aiden-bot-${"d".repeat(16)}`, baseBuild: "20261123-2671", createdAt: 4, guestDriver: linuxDriver },
      migrated: { vmName: `aiden-bot-${"e".repeat(16)}`, baseBuild: "", createdAt: 5, migratedFromMacos: true },
    },
    macosMigration: { completedAt: 1700000000000, freedBytes: 58_000_000_000, noticeDismissed: false },
  });
  assert.equal(linuxParsed.settings.maxRunning, 4);
  assert.equal(linuxParsed.setup.guestOs, "linux");
  assert.deepEqual(linuxParsed.setup.guestDriver, linuxDriver);
  assert.deepEqual(linuxParsed.computers.ada?.guestDriver, linuxDriver);
  assert.equal(linuxParsed.computers.migrated?.migratedFromMacos, true);
  assert.equal(linuxParsed.computers.migrated?.baseBuild, "");
  assert.deepEqual(linuxParsed.macosMigration, { completedAt: 1700000000000, freedBytes: 58_000_000_000 });

  const dismissed = parseBotComputersState({
    macosMigration: { completedAt: 1700000000000, freedBytes: 0, noticeDismissed: true },
  });
  assert.deepEqual(dismissed.macosMigration, { completedAt: 1700000000000, freedBytes: 0, noticeDismissed: true });
  assert.equal(parseBotComputersState({ macosMigration: { completedAt: -1, freedBytes: 0 } }).macosMigration, undefined);
});

test("store rejects reserved base VM names and prototype keys, deduplicates legacy VMs, and backs up corrupt JSON", async () => {
  const parsed = parseBotComputersState({
    vms: {
      constructor: {
        id: "constructor",
        name: "Evil",
        kind: "dedicated",
        vmName: "aiden-vm-0123456789abcdef",
        baseBuild: "20261123-2671",
        createdAt: 1,
      },
      "vm-base": {
        id: "vm-base",
        name: "Base hijack",
        kind: "dedicated",
        vmName: "aiden-base",
        baseBuild: "20261123-2671",
        createdAt: 1,
      },
      "vm-staging": {
        id: "vm-staging",
        name: "Staging hijack",
        kind: "dedicated",
        vmName: "aiden-base-next",
        baseBuild: "20261123-2671",
        createdAt: 1,
      },
      shared: {
        id: "shared",
        name: "Wrong shared vmName",
        kind: "shared",
        vmName: "aiden-vm-0123456789abcdef",
        baseBuild: "20261123-2671",
        createdAt: 1,
      },
      "vm-good": {
        id: "vm-good",
        name: "Good VM",
        kind: "dedicated",
        vmName: "aiden-vm-fedcba9876543210",
        baseBuild: "20261123-2671",
        createdAt: 2,
      },
    },
    assignments: {
      ada: "vm-good",
      ben: "constructor",
      cyd: "vm-base",
    },
  });
  assert.deepEqual(Object.keys(parsed.vms), ["vm-good"]);
  assert.deepEqual(parsed.assignments, { ada: "vm-good" });

  // Legacy computers get distinct names and never duplicate the same vmName.
  const legacy = parseBotComputersState({
    computers: {
      ada: { vmName: "aiden-bot-0000000000000001", baseBuild: "20261123-2671", createdAt: 1 },
      ben: { vmName: "aiden-bot-0000000000000002", baseBuild: "20261123-2671", createdAt: 2 },
      dup: { vmName: "aiden-bot-0000000000000001", baseBuild: "20261123-2671", createdAt: 3 },
    },
  });
  assert.equal(Object.keys(legacy.vms).length, 2);
  assert.equal(legacy.vms["aiden-bot-0000000000000001"]?.name, "Dedicated computer");
  assert.equal(legacy.vms["aiden-bot-0000000000000002"]?.name, "Dedicated computer 2");
  assert.equal(legacy.vms["aiden-bot-0000000000000001"]?.legacyOwnerBotId, "ada");
  assert.equal(legacy.assignments.dup, "aiden-bot-0000000000000001");

  // Updating over corrupt state.json preserves a backup copy before overwriting.
  const dir = mkdtempSync(path.join(tmpdir(), "p8-store-corrupt-backup-"));
  const file = path.join(dir, "state.json");
  writeFileSync(file, "{corrupt json!!!");
  const store = createBotComputersStore(file);
  await store.update((draft) => {
    draft.settings.maxRunning = 3;
  });
  const backups = readdirSync(dir).filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(backups.length, 1, "corrupt state.json is backed up before overwriting");
  assert.equal(readFileSync(path.join(dir, backups[0]!), "utf8"), "{corrupt json!!!");
  assert.equal((await store.read()).settings.maxRunning, 3);

  // Downgrade-roundtrip: a state.json carrying only legacy `computers` entries referencing
  // `aiden-vm-shared` must restore the canonical `"shared"` VM and every Bot's assignment.
  const downgraded = parseBotComputersState({
    setup: { guestOs: "linux", baseBuild: "20261123-2671" },
    computers: {
      ada: { vmName: "aiden-vm-shared", baseBuild: "20261123-2671", createdAt: 10 },
      ben: { vmName: "aiden-vm-shared", baseBuild: "20261123-2671", createdAt: 10 },
      cyd: { vmName: "aiden-bot-0000000000000009", baseBuild: "20261123-2671", createdAt: 20 },
    },
  });
  assert.equal(downgraded.vms.shared?.kind, "shared");
  assert.equal(downgraded.vms.shared?.name, "Shared computer");
  assert.equal(downgraded.vms.shared?.vmName, "aiden-vm-shared");
  assert.equal(downgraded.vms.shared?.legacyOwnerBotId, undefined);
  assert.equal(downgraded.assignments.ada, "shared");
  assert.equal(downgraded.assignments.ben, "shared");
  assert.equal(downgraded.assignments.cyd, "aiden-bot-0000000000000009");
  assert.equal(downgraded.vms["aiden-bot-0000000000000009"]?.name, "Dedicated computer");

  // Disk VM names with control/bidi formatting chars fall back to the safe default, and extra prototype keys are dropped.
  const sanitized = parseBotComputersState({
    vms: {
      "vm-bidi": {
        id: "vm-bidi",
        name: "Evil\u202eVM",
        kind: "dedicated",
        vmName: "aiden-vm-1111111111111111",
        baseBuild: "20261123-2671",
        createdAt: 1,
      },
      tolocalestring: {
        id: "tolocalestring",
        name: "Bad",
        kind: "dedicated",
        vmName: "aiden-vm-2222222222222222",
        baseBuild: "20261123-2671",
        createdAt: 2,
      },
    },
    assignments: {
      toLocaleString: "vm-bidi",
      ada: "vm-bidi",
    },
  });
  assert.equal(sanitized.vms["vm-bidi"]?.name, "Dedicated computer");
  assert.deepEqual(Object.keys(sanitized.vms), ["vm-bidi"]);
  assert.deepEqual(Object.keys(sanitized.assignments), ["ada"]);
});
