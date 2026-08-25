import {
  BOT_CAPABILITY_LIMITS,
  assertBotIdentity,
  isPathSafeBotCapabilityId,
} from "../../renderer/shared/bot-capabilities.js";

const INVALIDATED = "Bot access changed while this work was active.";

export interface BotCapabilityLeaseIdentity {
  audienceId: string;
  botId: string;
  botPolicyEpoch: number;
  chatId?: string;
  chatPolicyEpoch?: number;
}

export interface BotCapabilityAuthorityLease {
  readonly audienceId: string;
  readonly botId: string;
  readonly botPolicyEpoch: number;
  readonly chatId?: string;
  readonly chatPolicyEpoch?: number;
  readonly signal: AbortSignal;
  /** Synchronous fence immediately before each tool effect. */
  assertCurrent(): void;
  release(): void;
}

interface ActiveLease {
  audienceId: string;
  botGeneration: number;
  chatId?: string;
  chatGeneration?: number;
  controller: AbortController;
}

interface BotLeaseEntry {
  generation: number;
  policyEpoch: number;
  active: Set<ActiveLease>;
  chats: Map<string, { generation: number; policyEpoch: number }>;
}

function assertEpoch(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid Bot ${label} epoch.`);
  }
  return value;
}

function assertAudienceId(value: unknown): string {
  if (!isPathSafeBotCapabilityId(value, BOT_CAPABILITY_LIMITS.chatIdChars)) {
    throw new Error("Invalid Bot capability lease audience.");
  }
  return value;
}

/**
 * Process-owned authority fence. Durable epochs reject stale snapshots after a
 * restart; runtime generations also close leases on both sides of publication.
 */
export class BotCapabilityLeaseRegistry {
  private readonly entries = new Map<string, BotLeaseEntry>();

  private entry(botId: string, initialPolicyEpoch = 1): BotLeaseEntry {
    const safeBotId = assertBotIdentity(botId, "bot");
    let entry = this.entries.get(safeBotId);
    if (!entry) {
      entry = {
        generation: 1,
        policyEpoch: assertEpoch(initialPolicyEpoch, "policy"),
        active: new Set(),
        chats: new Map(),
      };
      this.entries.set(safeBotId, entry);
    }
    return entry;
  }

  private nextGeneration(value: number): number {
    if (value >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Bot capability lease generation is exhausted.");
    }
    return value + 1;
  }

  private abortMatching(entry: BotLeaseEntry, predicate: (lease: ActiveLease) => boolean): void {
    for (const lease of entry.active) {
      if (!predicate(lease)) continue;
      entry.active.delete(lease);
      lease.controller.abort(new Error(INVALIDATED));
    }
  }

  acquire(identity: BotCapabilityLeaseIdentity): BotCapabilityAuthorityLease {
    const audienceId = assertAudienceId(identity.audienceId);
    const botId = assertBotIdentity(identity.botId, "bot");
    const botPolicyEpoch = assertEpoch(identity.botPolicyEpoch, "policy");
    if ((identity.chatId === undefined) !== (identity.chatPolicyEpoch === undefined)) {
      throw new Error("Bot chat lease identity and epoch must be supplied together.");
    }
    const entry = this.entry(botId, botPolicyEpoch);
    if (botPolicyEpoch < entry.policyEpoch) {
      throw new Error("Bot capability policy lease is stale.");
    }
    if (botPolicyEpoch > entry.policyEpoch) {
      this.publishBotEpoch(botId, botPolicyEpoch);
    }

    const chatId =
      identity.chatId === undefined ? undefined : assertBotIdentity(identity.chatId, "chat");
    const chatPolicyEpoch =
      identity.chatPolicyEpoch === undefined
        ? undefined
        : assertEpoch(identity.chatPolicyEpoch, "chat policy");
    let chatGeneration: number | undefined;
    if (chatId !== undefined && chatPolicyEpoch !== undefined) {
      let chat = entry.chats.get(chatId);
      if (!chat) {
        chat = { generation: 1, policyEpoch: chatPolicyEpoch };
        entry.chats.set(chatId, chat);
      } else if (chatPolicyEpoch < chat.policyEpoch) {
        throw new Error("Bot chat capability policy lease is stale.");
      } else if (chatPolicyEpoch > chat.policyEpoch) {
        this.publishChatEpoch(botId, chatId, chatPolicyEpoch);
        chat = entry.chats.get(chatId)!;
      }
      chatGeneration = chat.generation;
    }

    const controller = new AbortController();
    const active: ActiveLease = {
      audienceId,
      botGeneration: entry.generation,
      ...(chatId === undefined ? {} : { chatId }),
      ...(chatGeneration === undefined ? {} : { chatGeneration }),
      controller,
    };
    entry.active.add(active);
    let released = false;
    const assertCurrent = () => {
      const current = this.entries.get(botId);
      const currentChat = chatId === undefined ? undefined : current?.chats.get(chatId);
      if (
        released ||
        controller.signal.aborted ||
        !current ||
        current.generation !== active.botGeneration ||
        current.policyEpoch !== botPolicyEpoch ||
        (chatId !== undefined &&
          (!currentChat ||
            currentChat.generation !== active.chatGeneration ||
            currentChat.policyEpoch !== chatPolicyEpoch))
      ) {
        throw new Error(INVALIDATED);
      }
    };
    return Object.freeze({
      audienceId,
      botId,
      botPolicyEpoch,
      ...(chatId === undefined ? {} : { chatId }),
      ...(chatPolicyEpoch === undefined ? {} : { chatPolicyEpoch }),
      signal: controller.signal,
      assertCurrent,
      release: () => {
        if (released) return;
        released = true;
        entry.active.delete(active);
      },
    });
  }

  /** Close every active lease, including one acquired while a write was pending. */
  invalidateBot(botId: string): void {
    const entry = this.entry(botId);
    entry.generation = this.nextGeneration(entry.generation);
    this.abortMatching(entry, () => true);
  }

  invalidateChat(botId: string, chatId: string): void {
    const entry = this.entry(botId);
    const safeChatId = assertBotIdentity(chatId, "chat");
    const chat = entry.chats.get(safeChatId) ?? { generation: 1, policyEpoch: 1 };
    chat.generation = this.nextGeneration(chat.generation);
    entry.chats.set(safeChatId, chat);
    this.abortMatching(
      entry,
      (lease) => lease.chatId === safeChatId,
    );
  }

  invalidateAudience(audienceId: string): void {
    const safeAudienceId = assertAudienceId(audienceId);
    for (const entry of this.entries.values()) {
      this.abortMatching(entry, (lease) => lease.audienceId === safeAudienceId);
    }
  }

  publishBotEpoch(botId: string, policyEpoch: number): void {
    const nextEpoch = assertEpoch(policyEpoch, "policy");
    const entry = this.entry(botId, nextEpoch);
    if (nextEpoch < entry.policyEpoch) {
      throw new Error("Bot capability policy epoch rolled back.");
    }
    if (nextEpoch === entry.policyEpoch) return;
    entry.policyEpoch = nextEpoch;
    entry.generation = this.nextGeneration(entry.generation);
    this.abortMatching(entry, () => true);
  }

  publishChatEpoch(botId: string, chatId: string, policyEpoch: number): void {
    const entry = this.entry(botId);
    const safeChatId = assertBotIdentity(chatId, "chat");
    const nextEpoch = assertEpoch(policyEpoch, "chat policy");
    const chat = entry.chats.get(safeChatId) ?? { generation: 1, policyEpoch: nextEpoch };
    if (nextEpoch < chat.policyEpoch) {
      throw new Error("Bot chat capability policy epoch rolled back.");
    }
    if (nextEpoch === chat.policyEpoch) {
      entry.chats.set(safeChatId, chat);
      return;
    }
    chat.policyEpoch = nextEpoch;
    chat.generation = this.nextGeneration(chat.generation);
    entry.chats.set(safeChatId, chat);
    this.abortMatching(
      entry,
      (lease) => lease.chatId === safeChatId,
    );
  }

  activeCount(botId: string): number {
    return this.entries.get(assertBotIdentity(botId, "bot"))?.active.size ?? 0;
  }
}

export const botCapabilityLeases = new BotCapabilityLeaseRegistry();
