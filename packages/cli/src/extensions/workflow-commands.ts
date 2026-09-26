import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { gitCommand, worktreeCommand, filesCommand } from "../git-commands.ts";
import { scheduleCommand } from "../schedules.ts";
import { splitArgs } from "../state.ts";

export function createWorkflowCommands(agentDir: string): InlineExtension {
  return { name: "aiden-workflows", factory(pi) {
    pi.registerCommand("files", { description: "List workspace files or read a relative path", handler: async (args, ctx) => ctx.ui.notify(JSON.stringify(await filesCommand(ctx.cwd, splitArgs(args)), null, 2), "info") });
    pi.registerCommand("git", { description: "Show status, review, branches, or worktrees", handler: async (args, ctx) => ctx.ui.notify(JSON.stringify(await gitCommand(ctx.cwd, splitArgs(args)), null, 2), "info") });
    pi.registerCommand("worktree", { description: "Create, list, or remove CLI-managed git worktrees", handler: async (args, ctx) => ctx.ui.notify(JSON.stringify(await worktreeCommand(agentDir, ctx.cwd, splitArgs(args)), null, 2), "info") });
    pi.registerCommand("schedule", { description: "Author, preview, or run scheduled tasks", handler: async (args, ctx) => ctx.ui.notify(JSON.stringify(await scheduleCommand(agentDir, splitArgs(args)), null, 2), "info") });
  } };
}
