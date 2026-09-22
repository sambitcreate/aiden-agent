import { createHash } from "node:crypto";
import type {
  AppSettings,
  McpServer,
  ScheduledRun,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSettings,
  Workspace,
} from "./types.js";

export interface ScheduledTaskApplicationDependencies {
  store: {
    list(): Promise<ScheduledTask[]>;
    get(id: string): Promise<ScheduledTask | undefined>;
    runs(id: string): Promise<ScheduledRun[]>;
  };
  service: {
    save(
      input: ScheduledTaskInput,
      options?: { expectedUpdatedAt?: number; signal?: AbortSignal },
    ): Promise<ScheduledTask>;
    remove(id: string, options?: { signal?: AbortSignal; expectedUpdatedAt?: number }): Promise<void>;
    pause(id: string, options?: { signal?: AbortSignal; expectedUpdatedAt?: number }): Promise<ScheduledTask>;
    resume(id: string, options?: { signal?: AbortSignal; expectedUpdatedAt?: number }): Promise<ScheduledTask>;
    runNow(
      id: string,
      options?: { signal?: AbortSignal; runId?: string; expectedUpdatedAt?: number },
    ): Promise<ScheduledRun>;
    setGlobalEnabled(enabled: boolean): Promise<void>;
    isRunning(id: string): boolean;
  };
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  listMcpServers(): Promise<McpServer[]>;
  validateMcpSelection(configured: readonly McpServer[], selected: readonly string[]): void;
  listScripts(input: { workspaceRoot?: string }): Promise<string[]>;
  nextRuns(cron: string, timezone: string, count: number): number[];
  systemTimezone(): string;
  validateTimezone(value: string): string;
  settingsPatch(input: Record<string, unknown>): Partial<AppSettings>;
  notifyChanged(payload: Record<string, unknown>): void;
}

export interface RevisionedScheduledTaskSettings {
  revision: string;
  value: ScheduledTaskSettings;
}

function settingsValue(
  input: AppSettings,
  dependencies: Pick<ScheduledTaskApplicationDependencies, "systemTimezone" | "validateTimezone">,
): ScheduledTaskSettings {
  return {
    enabled: input.scheduledTasksEnabled !== false,
    defaultMode: input.scheduledDefaultMode === "script" ? "script" : "llm",
    defaultPermission: input.scheduledDefaultPermission === "full" ? "full" : "read-only",
    defaultMcpEnabled: input.scheduledDefaultMcpEnabled === true,
    defaultNotify: input.scheduledDefaultNotify !== false,
    defaultTimezone: dependencies.validateTimezone(
      input.scheduledDefaultTimezone ?? dependencies.systemTimezone(),
    ),
  };
}

export function scheduledTaskRevision(task: ScheduledTask): string {
  return `rev_${createHash("sha256")
    .update(JSON.stringify({ id: task.id, updatedAt: task.updatedAt }))
    .digest("base64url")}`;
}

export function scheduledSettingsRevision(settings: ScheduledTaskSettings): string {
  return `rev_${createHash("sha256")
    .update(JSON.stringify(settings))
    .digest("base64url")}`;
}

function expectedTaskRevision(task: ScheduledTask, expected?: string): number | undefined {
  if (expected === undefined) return undefined;
  if (scheduledTaskRevision(task) !== expected) {
    throw new Error("This automation changed. Refresh it before trying again.");
  }
  return task.updatedAt;
}

/** Shared main-process schedule orchestration for Electron and Aiden Remote. */
export function createScheduledTaskApplicationService(
  dependencies: ScheduledTaskApplicationDependencies,
) {
  let settingsTail: Promise<void> = Promise.resolve();

  const validateInput = async (input: ScheduledTaskInput): Promise<void> => {
    if (input.workspaceId) {
      const workspace = await dependencies.getWorkspace(input.workspaceId);
      if (!workspace) throw new Error(`Workspace ${input.workspaceId} not found.`);
      if (workspace.permission === "none") {
        throw new Error("Scheduled tasks require a workspace with local access.");
      }
    }
    if ((input.mcpServerIds?.length ?? 0) > 0) {
      dependencies.validateMcpSelection(
        await dependencies.listMcpServers(),
        input.mcpServerIds!,
      );
    }
    if (input.mode === "script") {
      const workspace = input.workspaceId
        ? await dependencies.getWorkspace(input.workspaceId)
        : undefined;
      const scripts = await dependencies.listScripts({
        workspaceRoot: workspace?.folderPath,
      });
      if (!input.script || !scripts.includes(input.script)) {
        throw new Error("Select a script from Aiden's current script inventory.");
      }
    }
  };

  const get = async (id: string): Promise<ScheduledTask> => {
    const task = await dependencies.store.get(id);
    if (!task) throw new Error(`Scheduled task ${id} not found.`);
    return task;
  };

  const save = async (
    input: ScheduledTaskInput,
    options: { expectedRevision?: string; signal?: AbortSignal } = {},
  ): Promise<ScheduledTask> => {
    await validateInput(input);
    const existing = input.id ? await get(input.id) : undefined;
    const task = await dependencies.service.save(input, {
      ...(existing
        ? { expectedUpdatedAt: expectedTaskRevision(existing, options.expectedRevision) }
        : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    dependencies.notifyChanged({ taskId: task.id });
    return task;
  };

  const mutateExisting = async <T>(
    id: string,
    expectedRevision: string | undefined,
    operation: (expectedUpdatedAt: number | undefined) => Promise<T>,
  ): Promise<T> => {
    const expectedUpdatedAt = expectedTaskRevision(await get(id), expectedRevision);
    const result = await operation(expectedUpdatedAt);
    dependencies.notifyChanged({ taskId: id });
    return result;
  };

  const settings = async (): Promise<RevisionedScheduledTaskSettings> => {
    const value = settingsValue(await dependencies.getSettings(), dependencies);
    return { revision: scheduledSettingsRevision(value), value };
  };

  const updateSettings = async (
    expectedRevision: string,
    patch: Record<string, unknown>,
  ): Promise<RevisionedScheduledTaskSettings> => {
    const previous = settingsTail;
    let release!: () => void;
    settingsTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      const current = await settings();
      if (current.revision !== expectedRevision) {
        throw new Error("Scheduled-task settings changed. Refresh them before trying again.");
      }
      const parsed = dependencies.settingsPatch(patch);
      if (Object.keys(parsed).length === 0) {
        throw new Error("At least one scheduled-task setting must change.");
      }
      const saved = await dependencies.setSettings(parsed);
      const next = settingsValue(saved, dependencies);
      if (next.enabled !== current.value.enabled) {
        await dependencies.service.setGlobalEnabled(next.enabled);
      }
      dependencies.notifyChanged({ settings: true });
      return { revision: scheduledSettingsRevision(next), value: next };
    } finally {
      release();
    }
  };

  return {
    list: () => dependencies.store.list(),
    get,
    save,
    remove: (id: string, revision?: string, signal?: AbortSignal) =>
      mutateExisting(id, revision, (expectedUpdatedAt) =>
        dependencies.service.remove(id, { signal, expectedUpdatedAt })),
    pause: (id: string, revision?: string, signal?: AbortSignal) =>
      mutateExisting(id, revision, (expectedUpdatedAt) =>
        dependencies.service.pause(id, { signal, expectedUpdatedAt })),
    resume: (id: string, revision?: string, signal?: AbortSignal) =>
      mutateExisting(id, revision, (expectedUpdatedAt) =>
        dependencies.service.resume(id, { signal, expectedUpdatedAt })),
    runNow: async (id: string, runId?: string, revision?: string) => {
      const expectedUpdatedAt = expectedTaskRevision(await get(id), revision);
      const run = dependencies.service.runNow(id, { runId, expectedUpdatedAt });
      if (runId) {
        void run.catch(() => undefined);
        return undefined;
      }
      return run;
    },
    runs: async (id: string) => {
      await get(id);
      return dependencies.store.runs(id);
    },
    preview: (cron: string, timezone: string, count = 3) =>
      dependencies.nextRuns(cron, timezone, count),
    scripts: async (workspaceId?: string) => {
      const workspace = workspaceId ? await dependencies.getWorkspace(workspaceId) : undefined;
      if (workspaceId && !workspace) throw new Error(`Workspace ${workspaceId} not found.`);
      if (workspace?.permission === "none") {
        throw new Error("This workspace does not allow script inventory access.");
      }
      return dependencies.listScripts({ workspaceRoot: workspace?.folderPath });
    },
    mcpServers: async () => (await dependencies.listMcpServers())
      .filter((server) => server.enabled)
      .map((server) => ({ id: server.id, name: server.name })),
    settings,
    updateSettings,
    isRunning: (id: string) => dependencies.service.isRunning(id),
  };
}

export type ScheduledTaskApplicationService = ReturnType<
  typeof createScheduledTaskApplicationService
>;
