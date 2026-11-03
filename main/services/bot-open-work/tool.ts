import { randomUUID, createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotOpenWorkMutation } from "../../../renderer/shared/bot-open-work.js";
import { parseBotOpenWorkMutation } from "../../../renderer/shared/bot-open-work.js";
import type { BotOpenWorkService } from "./service.js";
import { resolveBotOpenWorkOrigin, type BotOpenWorkRoutineOrigin } from "./provenance.js";
export const BOT_OPEN_WORK_TOOL = "open_work";
interface WorkArgs { action: "list" | "add" | "edit" | "dismiss"; sourceIndex?: number; id?: string; revision?: string; title?: string; note?: string; state?: "open" | "waiting" | "done" | "dismissed"; waitingReason?: string; }
export function botOpenWorkCandidate(botId: string, ports: { service: BotOpenWorkService; routineOrigin: BotOpenWorkRoutineOrigin }): BotToolCandidate {
  const build = (call?: BotToolCall): AgentTool => ({
    name: BOT_OPEN_WORK_TOOL, label: "Open work", description: "Track explicit tasks from the current accepted person request or routine. List records first to obtain item IDs/revisions; add a responsibility, update it, or dismiss it. Do not add ideas/FYIs or claim completion without evidence. Sources and execution links are verified by the host; this tool never schedules work.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("edit"), Type.Literal("dismiss")]), sourceIndex: Type.Optional(Type.Integer({ minimum: 0, maximum: 63 })), id: Type.Optional(Type.String()), revision: Type.Optional(Type.String()), title: Type.Optional(Type.String()), note: Type.Optional(Type.String()), state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("waiting"), Type.Literal("done"), Type.Literal("dismissed")])), waitingReason: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, input) {
      if (!call) throw new Error("Open work needs its calling Bot conversation.");
      const args = input as WorkArgs;
      const origin = await resolveBotOpenWorkOrigin(botId, call, args.sourceIndex, ports.routineOrigin);
      if (args.action === "list") {
        // Store-only snapshot avoids reopening a harness lock held by this tool.
        const snapshot = await ports.service.toolSnapshot(botId);
        return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: null };
      }
      const signature = createHash("sha256").update(JSON.stringify({ args, origin })).digest("hex");
      const snapshot = await ports.service.toolSnapshot(botId);
      const mutationId = randomUUID();
      const candidate: BotOpenWorkMutation = args.action === "add"
        ? { action: "add", mutationId, expectedRevision: snapshot.revision, title: args.title!, ...(args.note !== undefined ? { note: args.note } : {}) }
        : args.action === "dismiss" ? { action: "dismiss", mutationId, expectedRevision: args.revision!, id: args.id! }
          : { action: "edit", mutationId, expectedRevision: args.revision!, id: args.id!, patch: { ...(args.title !== undefined ? { title: args.title } : {}), ...(args.note !== undefined ? { note: args.note } : {}), ...(args.state !== undefined ? { state: args.state } : {}), ...(args.waitingReason !== undefined ? { waitingReason: args.waitingReason } : {}) } };
      const command = parseBotOpenWorkMutation(candidate);
      const memo = await call.memo("aiden.open-work.mutation.v1", { signature, command });
      if (memo.signature !== signature) throw new Error("This replay changed its Open work arguments or source.");
      call.signal.throwIfAborted();
      const result = await ports.service.mutateByBot(botId, memo.command, origin);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: null };
    },
  });
  return { tool: build(), replay: "safe", bind: (call) => build(call) };
}
