import { Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { declarePiRuntimeReplay } from "./pi-runtime-tool.js";

export const TAILSCALE_PREVIEW_TOOL_NAME = "tailscale_serve";

export function canUseTailscalePreviewTool(input: {
  workspaceId?: string; folderPath?: string; permission: string;
  assistantMode: boolean; bot: boolean; usageSource?: string;
}): boolean {
  return Boolean(input.workspaceId && input.folderPath)
    && (input.permission === "ask" || input.permission === "full")
    && !input.assistantMode && !input.bot && input.usageSource === "chat";
}

export interface TailscalePreviewPort {
  open(workspaceId: string, input: { localPort: number; exposedPort?: number }, beforeEffect: () => Promise<void>): Promise<unknown>;
  list(workspaceId: string): Promise<unknown>;
  stop(workspaceId: string, input: { id: string }, beforeEffect: () => Promise<void>): Promise<unknown>;
}

/** No renderer ownership: attended native-client generations have the same tool. */
export function createTailscalePreviewTool(context: {
  workspaceId: string;
  signal: AbortSignal;
  revalidate: () => Promise<void>;
  service: () => Promise<TailscalePreviewPort>;
}): AgentTool {
  const port = Type.Integer({ minimum: 1024, maximum: 65535 });
  const tool: AgentTool = {
    name: TAILSCALE_PREVIEW_TOOL_NAME,
    label: "Tailscale HTTP preview",
    description: "Expose an already-running localhost HTTP development server to native client browsers using private Tailscale Serve. Use open with localPort (for example 3000), optionally exposedPort. Requires Tailscale running on the host and client. Does not start a server or publish to the internet. Existing routes cannot be replaced. Present the returned URL as a clickable Markdown link so the user can open it in their client Browser. Forwards persist until stopped, including across restarts. Use list to check this workspace's forwards; stop with an id to remove an owned forward. Active means the route is configured, not that the client can reach it. HTTP has no browser secure-context guarantees. Do not retry an uncertain mutation blindly: inspect list first.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("open"), Type.Literal("list"), Type.Literal("stop")]),
      localPort: Type.Optional(port),
      exposedPort: Type.Optional(port),
      id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    }, { additionalProperties: false }),
    execute: async (callId, raw, callSignal) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Preview arguments must be an object.");
      const original = raw as Record<string, unknown>;
      const allowedFields = original.action === "open" ? ["action", "localPort", "exposedPort"]
        : original.action === "stop" ? ["action", "id"] : ["action"];
      if (Object.keys(original).some((key) => !allowedFields.includes(key))
        || (original.localPort !== undefined && (!Number.isInteger(original.localPort) || Number(original.localPort) < 1024 || Number(original.localPort) > 65535))
        || (original.exposedPort !== undefined && (!Number.isInteger(original.exposedPort) || Number(original.exposedPort) < 1024 || Number(original.exposedPort) > 65535))) {
        throw new Error("Preview arguments contain unsupported fields or port values.");
      }
      const args = validateToolArguments(tool, { type: "toolCall", id: callId, name: tool.name, arguments: raw as Record<string, unknown> }) as
        | { action: "open"; localPort: number; exposedPort?: number }
        | { action: "list" }
        | { action: "stop"; id: string };
      const fields = Object.keys(args);
      const allowed = args.action === "open" ? ["action", "localPort", "exposedPort"]
        : args.action === "stop" ? ["action", "id"] : ["action"];
      if (fields.some((key) => !allowed.includes(key))
        || (args.action === "open" && !Number.isInteger(args.localPort))
        || (args.action === "stop" && !args.id)) {
        throw new Error("Use open with localPort and optional exposedPort, list without other fields, or stop with id.");
      }
      const signal = callSignal ? AbortSignal.any([context.signal, callSignal]) : context.signal;
      const beforeEffect = async () => {
        signal.throwIfAborted();
        await context.revalidate();
        signal.throwIfAborted();
      };
      await beforeEffect();
      const service = await context.service();
      await beforeEffect();
      const result = args.action === "open"
        ? await service.open(context.workspaceId, { localPort: args.localPort, exposedPort: args.exposedPort }, beforeEffect)
        : args.action === "stop"
          ? await service.stop(context.workspaceId, { id: args.id }, beforeEffect)
          : await service.list(context.workspaceId);
      await beforeEffect();
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: null };
    },
  };
  return declarePiRuntimeReplay(tool, "never");
}
