import { Type } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { scheduleCommand } from "../schedules.ts";
import { atomicJson } from "../state.ts";

export function createScheduleExtension(agentDir: string): InlineExtension {
  return { name: "aiden-schedule", factory(pi) {
    pi.registerTool({ name: "schedule_task", label: "Scheduled task", description: "Author, preview, list, pause, resume, or remove scheduled tasks. Unattended execution requires a registered workspace with full access and a running aiden serve daemon. Never schedule work without the user's request.",
      parameters: Type.Object({
        action: Type.Union(["list", "preview", "save", "pause", "resume", "remove", "runs"].map((value) => Type.Literal(value))),
        id: Type.Optional(Type.String()), name: Type.Optional(Type.String()), cron: Type.Optional(Type.String()), timezone: Type.Optional(Type.String()),
        prompt: Type.Optional(Type.String({ maxLength: 32768 })), workspaceId: Type.Optional(Type.String()),
        permission: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("full")])), enabled: Type.Optional(Type.Boolean()),
        notify: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, input, _signal, _onUpdate, ctx) {
        let result: unknown;
        if (input.action === "save") {
          if (!input.name || !input.cron || !input.prompt || !input.workspaceId || !ctx.model) throw new Error("Save requires name, cron, prompt, workspaceId, and a selected model.");
          const file = join(agentDir, "schedule-proposals", `${randomUUID()}.json`);
          atomicJson(file, { id: input.id, name: input.name, cron: input.cron, prompt: input.prompt, timezone: input.timezone,
            workspaceId: input.workspaceId, permission: input.permission ?? "read-only", enabled: input.enabled ?? true,
            mode: "llm", providerId: ctx.model.provider, model: ctx.model.id, notify: input.notify ?? true, mcpServerIds: [], webSearchEnabled: false });
          try { result = await scheduleCommand(agentDir, ["save", file]); } finally { rmSync(file, { force: true }); }
        } else if (input.action === "preview") {
          if (!input.cron) throw new Error("Preview requires a cron expression.");
          result = await scheduleCommand(agentDir, ["preview", input.cron, input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone]);
        } else {
          if (input.action !== "list" && !input.id) throw new Error("Provide a task id.");
          result = await scheduleCommand(agentDir, [input.action, ...(input.id ? [input.id] : [])]);
        }
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: null };
      },
    });
  } };
}
