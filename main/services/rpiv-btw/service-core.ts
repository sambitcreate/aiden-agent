import { randomUUID } from "node:crypto";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { ASSISTANT_WORKSPACE_ID } from "../../../renderer/shared/assistant.js";
import { BTW_LIMITS, type BtwEventV1, type BtwStartReceiptV1 } from "../../../renderer/shared/btw.js";
import type { ResolvedModelRuntime } from "../model-runtime-core.js";
import type { Chat } from "../types.js";
import { assistantUsageRecord, isLocalModelProvider, unreportedUsageRecord } from "../usage-accounting.js";
import type { UsageRequestRecord } from "../usage-store-core.js";
import {
  assistantText,
  boundedHistory,
  buildBtwContext,
  completedVisibleContext,
  BTW_SYSTEM_PROMPT,
  type BtwHistoryTurn,
} from "./context.js";
import { BtwOperationRegistry } from "./operation-registry.js";

export interface BtwOwner {
  documentId: string;
  isDestroyed(): boolean;
  send(channel: "chats:btw-event", payload: BtwEventV1): void;
  onInvalidated(listener: () => void): () => void;
}

interface EphemeralThread {
  fingerprint: string;
  history: BtwHistoryTurn[];
}

type BtwEventBody = BtwEventV1 extends infer Event
  ? Event extends BtwEventV1
    ? Omit<Event, "version" | "chatId" | "requestId" | "sequence">
    : never
  : never;

export interface BtwServiceDependencies {
  getChat(chatId: string): Promise<Chat | null>;
  resolveRuntime(providerId: string, modelId: string, signal?: AbortSignal): Promise<ResolvedModelRuntime>;
  isChatBusy(chatId: string): boolean;
  recordUsage(record: UsageRequestRecord): Promise<void>;
  registry: BtwOperationRegistry;
}

function fingerprint(chat: Pick<Chat, "providerId" | "model">): string | null {
  return chat.providerId && chat.model ? `${chat.providerId}\u0000${chat.model}` : null;
}

function boundedQuestion(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a side question.");
  const question = value.trim();
  if (!question) throw new Error("Enter a side question after /btw.");
  if (
    Array.from(question).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (code < 32 && code !== 9 && code !== 10) || code === 127;
    }) ||
    /\p{Cf}/u.test(question)
  ) {
    throw new Error("The side question contains unsupported control characters.");
  }
  if (
    Array.from(question).length > BTW_LIMITS.questionCodePoints ||
    Buffer.byteLength(question, "utf8") > BTW_LIMITS.questionBytes
  ) {
    throw new Error("Side questions must be no longer than 4,000 characters.");
  }
  return question;
}

function boundedAnswer(value: string): string {
  return Array.from(value).slice(0, BTW_LIMITS.answerCodePoints).join("");
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/context|token|length|too large/i.test(message)) {
    return "This conversation is too large for a side question with the selected model.";
  }
  if (/auth|credential|api key|sign.?in|401|403/i.test(message)) {
    return "The selected model connection needs attention before it can answer a side question.";
  }
  return "The selected model couldn't answer this side question.";
}

export class BtwService {
  private readonly threads = new Map<string, EphemeralThread>();

  constructor(private readonly deps: BtwServiceDependencies) {}

  private thread(chatId: string, binding: string): EphemeralThread {
    const existing = this.threads.get(chatId);
    if (existing?.fingerprint === binding) return existing;
    const created: EphemeralThread = { fingerprint: binding, history: [] };
    this.threads.set(chatId, created);
    return created;
  }

  async start(chatIdValue: unknown, questionValue: unknown, owner: BtwOwner): Promise<BtwStartReceiptV1> {
    if (typeof chatIdValue !== "string" || !/^[a-zA-Z0-9._:-]{1,200}$/u.test(chatIdValue)) {
      throw new Error("Invalid chat for side question.");
    }
    if (owner.isDestroyed()) throw new Error("The renderer document is no longer active.");
    const question = boundedQuestion(questionValue);
    const chat = await this.deps.getChat(chatIdValue);
    if (!chat) throw new Error("This chat is no longer available.");
    if (chat.botId || chat.workspaceId === ASSISTANT_WORKSPACE_ID) {
      throw new Error("Side questions are currently available only in ordinary desktop chats.");
    }
    const binding = fingerprint(chat);
    if (!binding || !chat.providerId || !chat.model) {
      throw new Error("Choose a provider and model before asking a side question.");
    }
    const requestId = `btw_${randomUUID()}`;
    const controller = new AbortController();
    const release = this.deps.registry.reserve(chat.id, requestId, owner.documentId, controller);
    if (!release) {
      throw new Error(
        this.deps.registry.has(chat.id)
          ? "Finish or close the current side question first."
          : "Two side questions are already running. Wait for one to finish.",
      );
    }
    if (this.deps.isChatBusy(chat.id)) {
      release();
      throw new Error("Finish the current response before asking a side question.");
    }
    const removeInvalidation = owner.onInvalidated(() => controller.abort());
    const thread = this.thread(chat.id, binding);
    const receipt = { version: 1 as const, chatId: chat.id, requestId };
    setTimeout(() => {
      void this.run({ chat, binding, question, requestId, owner, controller, thread })
        .finally(() => {
          removeInvalidation();
          release();
        });
    }, 0).unref?.();
    return receipt;
  }

  private async run(input: {
    chat: Chat;
    binding: string;
    question: string;
    requestId: string;
    owner: BtwOwner;
    controller: AbortController;
    thread: EphemeralThread;
  }): Promise<void> {
    let sequence = 0;
    let contextTrimmed = false;
    const publish = (event: BtwEventBody) => {
      if (
        input.owner.isDestroyed() ||
        !this.deps.registry.isCurrent(input.chat.id, input.requestId)
      ) return;
      try {
        input.owner.send("chats:btw-event", {
          version: 1,
          chatId: input.chat.id,
          requestId: input.requestId,
          sequence: sequence++,
          ...event,
        } as BtwEventV1);
      } catch {
        input.controller.abort();
      }
    };
    const timeout = setTimeout(
      () => input.controller.abort(new Error("Side question timed out.")),
      BTW_LIMITS.timeoutMs,
    );
    timeout.unref?.();
    let runtime: ResolvedModelRuntime | undefined;
    try {
      runtime = await this.deps.resolveRuntime(
        input.chat.providerId!,
        input.chat.model!,
        input.controller.signal,
      );
      input.controller.signal.throwIfAborted();
      const latest = await this.deps.getChat(input.chat.id);
      if (!latest || fingerprint(latest) !== input.binding) {
        throw new Error("The selected model changed before the side question started.");
      }
      const branch = completedVisibleContext(latest, runtime.model);
      if (branch.length === 0) {
        throw new Error("Complete one assistant response before asking a side question.");
      }
      publish({
        type: "started",
        question: input.question,
        hasHistory: input.thread.history.length > 0,
        contextTrimmed: false,
      });

      let response: AssistantMessage | undefined;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const built = buildBtwContext({
          branch,
          history: input.thread.history,
          question: input.question,
          model: runtime.model,
          retry: attempt === 2,
        });
        contextTrimmed ||= built.trimmed;
        let streamed = "";
        try {
          const stream = runtime.streams.streamSimple(
            runtime.model,
            { systemPrompt: BTW_SYSTEM_PROMPT, messages: built.messages, tools: [] },
            {
              apiKey: runtime.apiKey,
              headers: runtime.headers,
              signal: input.controller.signal,
              maxTokens: Math.min(4_096, runtime.model.maxTokens),
              maxRetries: 0,
              timeoutMs: BTW_LIMITS.timeoutMs,
              cacheRetention: "none",
            },
          );
          for await (const event of stream) {
            input.controller.signal.throwIfAborted();
            if (event.type !== "text_delta" || !event.delta) continue;
            const remaining = BTW_LIMITS.answerCodePoints - Array.from(streamed).length;
            if (remaining <= 0) {
              input.controller.abort(new Error("Side answer exceeded its output bound."));
              throw input.controller.signal.reason;
            }
            const delta = Array.from(event.delta).slice(0, remaining).join("");
            streamed += delta;
            if (delta) publish({ type: "delta", delta });
          }
          response = await stream.result();
          await this.deps.recordUsage(assistantUsageRecord({
            message: response,
            provider: runtime.provider,
            model: runtime.model,
            source: "btw",
          }));
        } catch (error) {
          await this.deps.recordUsage(unreportedUsageRecord({
            source: "btw",
            providerId: runtime.provider.id,
            providerLabel: runtime.provider.label,
            modelId: runtime.model.id,
            modelLabel: runtime.model.name,
            local: isLocalModelProvider(runtime.provider),
            status: input.controller.signal.aborted ? "cancelled" : "failed",
          }));
          throw error;
        }
        if (attempt === 1 && isContextOverflow(response, runtime.model.contextWindow)) {
          publish({ type: "reset" });
          continue;
        }
        break;
      }
      input.controller.signal.throwIfAborted();
      if (!response || response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error("Provider side question failed.");
      }
      const answer = boundedAnswer(assistantText(response).trim());
      if (!answer) throw new Error("Provider returned no text.");
      if (this.threads.get(input.chat.id) === input.thread && input.thread.fingerprint === input.binding) {
        input.thread.history = boundedHistory([
          ...input.thread.history,
          { question: input.question, answer, timestamp: Date.now() },
        ]);
      }
      publish({ type: "terminal", status: "completed", answer, contextTrimmed });
    } catch (error) {
      publish(
        input.controller.signal.aborted
          ? { type: "terminal", status: "cancelled", contextTrimmed }
          : { type: "terminal", status: "failed", message: errorMessage(error), contextTrimmed },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  cancel(chatId: string, requestId: string, ownerDocumentId: string): boolean {
    return this.deps.registry.cancel(chatId, requestId, ownerDocumentId);
  }

  clear(chatId: string): void {
    this.deps.registry.cancel(chatId);
    this.threads.delete(chatId);
  }

  async forget(chatId: string): Promise<void> {
    await this.deps.registry.cancelAndSettle(chatId, BTW_LIMITS.lifecycleSettleGraceMs);
    this.threads.delete(chatId);
  }

  shutdown(): void {
    this.deps.registry.abortAll();
    this.threads.clear();
  }
}
