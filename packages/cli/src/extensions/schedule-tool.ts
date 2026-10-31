import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { scheduleCommand } from "../schedules.ts";
import { atomicJson } from "../state.ts";
import { accessFor } from "../workspaces.ts";
import { isScheduleMutation, scheduleApprovalSnapshot, type ScheduleToolApproval } from "../schedule-tool-approval.ts";
import { nextScheduledRun, systemTimezone, validateTimezone } from "../../../../main/services/schedule-store-core.js";
import { assertSafeScheduledPrompt } from "../../../../main/services/schedule-guard.js";
import type { ScheduledTask, ScheduledTaskInput } from "../../../../main/services/types.js";

export const isOwnedScheduleTool = (pi: Pick<ExtensionAPI, "getAllTools">, name: string, input: unknown): boolean =>
  name === "schedule_task" && input !== null && typeof input === "object" &&
  isScheduleMutation((input as { action?: unknown }).action) && typeof pi.getAllTools === "function" &&
  pi.getAllTools().some((tool) => tool.name === name && tool.sourceInfo.path === "<inline:aiden-schedule>");

export function createScheduleExtension(agentDir: string): InlineExtension {
  return { name: "aiden-schedule", factory(pi) {
    const submitted = new Set<string>();
    pi.registerTool({ name: "schedule_task", label: "Scheduled task", description: "Author, preview, list, pause, resume, or remove scheduled tasks. Unattended execution requires a registered workspace with full access and a running aiden serve daemon. Never schedule work without the user's request.",
      parameters: Type.Object({
        action: Type.Union(["list", "preview", "save", "pause", "resume", "remove", "runs"].map((value) => Type.Literal(value))),
        id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String({ maxLength: 32768 })), workspaceId: Type.Optional(Type.String()),
        permission: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full")])), enabled: Type.Optional(Type.Boolean()),
        notify: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, input, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (accessFor(agentDir, ctx.cwd) === "none") throw new Error("Workspace tool access is disabled.");
        const proposed = structuredClone(input);
        const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
        const modelBinding = JSON.stringify(ctx.model);
        let approval: ScheduleToolApproval | undefined;
        let preparedSave: Readonly<ScheduledTaskInput> | undefined;
        if (isScheduleMutation(proposed.action)) {
          if (submitted.has(_id)) throw new Error("This schedule request was already submitted. Inspect the schedules before trying again.");
          submitted.add(_id);
          approval = { cwd: ctx.cwd, action: proposed.action, input: proposed, snapshot: "", expiresAt: Date.now() + 5 * 60_000, approvalFile: join(agentDir, "schedule-proposals", `${randomUUID()}.approval.json`) };
          approval.snapshot = scheduleApprovalSnapshot(agentDir, approval);
          const snapshot = JSON.parse(approval.snapshot);
          const { id, name, folderPath, access } = snapshot.workspace;
          const task = snapshot.task as ScheduledTask | null;
          if (proposed.action === "save") {
            if (!proposed.name?.trim() || !proposed.cron?.trim() || !proposed.prompt?.trim() || !proposed.workspaceId || !model) {
              throw new Error("Save requires name, cron, prompt, workspaceId, and a selected model.");
            }
            if (task?.executionProfile || task?.botId || task?.routineSchedule) {
              throw new Error("This task has a specialized owner. Edit it through its owning feature or direct schedule administration.");
            }
            if (proposed.permission !== undefined && proposed.permission !== "read-only" && proposed.permission !== "full") {
              throw new Error("Invalid scheduled task permission.");
            }
            if ((proposed.enabled !== undefined && typeof proposed.enabled !== "boolean") || (proposed.notify !== undefined && typeof proposed.notify !== "boolean")) {
              throw new Error("Scheduled task enabled and notify values must be boolean.");
            }
            const timezone = validateTimezone(proposed.timezone ?? task?.timezone ?? systemTimezone());
            const prompt = proposed.prompt.trim();
            assertSafeScheduledPrompt(prompt);
            nextScheduledRun(proposed.cron, timezone);
            preparedSave = Object.freeze({ id: proposed.id, name: proposed.name.trim().slice(0, 120), cron: proposed.cron.trim(), prompt, timezone,
              workspaceId: proposed.workspaceId, permission: proposed.permission ?? "read-only", enabled: proposed.enabled ?? true,
              mode: "llm", providerId: model.provider, model: model.id, notify: proposed.notify ?? true, mcpServerIds: [], mcpServerBindings: [], webSearchEnabled: false });
            Object.freeze(preparedSave.mcpServerIds);
            Object.freeze(preparedSave.mcpServerBindings);
          }
          const currentTask = task ? { id: task.id, name: task.name, cron: task.cron, timezone: task.timezone,
            permission: task.permission, enabled: task.enabled, providerId: task.providerId, model: task.model } : null;
          const resumedTask = proposed.action === "resume" && task ? {
            id: task.id, name: task.name, mode: task.mode, cron: task.cron, timezone: task.timezone, enabled: true,
            prompt: task.prompt, script: task.script, workspaceId: task.workspaceId, permission: task.permission,
            providerId: task.providerId, model: task.model, notify: task.notify ?? true,
            mcpServerIds: task.mcpServerIds ?? [], mcpServerBindings: task.mcpServerBindings ?? [], webSearchEnabled: task.webSearchEnabled ?? false,
            executionProfile: task.executionProfile, botId: task.botId, routineSchedule: task.routineSchedule,
          } : undefined;
          const summary = JSON.stringify({ workspace: { id, name, folderPath, access },
            request: preparedSave ? { action: "save", ...preparedSave } : proposed, model, currentTask, resumedTask });
          if (Buffer.byteLength(summary) > 4_000) throw new Error("This schedule request exceeds the approval display budget. Shorten the task before saving or resuming it.");
          if (!ctx.hasUI || !await ctx.ui.confirm("Allow scheduled-task change?", summary)) throw new Error("Scheduled-task change was not approved.");
          signal?.throwIfAborted();
          if (ctx.cwd !== approval.cwd || JSON.stringify(input) !== JSON.stringify(proposed) || JSON.stringify(ctx.model) !== modelBinding || scheduleApprovalSnapshot(agentDir, approval) !== approval.snapshot) {
            throw new Error("The schedule request or its authority changed. Review it again.");
          }
        }
        input = proposed;
        const invalidate = () => { if (approval) rmSync(approval.approvalFile, { force: true }); };
        if (approval) {
          atomicJson(approval.approvalFile, approval.snapshot);
          signal?.addEventListener("abort", invalidate, { once: true });
          if (signal?.aborted) { invalidate(); signal.throwIfAborted(); }
        }
        const proof = approval ? [JSON.stringify(approval)] : [];
        try {
        let result: unknown;
        if (input.action === "save") {
          if (!preparedSave) throw new Error("The schedule save was not prepared for approval.");
          const file = join(agentDir, "schedule-proposals", `${randomUUID()}.json`);
          atomicJson(file, preparedSave);
          try { result = await scheduleCommand(agentDir, ["save", file, ...proof]); } finally { rmSync(file, { force: true }); }
        } else if (input.action === "preview") {
          if (!input.cron) throw new Error("Preview requires a cron expression.");
          result = await scheduleCommand(agentDir, ["preview", input.cron, input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone]);
        } else {
          if (input.action !== "list" && !input.id) throw new Error("Provide a task id.");
          result = await scheduleCommand(agentDir, [input.action, ...(input.id ? [input.id] : []), ...proof]);
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: null };
        } finally {
          signal?.removeEventListener("abort", invalidate);
          invalidate();
        }
      },
    });
  } };
}
