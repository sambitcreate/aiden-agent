import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluatePiUpgradeReplay,
  type PiUpgradeReplayMeasurement,
} from "./pi-upgrade-evaluation.js";
import {
  installedApplicationIdentity,
  piUpgradeBehaviorEnabled,
  piUpgradeMemoryEligible,
  PiUpgradeRolloutStore,
  writePiUpgradeEvaluationReceipt,
} from "./pi-upgrade-rollout.js";
import { PiCompactionSessionStore } from "./pi-compaction-session-store.js";
import { runPiUpgradeReplayCases } from "./pi-upgrade-replay-runner.js";

async function passingMeasurements(): Promise<PiUpgradeReplayMeasurement[]> {
  return runPiUpgradeReplayCases();
}

async function journalFilesUnder(root: string): Promise<string[]> {
  const matches: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(candidate);
      else if (entry.name.endsWith(".jsonl")) matches.push(candidate);
    }
  }
  return matches;
}

test("executable replays emit the complete passing scorecard from observed outcomes", async () => {
  const measurements = await passingMeasurements();
  const report = evaluatePiUpgradeReplay(measurements);
  assert.equal(report.passed, true);
  assert.equal(report.caseCount, 7);
  assert.equal(report.continuationCorrectRatio, 1);
  assert.equal(report.pendingReferenceRetentionRatio, 1);
  assert.ok(report.tokenReductionRatio >= 0.25);
  assert.ok(report.emergencyProjectionRatio <= 0.15);
  assert.ok(report.totalDurationMs > 0);
  assert.equal(report.totalCostMicros, 0);
  assert.equal(report.totalCacheReadTokens, 0);

  const failed = measurements.map((measurement) => ({ ...measurement }));
  failed[0] = {
    ...failed[0]!,
    continuationCorrect: false,
    pendingReferencesRetained: 0,
    emergencyProjections: 1,
    noOpAttempts: 1,
    migrationFailures: 1,
    turnsUntilNextCompaction: 1,
  };
  assert.deepEqual(evaluatePiUpgradeReplay(failed).failures, [
    "continuation_correctness",
    "pending_reference_retention",
    "emergency_projection_frequency",
    "recompaction_interval",
    "no_op_attempts",
    "migration_failures",
  ]);
  assert.match(evaluatePiUpgradeReplay(failed.slice(1)).failures[0] ?? "", /missing:long_coding_chat/u);
  const weakCase = measurements.map((measurement, index) => index === 0
    ? { ...measurement, tokensAfter: Math.floor(measurement.tokensBefore * 0.9) }
    : measurement);
  assert.ok(evaluatePiUpgradeReplay(weakCase).failures.includes("per_case_token_reduction"));

  assert.throws(
    () => evaluatePiUpgradeReplay([{ ...measurements[0]!, unexpected: true } as PiUpgradeReplayMeasurement]),
    /required schema/u,
  );
  assert.throws(
    () => evaluatePiUpgradeReplay([{ ...measurements[0]!, tokensBefore: 0 }]),
    /lacks executable measurements/u,
  );
  assert.throws(
    () => evaluatePiUpgradeReplay([{ ...measurements[0]!, pendingReferencesExpected: 0, pendingReferencesRetained: 0 }]),
    /pending-reference assertion/u,
  );
});

test("rollout eligibility is staged and the exact-zero rollback is fail-closed", () => {
  const oldChat = { createdAt: 1_000, messages: Array.from({ length: 150 }, () => ({})) } as never;
  const newChat = { createdAt: 3_000, messages: [] } as never;
  const policy = (stage: "internal_fixtures" | "developer_installs" | "new_chats" | "migrated_low_risk_chats" | "existing_long_chats") => ({
    version: 1 as const,
    stage,
    activatedAt: 2_000,
    revision: 1,
  });
  assert.equal(piUpgradeMemoryEligible(policy("internal_fixtures"), newChat, { development: true }), false);
  assert.equal(piUpgradeMemoryEligible(policy("developer_installs"), newChat, { development: true }), true);
  assert.equal(piUpgradeMemoryEligible(policy("developer_installs"), newChat, { development: false }), false);
  assert.equal(piUpgradeMemoryEligible(policy("new_chats"), oldChat, { development: false }), false);
  assert.equal(piUpgradeMemoryEligible(policy("new_chats"), newChat, { development: false }), true);
  assert.equal(piUpgradeMemoryEligible(policy("migrated_low_risk_chats"), oldChat, { development: false }), false);
  assert.equal(piUpgradeMemoryEligible(policy("existing_long_chats"), oldChat, { development: false }), true);
  assert.equal(piUpgradeMemoryEligible(policy("existing_long_chats"), newChat, { development: false, behaviorEnabled: false }), false);
  assert.equal(piUpgradeBehaviorEnabled({ AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED: "0" }), false);
  assert.equal(piUpgradeBehaviorEnabled({ AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED: "false" }), true);
});

test("device-local rollout advances one stage and v4-only requires installed rollback receipts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-"));
  const identity = { packageSha256: "b".repeat(64), buildId: "0.36.1-test" };
  const store = new PiUpgradeRolloutStore({
    root: () => root,
    initialStage: "existing_long_chats",
    now: () => 10_000,
    installedIdentity: () => identity,
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  const initial = await store.load();
  assert.equal(initial.stage, "existing_long_chats");
  await writePiUpgradeEvaluationReceipt(root, await passingMeasurements(), identity, "2026-08-31T00:00:00.000Z");
  await assert.rejects(store.advance("v4_only"), /receipts bound to this installed build/u);
  const evaluationBytes = await readFile(path.join(root, "pi-upgrade-evaluation-v1.json"));
  const installed = {
    schema: "aiden.pi-upgrade.installed",
    version: 1,
    packageSha256: identity.packageSha256,
    buildId: identity.buildId,
    evaluationSha256: createHash("sha256").update(evaluationBytes).digest("hex"),
    packagedMigrationRestartPassed: true,
    rollbackPassed: true,
    signedInstallPassed: true,
    recordedAt: "2026-08-31T00:00:00.000Z",
  };
  const installedFile = path.join(root, "pi-upgrade-installed-v1.json");
  await writeFile(installedFile, `${JSON.stringify(installed)}\n`, { mode: 0o600 });
  await chmod(installedFile, 0o600);
  const next = await store.advance("v4_only");
  assert.equal(next.stage, "v4_only");
  const file = path.join(root, "pi-upgrade-rollout-v1.json");
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, "utf8")).stage, "v4_only");
});

test("two rollout-store instances cannot regress device state from a stale cache", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root: () => root, initialStage: "internal_fixtures" as const, now: () => 20_000 };
  const first = new PiUpgradeRolloutStore(options);
  const stale = new PiUpgradeRolloutStore(options);
  await Promise.all([first.load(), stale.load()]);
  await writePiUpgradeEvaluationReceipt(
    root,
    await passingMeasurements(),
    { packageSha256: "c".repeat(64), buildId: "concurrency-test" },
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal((await first.advance("developer_installs")).revision, 2);
  assert.deepEqual(await stale.load(), await first.load());
  assert.equal((await stale.load()).stage, "developer_installs");
  await assert.rejects(
    stale.advance("developer_installs"),
    /advance exactly one stage from current device state/u,
  );
  assert.equal(JSON.parse(await readFile(path.join(root, "pi-upgrade-rollout-v1.json"), "utf8")).revision, 2);
});

test("rollout reads reject invalid replacements and recover without rewriting device data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-reload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PiUpgradeRolloutStore({ root: () => root, initialStage: "new_chats", now: () => 100 });
  const initial = await store.load();
  const file = path.join(root, "pi-upgrade-rollout-v1.json");
  const original = await readFile(file, "utf8");
  const replace = async (bytes: string) => {
    const staging = path.join(root, "operator-replacement.tmp");
    await writeFile(staging, bytes, { mode: 0o600 });
    await rename(staging, file);
  };
  for (const invalid of ["{", JSON.stringify({ ...initial, unexpected: true }), JSON.stringify({ ...initial, revision: 0 })]) {
    await replace(invalid);
    await assert.rejects(store.load());
    await assert.rejects(store.load());
    assert.equal(await readFile(file, "utf8"), invalid);
    await replace(original);
    assert.deepEqual(await store.load(), initial);
    assert.equal(await readFile(file, "utf8"), original);
  }
  // Losing a previously observed policy must not silently reinitialize it.
  await rm(file);
  await assert.rejects(store.load(), { code: "ENOENT" });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  await replace(original);
  assert.deepEqual(await store.load(), initial);

  // A failed first read must not poison this instance's subsequent reads either.
  await replace("{");
  const recovering = new PiUpgradeRolloutStore({ root: () => root, initialStage: "internal_fixtures" });
  await assert.rejects(recovering.load());
  await replace(original);
  assert.deepEqual(await recovering.load(), initial);
  assert.deepEqual(await readdir(root), ["pi-upgrade-rollout-v1.json"]);
});

test("an overlapping first load cannot recreate a policy deleted after the first read", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-overlap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  let release!: () => void;
  let arrived!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const secondArrived = new Promise<void>((resolve) => { arrived = resolve; });
  const store = new PiUpgradeRolloutStore({
    root: async () => {
      if (++calls === 2) { arrived(); await blocked; }
      return root;
    },
    initialStage: "new_chats",
  });
  const first = store.load();
  const second = store.load();
  const rejected = assert.rejects(second, { code: "ENOENT" });
  await first;
  await secondArrived;
  await rm(path.join(root, "pi-upgrade-rollout-v1.json"));
  release();
  await rejected;
  assert.deepEqual(await readdir(root), []);
});

test("concurrent rollout initialization publishes one complete policy without losing the winner", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-create-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 24 }, (_, index) => new PiUpgradeRolloutStore({
    root: () => root,
    initialStage: index % 2 === 0 ? "new_chats" : "internal_fixtures",
    now: () => 100 + index,
  }));
  const results = await Promise.all(stores.flatMap((store) => [store.load(), store.load()]));
  const file = path.join(root, "pi-upgrade-rollout-v1.json");
  const bytes = await readFile(file, "utf8");
  const winner = JSON.parse(bytes);
  for (const result of results) assert.deepEqual(result, winner);
  assert.equal(winner.revision, 1);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  for (const store of stores) assert.deepEqual(await store.load(), winner);
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.deepEqual(await readdir(root), ["pi-upgrade-rollout-v1.json"]);
});

test("external rollout advancement preserves the activated new-chat cohort on subsequent reads", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-cutoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 100;
  const options = { root: () => root, initialStage: "developer_installs" as const, now: () => now };
  const app = new PiUpgradeRolloutStore(options);
  const operator = new PiUpgradeRolloutStore(options);
  await app.load();
  await writePiUpgradeEvaluationReceipt(root, await passingMeasurements(), {
    packageSha256: "d".repeat(64), buildId: "cohort-test",
  });
  now = 200;
  await operator.advance("new_chats");
  const newChats = await app.load();
  assert.equal(newChats.activatedAt, 200);
  const longChat = { createdAt: 250, messages: Array.from({ length: 150 }, () => ({})) } as never;
  const oldLongChat = { createdAt: 150, messages: Array.from({ length: 150 }, () => ({})) } as never;
  assert.equal(piUpgradeMemoryEligible(newChats, longChat, { development: false }), true);
  now = 300;
  await operator.advance("migrated_low_risk_chats");
  const migrated = await app.load();
  assert.equal(migrated.stage, "migrated_low_risk_chats");
  assert.equal(migrated.revision, 3);
  assert.equal(migrated.activatedAt, 200);
  assert.equal(piUpgradeMemoryEligible(migrated, longChat, { development: false }), true);
  assert.equal(piUpgradeMemoryEligible(migrated, oldLongChat, { development: false }), false);
  now = 400;
  await app.advance("existing_long_chats");
  const latest = await operator.load();
  assert.equal(latest.revision, 4);
  assert.equal(latest.activatedAt, 200);
  assert.equal(piUpgradeMemoryEligible(latest, oldLongChat, { development: false }), true);
});

test("crashed rollout locks recover and installed identity includes app resources", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-rollout-stale-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "Candidate.app");
  const executable = path.join(app, "Contents", "MacOS", "Aiden Agent");
  const resource = path.join(app, "Contents", "Resources", "app.asar");
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.dirname(resource), { recursive: true });
  await writeFile(executable, "launcher", { mode: 0o700 });
  await writeFile(resource, "bundle-one");
  const firstIdentity = await installedApplicationIdentity(executable, "build-test");
  await writeFile(resource, "bundle-two");
  const secondIdentity = await installedApplicationIdentity(executable, "build-test");
  assert.notEqual(firstIdentity.packageSha256, secondIdentity.packageSha256);

  const store = new PiUpgradeRolloutStore({
    root: () => root,
    initialStage: "internal_fixtures",
    now: () => 1_000_000,
    installedIdentity: async () => secondIdentity,
  });
  await store.load();
  await writePiUpgradeEvaluationReceipt(root, await passingMeasurements(), secondIdentity);
  await writeFile(path.join(root, ".advance-lock"), JSON.stringify({
    token: "crashed-owner", pid: 999_999_999, createdAt: 1,
  }), { mode: 0o600 });
  assert.equal((await store.advance("developer_installs")).stage, "developer_installs");
});

test("operator advancement command is registered and uses the guarded store", async () => {
  const [packageText, commandText, llmText, lifecycleText] = await Promise.all([
    readFile(path.resolve("package.json"), "utf8"),
    readFile(path.resolve("scripts/pi-upgrade-advance.mjs"), "utf8"),
    readFile(path.resolve("main/services/llm-client.ts"), "utf8"),
    readFile(path.resolve("main/services/context-lifecycle-service-main.ts"), "utf8"),
  ]);
  assert.match(packageText, /"pi-upgrade:advance"/u);
  assert.match(commandText, /store\.advance\(target\)/u);
  assert.match(commandText, /installedApplicationIdentity/u);
  assert.match(llmText, /piUpgradeChatBehaviorEligible/u);
  assert.match(llmText, /enabled: piUpgradeCompactionEnabled/u);
  assert.match(lifecycleText, /compactionEligible/u);

  // Generation must run rollout-ineligible chats journalless instead of
  // throwing, and the durable stores must stay fail-closed for those runs.
  assert.match(llmText, /openChatIfEligible/u);
  assert.match(lifecycleText, /openChatIfEligible/u);
  assert.match(llmText, /createInMemoryPiSession/u);
  assert.match(llmText, /piJournalless = true/u);
  assert.match(llmText, /!piJournalless[\s\S]{0,200}markRecoveryRecorded/u);
  assert.match(llmText, /!piJournalless[\s\S]{0,160}acknowledgeChatEffectsDurable/u);
  const quarantineSites = [...llmText.matchAll(/piCompactionSessionStore\.quarantineChatUntilRecovered/gu)];
  assert.equal(quarantineSites.length, 2);
  for (const site of quarantineSites) {
    assert.match(
      llmText.slice(Math.max(0, (site.index ?? 0) - 200), site.index ?? 0),
      /!piJournalless/u,
      "every durable quarantine call must be gated by the journalless flag",
    );
  }
});

test("production journal creation and legacy migration obey the device rollout without rewriting deferred v3", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-format-rollout-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "sessions");
  const directory = path.join(root, "--legacy--");
  await mkdir(directory, { recursive: true });
  const journal = path.join(directory, "legacy.jsonl");
  const fixture = (await readFile(path.resolve("main/services/fixtures/pi-legacy/uncompacted.jsonl"), "utf8")).split("\n");
  const header = JSON.parse(fixture[0]!) as Record<string, unknown>;
  header.id = "rollout-legacy";
  header.cwd = root;
  header.metadata = { kind: "aiden-chat-compaction-v1", chatId: "rollout-legacy" };
  fixture[0] = JSON.stringify(header);
  const original = fixture.join("\n");
  await writeFile(journal, original, { mode: 0o600 });

  const newChatsPolicy = { version: 1 as const, stage: "new_chats" as const, activatedAt: 1, revision: 1 };
  const deferred = new PiCompactionSessionStore({
    root: async () => root,
    rollout: { load: async () => newChatsPolicy, development: false, behaviorEnabled: true },
  });
  await assert.rejects(deferred.openChat("rollout-legacy", { createdAt: 0 }), /outside the active device rollout stage/u);
  assert.equal(await readFile(journal, "utf8"), original);
  await assert.rejects(deferred.openChat("rollout-old-without-journal", { createdAt: 0 }), /v4 journal creation/u);
  assert.ok(await deferred.openChat("rollout-new", { createdAt: 2 }));

  const migrationPolicy = { ...newChatsPolicy, stage: "migrated_low_risk_chats" as const, revision: 2 };
  const promoted = new PiCompactionSessionStore({
    root: async () => root,
    rollout: { load: async () => migrationPolicy, development: false, behaviorEnabled: true },
  });
  assert.ok(await promoted.openChat("rollout-legacy", { createdAt: 0 }));
  assert.equal(JSON.parse((await readFile(journal, "utf8")).split("\n")[0]!).version, 4);
  await rm(`${journal}.migration-v1.json`);
  const recovered = new PiCompactionSessionStore({
    root: async () => root,
    rollout: { load: async () => migrationPolicy, development: false, behaviorEnabled: true },
  });
  assert.ok(await recovered.openChat("rollout-legacy", { createdAt: 0 }));
  assert.equal(JSON.parse(await readFile(`${journal}.migration-v1.json`, "utf8")).validation, "passed");

  const rollbackRoot = path.join(temporary, "rollback-sessions");
  await mkdir(rollbackRoot, { recursive: true });
  const rolledBack = new PiCompactionSessionStore({
    root: async () => rollbackRoot,
    rollout: { load: async () => migrationPolicy, development: false, behaviorEnabled: false },
  });
  await assert.rejects(rolledBack.openChat("rollback-new", { createdAt: 2 }), /outside the active device rollout stage/u);
});

test("openChatIfEligible probes the rollout without creating or rewriting journals", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "aiden-pi-open-eligible-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const policy = { version: 1 as const, stage: "new_chats" as const, activatedAt: 1, revision: 1 };

  // (a) An eligible new chat delegates to the shared open continuation: a
  // session comes back and a v4 journal is created on disk.
  const createdRoot = path.join(temporary, "created");
  await mkdir(createdRoot, { recursive: true });
  const created = new PiCompactionSessionStore({
    root: async () => createdRoot,
    rollout: { load: async () => policy, development: false, behaviorEnabled: true },
  });
  const createdOutcome = await created.openChatIfEligible("eligible-new", { createdAt: 2 });
  assert.ok(createdOutcome.session);
  const createdPath = (await createdOutcome.session.getMetadata()).path;
  assert.ok((await stat(createdPath)).isFile());
  assert.equal(JSON.parse((await readFile(createdPath, "utf8")).split("\n")[0]!).version, 4);

  // (b) A pre-activation journal-less chat is reported ineligible and no
  // journal file appears on disk.
  const preActivationRoot = path.join(temporary, "pre-activation");
  await mkdir(preActivationRoot, { recursive: true });
  const preActivation = new PiCompactionSessionStore({
    root: async () => preActivationRoot,
    rollout: { load: async () => policy, development: false, behaviorEnabled: true },
  });
  assert.deepEqual(await preActivation.openChatIfEligible("pre-activation", { createdAt: 0 }), {
    session: undefined,
    reason: "v4_creation_rollout",
  });
  assert.deepEqual(await journalFilesUnder(preActivationRoot), []);

  // (c) A deferred-v3 chat is reported legacy_migration_deferred with its v3
  // bytes byte-identical afterward.
  const legacyRoot = path.join(temporary, "legacy-deferred");
  const legacyDirectory = path.join(legacyRoot, "--legacy--");
  await mkdir(legacyDirectory, { recursive: true });
  const journal = path.join(legacyDirectory, "legacy.jsonl");
  const fixture = (await readFile(path.resolve("main/services/fixtures/pi-legacy/uncompacted.jsonl"), "utf8")).split("\n");
  const header = JSON.parse(fixture[0]!) as Record<string, unknown>;
  header.id = "deferred-legacy";
  header.cwd = legacyRoot;
  header.metadata = { kind: "aiden-chat-compaction-v1", chatId: "deferred-legacy" };
  fixture[0] = JSON.stringify(header);
  const original = fixture.join("\n");
  await writeFile(journal, original, { mode: 0o600 });
  const deferred = new PiCompactionSessionStore({
    root: async () => legacyRoot,
    rollout: { load: async () => policy, development: false, behaviorEnabled: true },
  });
  assert.deepEqual(await deferred.openChatIfEligible("deferred-legacy", { createdAt: 0 }), {
    session: undefined,
    reason: "legacy_migration_deferred",
  });
  assert.equal(await readFile(journal, "utf8"), original);

  // (d) behaviorEnabled=false rolls the gate back: an otherwise-eligible new
  // chat is reported v4_creation_rollout and no journal is created.
  const rollbackRoot = path.join(temporary, "rollback");
  await mkdir(rollbackRoot, { recursive: true });
  const rolledBack = new PiCompactionSessionStore({
    root: async () => rollbackRoot,
    rollout: { load: async () => policy, development: false, behaviorEnabled: false },
  });
  assert.deepEqual(await rolledBack.openChatIfEligible("rollback-new", { createdAt: 2 }), {
    session: undefined,
    reason: "v4_creation_rollout",
  });
  assert.deepEqual(await journalFilesUnder(rollbackRoot), []);
});
