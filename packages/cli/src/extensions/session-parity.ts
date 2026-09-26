import { resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { deriveChatTitleSeed, buildChatTitlePrompt, sanitizeGeneratedChatTitle } from "../../../../main/services/chat-title-policy.js";
import { readPickedAttachments } from "../../../../main/services/attachments.js";
import { exportSession, searchSessions, messageText } from "../sessions.ts";
import { workspaceCommand, accessFor } from "../workspaces.ts";
import { recordUsage } from "../usage-ledger.ts";
import { splitArgs } from "../state.ts";

export function createSessionParityExtension(agentDir: string): InlineExtension {
  return { name: "aiden-sessions", factory(pi) {
    let titleTask: Promise<void> | undefined;
    pi.on("before_agent_start", async (event, ctx) => {
      if (process.env.AIDEN_CHILD === "1" || pi.getSessionName() || titleTask) return;
      const id = ctx.sessionManager.getSessionId();
      const seed = deriveChatTitleSeed({ content: event.prompt });
      pi.setSessionName(seed);
      if (!ctx.model) return;
      titleTask = (async () => {
        try {
          const response = await ctx.modelRegistry.complete(ctx.model!, {
            messages: [{ role: "user", content: buildChatTitlePrompt({ content: event.prompt }), timestamp: Date.now() }],
          }, { signal: AbortSignal.timeout(15_000), maxTokens: 100 });
          await recordUsage(agentDir, "chat-title", response);
          const title = sanitizeGeneratedChatTitle(messageText(response.content));
          if (title && ctx.sessionManager.getSessionId() === id && pi.getSessionName() === seed) pi.setSessionName(title);
        } catch { /* The deterministic title seed survives offline/auth failures. */ }
        finally { titleTask = undefined; }
      })();
    });
    pi.on("tool_call", async (event, ctx) => {
      if (process.env.AIDEN_CHILD === "1") {
        const allowed = process.env.AIDEN_CHILD_PERMISSION === "full" ? ["read", "bash", "edit", "write", "grep", "find", "ls"] : ["read", "grep", "find", "ls"];
        return allowed.includes(event.toolName) ? undefined : { block: true, reason: "Tool outside the delegated capability profile." };
      }
      try {
      const tier = accessFor(agentDir, ctx.cwd);
      if (tier === "full") return;
      if (tier === "none") return { block: true, reason: "Workspace tool access is disabled. Change it with /workspace access." };
      // Every tool is gated: extension/MCP tools can read, write, or send data too.
      const original = JSON.stringify(event.input);
      if (Buffer.byteLength(original) > 4000) return { block: true, reason: "This request exceeds the approval display budget. Split it into smaller operations." };
      if (!ctx.hasUI || !await ctx.ui.confirm(`Allow ${event.toolName}?`, original) || JSON.stringify(event.input) !== original || accessFor(agentDir, ctx.cwd) === "none") {
        return { block: true, reason: "This workspace requires approval for each unchanged tool call." };
      }
      } catch { return { block: true, reason: "Workspace authority could not be verified." }; }
    });
    const commands = {
      search: { description: "Search session titles and previews", run: (args: string) => searchSessions(agentDir, args) },
      workspace: { description: "List, register, or set workspace access", run: (args: string) => workspaceCommand(agentDir, splitArgs(args)) },
      scratch: { description: "Create a private scratch workspace", run: () => workspaceCommand(agentDir, ["scratch"]) },
    };
    for (const [name, command] of Object.entries(commands)) pi.registerCommand(name, {
      description: command.description,
      handler: async (args, ctx) => { ctx.ui.notify(JSON.stringify(await command.run(args), null, 2), "info"); },
    });
    pi.registerCommand("export-aiden", { description: "Export the current branch as portable .aiden-chat.json",
      handler: async (args, ctx) => {
        const [target] = splitArgs(args);
        ctx.ui.notify(await exportSession(ctx.sessionManager, resolve(ctx.cwd, target ?? `${ctx.sessionManager.getSessionId()}.aiden-chat.json`)), "info");
      },
    });
    pi.registerCommand("attach", { description: "Attach files using Aiden's batch and image limits",
      handler: async (args, ctx) => {
        const paths = splitArgs(args);
        if (!paths.length) throw new Error("Usage: /attach <paths…>");
        const attachments = await readPickedAttachments(paths.map((path) => resolve(ctx.cwd, path)));
        pi.sendUserMessage(attachments.map((attachment) => attachment.kind === "image"
          ? { type: "image" as const, data: attachment.data!, mimeType: attachment.mimeType }
          : { type: "text" as const, text: `File: ${attachment.name}\n${attachment.text}` }));
      },
    });
  } };
}
