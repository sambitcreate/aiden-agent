import { BOT_OPEN_WORK_CHANNELS, parseBotOpenWorkId, parseBotOpenWorkMutation, type BotOpenWorkMutation, type BotOpenWorkResult, type BotOpenWorkSnapshot, type BotOpenWorkEvidence } from "../../renderer/shared/bot-open-work.js";
import { parseBotId } from "./bot-params.js";
import type { RendererDocumentOwner } from "../services/renderer-document-owner.js";

export interface BotOpenWorkOwnerPort {
  snapshot(botId: string): Promise<BotOpenWorkSnapshot>;
  mutateByPerson(botId: string, mutation: BotOpenWorkMutation): Promise<BotOpenWorkResult>;
  evidence(botId: string, id: string, kind: "source" | "result"): Promise<BotOpenWorkEvidence | undefined>;
}
export function registerBotOpenWorkHandlers<Event>(ports: {
  handle(channel: string, action: (event: Event, value: unknown) => Promise<unknown>): void;
  owner(event: Event): Pick<RendererDocumentOwner, "isDestroyed">;
  service(): Promise<BotOpenWorkOwnerPort>;
}): void {
  for (const action of ["snapshot", "mutate", "evidence"] as const) ports.handle(BOT_OPEN_WORK_CHANNELS[action], async (event, value) => {
    if (ports.owner(event).isDestroyed()) throw new Error("This Open work request came from an inactive application document.");
    let botId: string; let mutation: BotOpenWorkMutation | undefined; let id: string | undefined; let kind: "source" | "result" | undefined;
    try {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["botId", ...(action === "mutate" ? ["mutation"] : action === "evidence" ? ["id", "kind"] : [])].includes(key))) throw new Error("Invalid request.");
      const data = value as Record<string, unknown>; botId = parseBotId(data.botId);
      if (action === "mutate") mutation = parseBotOpenWorkMutation(data.mutation);
      if (action === "evidence") { id = parseBotOpenWorkId(data.id); if (data.kind !== "source" && data.kind !== "result") throw new Error("Invalid evidence."); kind = data.kind; }
    } catch {
      if (action === "mutate") return { ok: false, code: "invalid", error: "Review this Open work change and try again." } satisfies BotOpenWorkResult;
      throw new Error("Invalid Open work request.");
    }
    const service = await ports.service();
    if (action === "evidence") return await service.evidence(botId, id!, kind!) ?? null;
    return action === "snapshot" ? service.snapshot(botId) : service.mutateByPerson(botId, mutation!);
  });
}
