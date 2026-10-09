// Placeholder until Track A lands the real service (plan Step 0).
import type { BotMemoryEditInput, BotMemoryEditResult, BotMemoryView, BotMemoryChangedEvent } from "../../../renderer/shared/bot-memory.js";
export interface BotMemoryService {
  view(botId: string): Promise<BotMemoryView>;
  edit(input: BotMemoryEditInput): Promise<BotMemoryEditResult>;
  onChanged(listener: (event: BotMemoryChangedEvent) => void): () => void;
}
const unavailable = () => Promise.reject(new Error("Bot memory is not available yet."));
export const botMemoryService: BotMemoryService = { view: unavailable, edit: unavailable, onChanged: () => () => {} };
