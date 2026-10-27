import { createBotRoutineExecutor, type BotRoutineExecutorPorts } from "../../../main/services/scheduled-bot-routines.js";
import { scheduledMcpServerBinding } from "../../../main/services/schedule-mcp-binding.js";
import { storeFor } from "./mcp.ts";
import { runScheduledInference } from "./scheduled-inference.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { remoteDaemonCommand } from "./daemon-control.ts";
import { createHash } from "node:crypto";
import { createScheduleStore, nextScheduledRuns } from "../../../main/services/schedule-store-core.js";
import { createScheduleServiceCore } from "../../../main/services/schedule-service-core.js";
import type { ScheduledTaskInput, ScheduledRun } from "../../../main/services/types.js";
import { JsonStore, acquireLease, readJson } from "./state.ts";
import { workspaceStore, accessFor } from "./workspaces.ts";
import { resolveScheduledScript, runScheduledScript } from "../../../main/services/schedule-script.js";
import { createCliModelRuntime } from "./providers.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { assertScheduleApproval, isScheduleMutation, type ScheduleToolApproval } from "./schedule-tool-approval.ts";

async function providerFingerprint(agentDir: string, providerId?: string, modelId?: string): Promise<string> {
  if (!providerId || !modelId) throw new Error("Select an explicit provider and model for unattended inference.");
  const runtime = await createCliModelRuntime(agentDir);
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error("The scheduled model is unavailable. Review the task's provider selection.");
  return createHash("sha256").update(JSON.stringify({ providerId, modelId, api: model.api, baseUrl: model.baseUrl, headers: model.headers ?? {} })).digest("hex");
}

export function createCliScheduler(agentDir: string) {
  const approvedMutation = new AsyncLocalStorage<{ approval: ScheduleToolApproval; active: boolean; firstWrite: boolean }>();
  const persistence = new JsonStore<unknown[]>(join(agentDir, "schedules.json"), []);
  const tasks = {
    load: () => persistence.load(),
    update<R>(mutation: (draft: unknown[]) => R | Promise<R>, isCurrent?: () => boolean): Promise<R> {
      return persistence.update(mutation, () => {
        if (isCurrent && !isCurrent()) return false;
        const current = approvedMutation.getStore();
        if (current?.active) {
          assertScheduleApproval(agentDir, current.approval, current.firstWrite);
          current.firstWrite = false;
        }
        return true;
      });
    },
  };
  const store = createScheduleStore(tasks, new JsonStore<unknown[]>(join(agentDir, "schedule-runs.json"), []));
  const active = new Map<string, AbortController>();
  let botPorts: BotRoutineExecutorPorts | undefined;
  const routineExecutor = createBotRoutineExecutor({ store, ports: () => {
    if (!botPorts) throw new Error("Durable Bot routines are unavailable on this host.");
    return botPorts;
  }, notify: () => {}, broadcast: () => {} });
  const service = createScheduleServiceCore({ store,
    globallyEnabled: async () => readJson<{ scheduledTasksEnabled?: boolean }>(join(agentDir, "aiden.json"), {}).scheduledTasksEnabled !== false,
    broadcast: () => {}, warn: (message) => process.stderr.write(message + "\n"), error: (message, error) => process.stderr.write(`${message} ${String(error)}\n`),
    execution: {
      cancel(id) { const controller = active.get(id); controller?.abort(); return !!controller; },
      cancelAll() { for (const controller of active.values()) controller.abort(); },
      async run(task, runId, trigger): Promise<ScheduledRun> {
        const startedAt = Date.now();
        const controller = new AbortController(); active.set(task.id, controller);
        let output = "", error: string | undefined;
        try {
          if (task.botId) return await routineExecutor.run(task, { runId, trigger, signal: controller.signal });
          const workspace = (await workspaceStore(agentDir).load()).find((entry) => entry.id === task.workspaceId);
          if (!workspace) throw new Error("Register and select a workspace before running a schedule.");
          if (accessFor(agentDir, workspace.folderPath) !== "full") throw new Error("Unattended work requires the workspace's explicit full access tier.");
          if (task.mode === "script") {
            if (task.permission !== "full") throw new Error("Script schedules require explicit full permission.");
            const script = await resolveScheduledScript({ script: task.script!, workspaceRoot: workspace.folderPath });
            const result = await runScheduledScript(script, { cwd: workspace.folderPath, signal: controller.signal });
            if (result.exitCode !== 0 || result.timedOut || result.aborted || result.outputLimitExceeded) throw new Error(`Scheduled script failed: ${result.stderr || "cancelled, timed out, or exceeded output budget"}`);
            output = result.stdout;
          } else {
          if (!task.providerFingerprint || await providerFingerprint(agentDir, task.providerId, task.model) !== task.providerFingerprint) throw new Error("The scheduled provider connection changed. Save the task again to approve its current connection.");
          output = await runScheduledInference(agentDir, workspace.folderPath, task, controller.signal, async () => {
            const current = (await workspaceStore(agentDir).load()).find((entry) => entry.id === workspace.id);
            if (current?.folderPath !== workspace.folderPath || accessFor(agentDir, workspace.folderPath) !== "full" || await providerFingerprint(agentDir, task.providerId, task.model) !== task.providerFingerprint) throw new Error("The scheduled workspace or provider authority changed.");
          });
          }
        } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        finally { active.delete(task.id); }
        return store.recordRun({ taskId: task.id, startedAt, finishedAt: Date.now(), result: error ? "error" : "success", output, error });
      },
    },
  });
  async function saveInput(input: ScheduledTaskInput, options?: { expectedUpdatedAt?: number; signal?: AbortSignal }) {
    input = structuredClone(input);
    if (input.botId) return service.save(input, options);
        if (input.mode === "script" && input.permission !== "full") throw new Error("Script schedules require explicit full permission.");
        const servers = await storeFor(agentDir).load();
        input.mcpServerBindings = (input.mcpServerIds ?? []).map((id) => {
          const server = servers.find((item) => item.id === id && item.enabled);
          if (!server) throw new Error("Choose an enabled scheduled MCP connection.");
          return scheduledMcpServerBinding(server);
        });
        if (input.mode === "llm" && input.providerId && input.model) input.providerFingerprint = await providerFingerprint(agentDir, input.providerId, input.model);
        else {
          delete input.providerFingerprint;
          if (input.mode === "llm" && input.enabled !== false) throw new Error("Enabled LLM schedules require an explicit provider and model.");
        }
    return service.save(input, options);
  }
  async function command(args: string[]): Promise<unknown> {
    const [action = "list", value, timezone] = args;
    if (isScheduleMutation(action) && timezone !== undefined) {
      const approval = JSON.parse(timezone) as ScheduleToolApproval;
      if (approval.action !== action) throw new Error("The approved schedule action changed.");
      assertScheduleApproval(agentDir, approval);
      const current = { approval, active: true, firstWrite: true };
      try {
        return await approvedMutation.run(current, () => command(args.slice(0, 2)));
      } finally {
        // Cron callbacks can inherit this async context, but never its one-shot consent.
        current.active = false;
      }
    }
    const currentApproval = approvedMutation.getStore();
    const revision = currentApproval?.active
      ? (JSON.parse(currentApproval.approval.snapshot) as { task?: { updatedAt?: number } }).task?.updatedAt
      : undefined;
    const mutationOptions = revision === undefined ? undefined : { expectedUpdatedAt: revision };
    switch (action) {
      case "list": return store.list();
      case "status": {
        const now = Date.now();
        const tasks = (await store.list()).filter((task) => task.enabled || task.pendingRoutineFires?.length);
        const nextRunAt = tasks.flatMap((task) => task.enabled && task.nextRunAt !== undefined ? [task.nextRunAt] : []).sort((a, b) => a - b)[0];
        return {
          checkedAt: now,
          nextRunAt: nextRunAt ?? null,
          overdueTaskIds: tasks.filter((task) => task.enabled && task.nextRunAt !== undefined && task.nextRunAt < now - 15 * 60_000).map((task) => task.id),
          pendingRoutineFires: tasks.reduce((count, task) => count + (task.pendingRoutineFires?.length ?? 0), 0),
        };
      }
      case "runs": if (!value) throw new Error("Provide a task id."); return store.runs(value);
      case "notifications": {
        const since = value === undefined ? undefined : Number(value);
        if (value !== undefined && (!/^(?:0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(since))) throw new Error("Provide an epoch-milliseconds cursor.");
        const tasks = await store.list();
        const items: Array<Record<string, unknown>> = [];
        for (const task of tasks) {
          let taskName: string;
          let runs: Awaited<ReturnType<typeof store.runs>>;
          try {
            taskName = [...task.name].slice(0, 120).join("");
            runs = await store.runs(task.id);
          } catch {
            // A task deleted between list() and here must not poison the feed.
            continue;
          }
          for (const run of runs) {
            // Inclusive cursor matches the remote contract; consumers dedupe by run id.
            if ((since !== undefined && run.finishedAt < since) || run.result === "silent") continue;
            // A corrupt stored row must not poison the whole feed; |x| > 8.64e15
            // is finite but still throws inside toISOString.
            if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.finishedAt)
              || Math.abs(run.startedAt) > 8.64e15 || Math.abs(run.finishedAt) > 8.64e15
              || run.finishedAt < run.startedAt) continue;
            const failed = run.result === "error" || run.result === "blocked";
            const text = run.error ?? run.output;
            const summary = text === undefined ? undefined : [...text].slice(0, 2_000).join("");
            items.push({ id: run.id, taskId: task.id, taskName, status: failed ? "failed" : "succeeded", startedAt: new Date(run.startedAt).toISOString(), finishedAt: new Date(run.finishedAt).toISOString(), notify: task.notify, ...(summary ? { summary } : {}), ...(failed ? { errorCode: run.result === "blocked" ? "blocked" : "execution_failed" } : {}) });
          }
        }
        // Oldest 100 kept (returned newest-first): a consumer's cursor only
        // advances past delivered items, so overflow arrives on the next poll.
        items.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
        return { notifications: items.slice(0, 100).reverse(), now: Date.now() };
      }
      case "preview": if (!value) throw new Error("Provide a quoted cron expression."); return nextScheduledRuns(value, timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, 5);
      case "save": {
        if (!value) throw new Error("Provide a JSON file containing ScheduledTaskInput.");
        const input = JSON.parse(readFileSync(value, "utf8")) as ScheduledTaskInput;
        return saveInput(input, mutationOptions);
      }
      case "remove": await service.remove(value, mutationOptions); return { removed: value };
      case "pause": return service.pause(value, mutationOptions);
      case "resume": return service.resume(value, mutationOptions);
      case "run": return service.runNow(value);
      default: throw new Error("Usage: schedule list|status | save <json-file> | preview <cron> [timezone] | runs|notifications [since-ms]|run|pause|resume|remove <id>");
    }
  }
  return { store, service: { ...service, save: saveInput }, command, setBotPorts(ports: BotRoutineExecutorPorts) { botPorts = ports; } };
}

export { daemonSocket, remoteDaemonCommand } from "./daemon-control.ts";

export async function scheduleCommand(agentDir: string, args: string[]) {
  try { return await remoteDaemonCommand(agentDir, "schedule", args); }
  catch (error) { if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  const release = acquireLease(join(agentDir, "serve"));
  const runtime = createCliScheduler(agentDir);
  try { return await runtime.command(args); }
  finally { await runtime.service.stopAndSettle(); release(); }
}
