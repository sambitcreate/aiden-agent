import { BOT_PEER_MESSAGE_ENTRY_KIND } from "../../../renderer/shared/bot-peers.js";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotPeerSourceToken } from "./authority.js";
import type { BotPeerService } from "./service.js";
export const BOT_PEER_TOOL = "message_bot";
export function botPeerCandidate(botId: string, ports: { service: Pick<BotPeerService, "discover" | "accept" | "exchange">; source(botId: string, call: BotToolCall): Promise<BotPeerSourceToken>; wake(): void }): BotToolCandidate & {replay:"safe"} {
  const build = (call?: BotToolCall): AgentTool => ({
    name: BOT_PEER_TOOL, label: "Message a Bot", description: "List only this Bot's owner-approved peers and their routing descriptions. Send a bounded explicit request under the receiving Bot's own current rules. Acceptance means queued or waiting, never completed. Interim question/status/FYI needs a correlated exchange. Status/FYI is a quiet exchange-log update and does not start a model. The host returns the terminal result; never label arbitrary text as a terminal result. Do not send secrets or unrelated conversation history.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("send")]), peerId: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("request"), Type.Literal("question"), Type.Literal("status"), Type.Literal("fyi")])), title: Type.Optional(Type.String({ maxLength: 160 })), text: Type.Optional(Type.String({ maxLength: 8192 })), exchangeId: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id, raw) {
      if (!call) throw new Error("Messaging needs its actual calling Bot task.");
      const source = await ports.source(botId, call), args = raw as { action: "list" | "send"; peerId?: string; kind?: "request" | "question" | "status" | "fyi"; title?: string; text?: string; exchangeId?: string };
      if (args.action === "list") return { content: [{ type: "text", text: JSON.stringify(await ports.service.discover(botId)) }], details: null };
      const result = await ports.service.accept(source, { peerId: args.peerId!, kind: args.kind ?? "request", title: args.title!, text: args.text!, ...(args.exchangeId ? { exchangeId: args.exchangeId } : {}) });
      // Place the quiet source row before the initiating model can emit an
      // acknowledgement. This uses the current task transaction, not a host
      // open that a concurrent Pause may be waiting to close.
      const exchange=await ports.service.exchange(botId,result.exchangeId);
      if(!exchange||exchange.direction!=="sent")throw new Error("The accepted peer source row is unavailable.");
      const row={exchangeId:exchange.id,direction:"sent",peerBotId:exchange.recipient.botId,peerName:exchange.recipient.name,messageKind:exchange.kind,at:exchange.createdAt}as const;
      if(call.appendEntryOnce)await call.appendEntryOnce(`peer-row:${exchange.id}:sent`,BOT_PEER_MESSAGE_ENTRY_KIND,row);else await call.appendEntry(BOT_PEER_MESSAGE_ENTRY_KIND,row);
      ports.wake(); return { content: [{ type: "text", text: JSON.stringify({ accepted: true, ...result }) }], details: null };
    },
  });
  return { tool: build(), replay: "safe", bind: (call) => build(call) };
}
