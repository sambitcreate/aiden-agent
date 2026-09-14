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

async function providerFingerprint(agentDir: string, providerId?: string, modelId?: string): Promise<string> {
  if (!providerId || !modelId) throw new Error("Select an explicit provider and model for unattended inference.");
  const runtime = await createCliModelRuntime(agentDir);
  const model = runtime.getModel(providerId, modelId);
  if (!model) throw new Error("The scheduled model is unavailable. Review the task's provider selection.");
  return createHash("sha256").update(JSON.stringify({ providerId, modelId, api: model.api, baseUrl: model.baseUrl, headers: model.headers ?? {} })).digest("hex");
}

export function createCliScheduler(agentDir: string) {
  const store = createScheduleStore(new JsonStore<unknown[]>(join(agentDir, "schedules.json"), []), new JsonStore<unknown[]>(join(agentDir, "schedule-runs.json"), []));
  const active = new Map<string, AbortController>();
  const service = createScheduleServiceCore({ store,
    globallyEnabled: async () => readJson<{ scheduledTasksEnabled?: boolean }>(join(agentDir, "aiden.json"), {}).scheduledTasksEnabled !== false,
    broadcast: () => {}, warn: (message) => process.stderr.write(message + "\n"), error: (message, error) => process.stderr.write(`${message} ${String(error)}\n`),
    execution: {
      cancel(id) { const controller = active.get(id); controller?.abort(); return !!controller; },
      cancelAll() { for (const controller of active.values()) controller.abort(); },
      async run(task): Promise<ScheduledRun> {
        const startedAt = Date.now();
        const controller = new AbortController(); active.set(task.id, controller);
        let output = "", error: string | undefined;
        try {
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
  async function command(args: string[]) {
    const [action = "list", value, timezone] = args;
    switch (action) {
      case "list": return store.list();
      case "runs": if (!value) throw new Error("Provide a task id."); return store.runs(value);
      case "notifications": {
        const since = value === undefined ? undefined : Number(value);
        if (value !== undefined && (!/^(?:0|[1-9]\d{0,15})$/.test(value) || !Number.isSafeInteger(since))) throw new Error("Provide an epoch-milliseconds cursor.");
        const tasks = await store.list();
        const items: Array<Record<string, unknown>> = [];
        for (const task of tasks) {
          for (const run of await store.runs(task.id)) {
            // Inclusive cursor matches the remote contract; consumers dedupe by run id.
            if ((since !== undefined && run.finishedAt < since) || run.result === "silent") continue;
            const failed = run.result === "error" || run.result === "blocked";
            const summary = (run.error ?? run.output)?.slice(0, 20_000);
            items.push({ id: run.id, taskId: task.id, taskName: task.name, status: failed ? "failed" : "succeeded", startedAt: new Date(run.startedAt).toISOString(), finishedAt: new Date(run.finishedAt).toISOString(), notify: task.notify, ...(summary ? { summary } : {}), ...(failed ? { errorCode: run.result === "blocked" ? "blocked" : "execution_failed" } : {}) });
          }
        }
        items.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
        return { notifications: items.slice(0, 100) };
      }
      case "preview": if (!value) throw new Error("Provide a quoted cron expression."); return nextScheduledRuns(value, timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, 5);
      case "save": {
        if (!value) throw new Error("Provide a JSON file containing ScheduledTaskInput.");
        const input = JSON.parse(readFileSync(value, "utf8")) as ScheduledTaskInput;
        return saveInput(input);
      }
      case "remove": await service.remove(value); return { removed: value };
      case "pause": return service.pause(value);
      case "resume": return service.resume(value);
      case "run": return service.runNow(value);
      default: throw new Error("Usage: schedule list | save <json-file> | preview <cron> [timezone] | runs|notifications [since-ms]|run|pause|resume|remove <id>");
    }
  }
  return { store, service: { ...service, save: saveInput }, command };
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
