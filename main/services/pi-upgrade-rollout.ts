import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, readlink, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { Chat } from "./types.js";
import {
  evaluatePiUpgradeReplay,
  type PiUpgradeEvaluationReport,
  type PiUpgradeReplayMeasurement,
} from "./pi-upgrade-evaluation.js";

export const PI_UPGRADE_ROLLOUT_STAGES = [
  "internal_fixtures", "developer_installs", "new_chats",
  "migrated_low_risk_chats", "existing_long_chats", "v4_only",
] as const;
export type PiUpgradeRolloutStage = typeof PI_UPGRADE_ROLLOUT_STAGES[number];
export const PI_UPGRADE_BEHAVIOR_ENABLED_ENV = "AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED";
const POLICY_FILE = "pi-upgrade-rollout-v1.json";
const EVALUATION_FILE = "pi-upgrade-evaluation-v1.json";
const INSTALLED_FILE = "pi-upgrade-installed-v1.json";
const STALE_LOCK_MS = 5 * 60_000;

export interface PiUpgradeRolloutDocument {
  version: 1;
  stage: PiUpgradeRolloutStage;
  activatedAt: number;
  revision: number;
}

export interface PiUpgradeEvaluationReceipt {
  schema: "aiden.pi-upgrade.evaluation";
  version: 1;
  generatedAt: string;
  packageSha256: string;
  buildId: string;
  measurements: PiUpgradeReplayMeasurement[];
  report: PiUpgradeEvaluationReport;
}

export interface PiUpgradeInstalledReceipt {
  schema: "aiden.pi-upgrade.installed";
  version: 1;
  packageSha256: string;
  buildId: string;
  evaluationSha256: string;
  packagedMigrationRestartPassed: true;
  rollbackPassed: true;
  signedInstallPassed: true;
  recordedAt: string;
}

export interface PiUpgradeInstalledIdentity { packageSha256: string; buildId: string }

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).sort().join(",") === [...keys].sort().join(",");
}

function parseDocument(value: unknown): PiUpgradeRolloutDocument | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["version", "stage", "activatedAt", "revision"]) || record.version !== 1 ||
    !PI_UPGRADE_ROLLOUT_STAGES.includes(record.stage as PiUpgradeRolloutStage) ||
    !Number.isSafeInteger(record.activatedAt) || (record.activatedAt as number) < 0 ||
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 1
  ) return undefined;
  return {
    version: 1, stage: record.stage as PiUpgradeRolloutStage,
    activatedAt: record.activatedAt as number, revision: record.revision as number,
  };
}

export function piUpgradeBehaviorEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment[PI_UPGRADE_BEHAVIOR_ENABLED_ENV]?.trim() !== "0";
}
export const piUpgradeBehaviorEnabledAtStartup = piUpgradeBehaviorEnabled();

export function piUpgradeMemoryEligible(
  policy: PiUpgradeRolloutDocument,
  chat: Pick<Chat, "createdAt" | "messages">,
  options: { development: boolean; behaviorEnabled?: boolean },
): boolean {
  if (options.behaviorEnabled === false) return false;
  switch (policy.stage) {
    case "internal_fixtures": return false;
    case "developer_installs": return options.development;
    case "new_chats": return chat.createdAt >= policy.activatedAt;
    case "migrated_low_risk_chats": return chat.createdAt >= policy.activatedAt || chat.messages.length <= 100;
    case "existing_long_chats":
    case "v4_only": return true;
  }
}

/** One authoritative per-chat gate for upgraded compaction and memory behavior. */
export const piUpgradeChatBehaviorEligible = piUpgradeMemoryEligible;

export function piUpgradeJournalCreationEligible(
  policy: PiUpgradeRolloutDocument,
  chatCreatedAt: number | undefined,
  options: { development: boolean; behaviorEnabled: boolean },
): boolean {
  if (!options.behaviorEnabled || policy.stage === "internal_fixtures") return false;
  if (policy.stage === "developer_installs") return options.development;
  if (policy.stage === "new_chats") {
    return Number.isSafeInteger(chatCreatedAt) && chatCreatedAt! >= policy.activatedAt;
  }
  return true;
}

export function piUpgradeLegacyMigrationEligible(
  policy: PiUpgradeRolloutDocument,
  entryCount: number,
  options: { development: boolean; behaviorEnabled: boolean },
): boolean {
  if (!piUpgradeJournalCreationEligible(policy, policy.activatedAt, options)) return false;
  const stage = PI_UPGRADE_ROLLOUT_STAGES.indexOf(policy.stage);
  if (stage < PI_UPGRADE_ROLLOUT_STAGES.indexOf("migrated_low_risk_chats")) return false;
  return policy.stage !== "migrated_low_risk_chats" || entryCount <= 500;
}

function canonicalJson(value: unknown): string { return JSON.stringify(value); }

function parseEvaluationReceipt(value: unknown): PiUpgradeEvaluationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["schema", "version", "generatedAt", "packageSha256", "buildId", "measurements", "report"])) return undefined;
  if (
    record.schema !== "aiden.pi-upgrade.evaluation" || record.version !== 1 ||
    typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt)) ||
    typeof record.packageSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.packageSha256) ||
    typeof record.buildId !== "string" || !/^[A-Za-z0-9._+-]{1,100}$/u.test(record.buildId) ||
    !Array.isArray(record.measurements)
  ) return undefined;
  try {
    const measurements = record.measurements as PiUpgradeReplayMeasurement[];
    const report = evaluatePiUpgradeReplay(measurements);
    if (canonicalJson(report) !== canonicalJson(record.report)) return undefined;
    return {
      schema: "aiden.pi-upgrade.evaluation", version: 1, generatedAt: record.generatedAt,
      packageSha256: record.packageSha256, buildId: record.buildId, measurements, report,
    };
  } catch {
    return undefined;
  }
}

function parseInstalledReceipt(value: unknown): PiUpgradeInstalledReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, [
    "schema", "version", "packageSha256", "buildId", "evaluationSha256",
    "packagedMigrationRestartPassed", "rollbackPassed", "signedInstallPassed", "recordedAt",
  ])) return undefined;
  if (
    record.schema !== "aiden.pi-upgrade.installed" || record.version !== 1 ||
    typeof record.packageSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.packageSha256) ||
    typeof record.buildId !== "string" || !/^[A-Za-z0-9._+-]{1,100}$/u.test(record.buildId) ||
    typeof record.evaluationSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.evaluationSha256) ||
    record.packagedMigrationRestartPassed !== true || record.rollbackPassed !== true ||
    record.signedInstallPassed !== true || typeof record.recordedAt !== "string" ||
    Number.isNaN(Date.parse(record.recordedAt))
  ) return undefined;
  return record as unknown as PiUpgradeInstalledReceipt;
}

async function privateJson(file: string): Promise<unknown> {
  const handle = await open(file, "r");
  try {
    await handle.chmod(0o600);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function atomicPrivateJson(root: string, file: string, value: unknown): Promise<void> {
  const staging = path.join(root, `.pi-upgrade.${randomUUID()}.tmp`);
  try {
    const handle = await open(staging, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    await rename(staging, file);
    await chmod(file, 0o600);
    const directory = await open(root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireAdvanceLock(file: string, now: number): Promise<() => Promise<void>> {
  const owner = { token: randomUUID(), pid: process.pid, createdAt: now };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); } finally { await handle.close(); }
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
          if (current.token === owner.token) await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      let original = "";
      try {
        original = await readFile(file, "utf8");
        const prior = JSON.parse(original) as { pid?: unknown; createdAt?: unknown };
        stale = Number.isSafeInteger(prior.pid) && Number.isSafeInteger(prior.createdAt) &&
          now - Number(prior.createdAt) >= STALE_LOCK_MS && !(await processIsAlive(Number(prior.pid)));
      } catch { stale = false; }
      if (!stale || attempt > 0 || await readFile(file, "utf8").catch(() => "") !== original) {
        throw new Error("Another Pi upgrade rollout advance is in progress.");
      }
      await unlink(file);
    }
  }
  throw new Error("Could not acquire the Pi upgrade rollout lock.");
}

export async function writePiUpgradeEvaluationReceipt(
  root: string,
  measurements: readonly PiUpgradeReplayMeasurement[],
  identity: PiUpgradeInstalledIdentity,
  generatedAt = new Date().toISOString(),
): Promise<PiUpgradeEvaluationReceipt> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const receipt: PiUpgradeEvaluationReceipt = {
    schema: "aiden.pi-upgrade.evaluation", version: 1, generatedAt,
    packageSha256: identity.packageSha256,
    buildId: identity.buildId,
    measurements: measurements.map((measurement) => ({ ...measurement })),
    report: evaluatePiUpgradeReplay(measurements),
  };
  if (!receipt.report.passed) throw new Error("Pi upgrade evaluation thresholds have not passed.");
  await atomicPrivateJson(root, path.join(root, EVALUATION_FILE), receipt);
  return receipt;
}

export async function installedApplicationIdentity(
  executablePath: string,
  explicitBuildId?: string,
): Promise<PiUpgradeInstalledIdentity> {
  const normalized = path.resolve(executablePath);
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
  const markerIndex = normalized.lastIndexOf(marker);
  const root = markerIndex > 0 ? normalized.slice(0, markerIndex) : normalized;
  const hash = createHash("sha256");
  const visit = async (candidate: string): Promise<void> => {
    const metadata = await lstat(candidate);
    const relative = path.relative(root, candidate) || path.basename(candidate);
    hash.update(`${metadata.isDirectory() ? "d" : metadata.isSymbolicLink() ? "l" : "f"}:${relative}\0`);
    if (metadata.isDirectory()) {
      for (const name of (await readdir(candidate)).sort()) await visit(path.join(candidate, name));
    } else if (metadata.isSymbolicLink()) {
      hash.update(await readlink(candidate));
    } else if (metadata.isFile()) {
      for await (const chunk of createReadStream(candidate)) hash.update(chunk as Buffer);
    }
  };
  await visit(root);
  const packageSha256 = hash.digest("hex");
  const buildId = explicitBuildId?.trim() || `${process.platform}-${process.arch}-${packageSha256.slice(0, 16)}`;
  if (!/^[A-Za-z0-9._+-]{1,100}$/u.test(buildId)) throw new Error("Invalid Pi upgrade build identity.");
  return { packageSha256, buildId };
}

export class PiUpgradeRolloutStore {
  private loaded?: Promise<PiUpgradeRolloutDocument>;
  constructor(private readonly options: {
    root(): string | Promise<string>;
    initialStage: PiUpgradeRolloutStage;
    now?: () => number;
    installedIdentity?: () => PiUpgradeInstalledIdentity | Promise<PiUpgradeInstalledIdentity>;
  }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async paths() {
    const root = await this.options.root();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    return {
      root, policy: path.join(root, POLICY_FILE), evaluation: path.join(root, EVALUATION_FILE),
      installed: path.join(root, INSTALLED_FILE), lock: path.join(root, ".advance-lock"),
    };
  }

  private async readCurrent(create: boolean): Promise<PiUpgradeRolloutDocument> {
    const paths = await this.paths();
    try {
      const parsed = parseDocument(await privateJson(paths.policy));
      if (!parsed) throw new Error("The Pi upgrade rollout document is invalid.");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      const initial = { version: 1 as const, stage: this.options.initialStage, activatedAt: this.now(), revision: 1 };
      let handle;
      try {
        handle = await open(paths.policy, "wx", 0o600);
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code === "EEXIST") return this.readCurrent(false);
        throw createError;
      }
      try {
        await handle.writeFile(`${JSON.stringify(initial, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      return initial;
    }
  }

  async load(): Promise<PiUpgradeRolloutDocument> {
    this.loaded ??= this.readCurrent(true);
    return this.loaded;
  }

  async advance(target: PiUpgradeRolloutStage): Promise<PiUpgradeRolloutDocument> {
    const paths = await this.paths();
    const releaseLock = await acquireAdvanceLock(paths.lock, this.now());
    try {
      const current = await this.readCurrent(false);
      if (PI_UPGRADE_ROLLOUT_STAGES.indexOf(target) !== PI_UPGRADE_ROLLOUT_STAGES.indexOf(current.stage) + 1) {
        throw new Error("Pi upgrade rollout must advance exactly one stage from current device state.");
      }
      const rawEvaluation = await readFile(paths.evaluation);
      const evaluation = parseEvaluationReceipt(JSON.parse(rawEvaluation.toString("utf8")));
      if (!evaluation?.report.passed) throw new Error("A validated passing Pi upgrade evaluation receipt is required.");
      const identity = await this.options.installedIdentity?.();
      if (identity && (
        evaluation.packageSha256 !== identity.packageSha256 || evaluation.buildId !== identity.buildId
      )) throw new Error("The Pi upgrade evaluation receipt belongs to a different installed build.");
      if (target === "v4_only") {
        const installed = await privateJson(paths.installed)
          .then(parseInstalledReceipt)
          .catch(() => undefined);
        const evaluationSha256 = createHash("sha256").update(rawEvaluation).digest("hex");
        if (
          !installed || !identity || installed.packageSha256 !== identity.packageSha256 ||
          installed.buildId !== identity.buildId || installed.evaluationSha256 !== evaluationSha256
        ) throw new Error("V4-only rollout requires receipts bound to this installed build and evaluation.");
      }
      const next = { version: 1 as const, stage: target, activatedAt: this.now(), revision: current.revision + 1 };
      await atomicPrivateJson(paths.root, paths.policy, next);
      this.loaded = Promise.resolve(next);
      return next;
    } finally { await releaseLock(); }
  }
}
