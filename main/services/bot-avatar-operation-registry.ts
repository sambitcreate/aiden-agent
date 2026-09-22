import { BOT_AVATAR_GENERATION_FAILURE_MESSAGES } from "../../renderer/shared/bots.js";

interface ActiveBotAvatarOperation {
  controller: AbortController;
  requestId: string;
}

export interface BotAvatarOperationAdmission {
  signal: AbortSignal;
  cancel(): void;
  finish(): void;
}

/** Main-owned single-flight boundary for paid face-generation requests. */
export class BotAvatarOperationRegistry {
  private readonly active = new Map<string, ActiveBotAvatarOperation>();

  admit(documentId: string, requestId: string): BotAvatarOperationAdmission {
    if (this.active.has(documentId)) {
      throw new Error(BOT_AVATAR_GENERATION_FAILURE_MESSAGES.busy);
    }
    const operation: ActiveBotAvatarOperation = {
      controller: new AbortController(),
      requestId,
    };
    this.active.set(documentId, operation);
    const cancel = () => operation.controller.abort();
    return {
      signal: operation.controller.signal,
      cancel,
      finish: () => {
        if (this.active.get(documentId) === operation) this.active.delete(documentId);
      },
    };
  }

  cancel(documentId: string, requestId: string): boolean {
    const operation = this.active.get(documentId);
    if (!operation || operation.requestId !== requestId) return false;
    operation.controller.abort();
    return true;
  }
}

export const botAvatarOperations = new BotAvatarOperationRegistry();
