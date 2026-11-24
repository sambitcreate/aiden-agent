/**
 * Design mode's device-local records for live apps (plan 2b D5, D6, D8; 2c
 * D10), in one userData file: the launch consent per app root, Aiden's own
 * install stamp per install root, the sticky port per app root, and the
 * approved attach of an `apps[].url` root. Every call is
 * serialised; writes are atomic with mode 0600. An unreadable or invalid
 * file reads as empty, so it never grants a consent it can't show.
 */
import * as fs from "node:fs/promises";
import { writeJsonAtomic } from "../../durable-fs.js";
import type { PackageManagerName } from "./app-server-core.js";

export const DESIGN_APP_RECORD_CAPS = Object.freeze({ workspaces: 256, appRoots: 16 });

export interface DesignAppConsentRecord {
  fingerprint: string;
  script: string;
  /** The approved card showed the install command. */
  installShown: boolean;
  at: number;
}

export interface DesignAppInstallRecord {
  state: "started" | "done";
  manager: PackageManagerName;
  lockHash: string;
  at: number;
}

/** 2c (D10): the person approved attaching an `apps[].url` root's server. */
export interface DesignAppAttachRecord {
  /** The canonical origin the card showed: "http://127.0.0.1:4321" or "http://[::1]:4321". */
  origin: string;
  /** `.aiden/canvas.json`'s url as written. */
  configUrl: string;
  /** The workspace's realpath at approval. */
  workspaceReal: string;
  at: number;
}

interface WorkspaceRecords {
  at: number;
  consents: Record<string, DesignAppConsentRecord>;
  installs: Record<string, DesignAppInstallRecord>;
  ports: Record<string, { port: number; at: number }>;
  attaches: Record<string, DesignAppAttachRecord>;
}

interface RecordsFile {
  version: 1;
  workspaces: Record<string, WorkspaceRecords>;
}

export interface DesignAppRecords {
  consentOf(workspaceId: string, appRoot: string): Promise<DesignAppConsentRecord | undefined>;
  /** Stores the consent only when `shown` (what the card showed) is still `current`; true when stored. */
  approveShown(
    workspaceId: string,
    appRoot: string,
    consent: { script: string; installShown: boolean },
    shown: string,
    current: string,
  ): Promise<boolean>;
  installOf(workspaceId: string, installRoot: string): Promise<DesignAppInstallRecord | undefined>;
  markInstall(workspaceId: string, installRoot: string, record: Omit<DesignAppInstallRecord, "at">): Promise<void>;
  portOf(workspaceId: string, appRoot: string): Promise<number | undefined>;
  setPort(workspaceId: string, appRoot: string, port: number): Promise<void>;
  attachOf(workspaceId: string, appRoot: string): Promise<DesignAppAttachRecord | undefined>;
  approveAttach(workspaceId: string, appRoot: string, record: Omit<DesignAppAttachRecord, "at">): Promise<void>;
  forgetWorkspace(workspaceId: string): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

function validConsent(value: unknown): value is DesignAppConsentRecord {
  return isRecord(value) && isString(value.fingerprint) && isString(value.script) && typeof value.installShown === "boolean" && isTime(value.at);
}

function validInstall(value: unknown): value is DesignAppInstallRecord {
  return (
    isRecord(value) &&
    (value.state === "started" || value.state === "done") &&
    isString(value.manager) &&
    MANAGERS.has(value.manager) &&
    isString(value.lockHash) &&
    isTime(value.at)
  );
}

function validPort(value: unknown): value is { port: number; at: number } {
  return isRecord(value) && Number.isInteger(value.port) && (value.port as number) > 0 && (value.port as number) < 65_536 && isTime(value.at);
}

function validAttach(value: unknown): value is DesignAppAttachRecord {
  return isRecord(value) && isString(value.origin) && isString(value.configUrl) && isString(value.workspaceReal) && isTime(value.at);
}

function entries<T>(value: unknown, valid: (entry: unknown) => entry is T): Record<string, T> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, T] => valid(entry[1])));
}

function parse(text: string): RecordsFile {
  const empty: RecordsFile = { version: 1, workspaces: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.workspaces)) return empty;
  const workspaces: Record<string, WorkspaceRecords> = {};
  for (const [id, raw] of Object.entries(value.workspaces)) {
    if (!isRecord(raw) || !isTime(raw.at)) continue;
    workspaces[id] = {
      at: raw.at,
      consents: entries(raw.consents, validConsent),
      installs: entries(raw.installs, validInstall),
      ports: entries(raw.ports, validPort),
      attaches: entries(raw.attaches, validAttach),
    };
  }
  return { version: 1, workspaces };
}

/** Keeps the newest `cap` keys by their `at`. */
function capByAge<T extends { at: number }>(record: Record<string, T>, cap: number): Record<string, T> {
  const kept = Object.entries(record).sort(([, left], [, right]) => right.at - left.at).slice(0, cap);
  return Object.fromEntries(kept);
}

export function createDesignAppRecords(file: () => string, options: { now?: () => number } = {}): DesignAppRecords {
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  };
  const load = async (): Promise<RecordsFile> => {
    try {
      return parse(await fs.readFile(file(), "utf8"));
    } catch {
      return { version: 1, workspaces: {} };
    }
  };
  const update = (workspaceId: string, change: (records: WorkspaceRecords, at: number) => void) =>
    serial(async () => {
      const data = await load();
      const at = now();
      const records = data.workspaces[workspaceId] ?? { at, consents: {}, installs: {}, ports: {}, attaches: {} };
      change(records, at);
      records.at = at;
      records.consents = capByAge(records.consents, DESIGN_APP_RECORD_CAPS.appRoots);
      records.installs = capByAge(records.installs, DESIGN_APP_RECORD_CAPS.appRoots);
      records.ports = capByAge(records.ports, DESIGN_APP_RECORD_CAPS.appRoots);
      records.attaches = capByAge(records.attaches, DESIGN_APP_RECORD_CAPS.appRoots);
      data.workspaces[workspaceId] = records;
      data.workspaces = capByAge(data.workspaces, DESIGN_APP_RECORD_CAPS.workspaces);
      await writeJsonAtomic(file(), data, { mode: 0o600, space: 2 });
    });
  const read = <T>(pick: (data: RecordsFile) => T) => serial(async () => pick(await load()));
  return {
    consentOf: (workspaceId, appRoot) => read((data) => data.workspaces[workspaceId]?.consents[appRoot]),
    approveShown: (workspaceId, appRoot, consent, shown, current) => {
      if (shown !== current) return Promise.resolve(false);
      return update(workspaceId, (records, at) => {
        records.consents[appRoot] = { fingerprint: shown, script: consent.script, installShown: consent.installShown, at };
      }).then(() => true);
    },
    installOf: (workspaceId, installRoot) => read((data) => data.workspaces[workspaceId]?.installs[installRoot]),
    markInstall: (workspaceId, installRoot, record) =>
      update(workspaceId, (records, at) => {
        records.installs[installRoot] = { ...record, at };
      }),
    portOf: (workspaceId, appRoot) => read((data) => data.workspaces[workspaceId]?.ports[appRoot]?.port),
    setPort: (workspaceId, appRoot, port) =>
      update(workspaceId, (records, at) => {
        records.ports[appRoot] = { port, at };
      }),
    attachOf: (workspaceId, appRoot) => read((data) => data.workspaces[workspaceId]?.attaches[appRoot]),
    approveAttach: (workspaceId, appRoot, record) =>
      update(workspaceId, (records, at) => {
        records.attaches[appRoot] = { origin: record.origin, configUrl: record.configUrl, workspaceReal: record.workspaceReal, at };
      }),
    forgetWorkspace: (workspaceId) =>
      serial(async () => {
        const data = await load();
        if (!(workspaceId in data.workspaces)) return;
        delete data.workspaces[workspaceId];
        await writeJsonAtomic(file(), data, { mode: 0o600, space: 2 });
      }),
  };
}
