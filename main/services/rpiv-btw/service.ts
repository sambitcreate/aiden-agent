import { BTW_LIMITS } from "../../../renderer/shared/btw.js";
import { chatStore } from "../chat-store.js";
import { resolveModelRuntime } from "../model-runtime.js";
import { usageStore } from "../usage-store.js";
import { BtwOperationRegistry } from "./operation-registry.js";
import { BtwService } from "./service-core.js";

let isChatBusy = (_chatId: string): boolean => false;

export const btwOperationRegistry = new BtwOperationRegistry(BTW_LIMITS.concurrentChats);

export const btwService = new BtwService({
  getChat: (chatId) => chatStore.get(chatId),
  resolveRuntime: resolveModelRuntime,
  isChatBusy: (chatId) => isChatBusy(chatId),
  recordUsage: (record) => usageStore.record(record),
  registry: btwOperationRegistry,
});

export function configureBtwChatBusyCheck(check: (chatId: string) => boolean): void {
  isChatBusy = check;
}

export type { BtwOwner } from "./service-core.js";
