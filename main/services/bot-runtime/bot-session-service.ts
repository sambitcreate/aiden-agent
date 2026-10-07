// The Bot turn path: every ingress (desktop, Remote, Telegram, routines)
// reaches a Bot's one durable conversation through this service.
//
// - `send` admits input with the caller's stable `requestId`; a repeat of the
//   same request returns the original submission (`deduped: true`). Sending
//   while the Bot is interrupted dismisses the paused turn first.
// - `resume` and `dismiss` are explicit user actions on an interrupted turn.
//   Both are idempotent: a second call, from any client, returns the current
//   state and makes no provider request.
// - Nothing here resumes a harness on its own. The startup scan only records
//   which Bots are interrupted.
// - `deleteBot` aborts the live run and erases the Bot's session before the
//   caller-supplied cleanup steps run.

import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, ImageContent, Models, TextContent } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  HarnessInspection,
  HarnessSettings,
  ModelRef,
  SubmissionId,
  SubmissionRecord,
  UserInput,
} from "@earendil-works/pi-durable";
import {
  createBotRegistry,
  type BotExtensionDeps,
  type BotReadmission,
  type BotRegistry,
} from "./bot-extension.js";
import {
  createBotHarnessHost,
  isBotHarnessHostUnavailable,
  type BotHarnessHost,
} from "./harness-host.js";

export const BOT_NOTICE_ENTRY_KIND = "aiden.bot-notice";
export const BOTS_HELD_ELSEWHERE_MESSAGE = "Bots are open in another Aiden window.";

export type BotSessionState =
  | { kind: "idle" }
  | { kind: "running"; submissionId: string }
  | { kind: "interrupted"; submissionId: string; blocked?: "access_changed" | "bot_missing" }
  /** The Bot has no AI model configured. */
  | { kind: "needs_model" }
  /** The Bot has a model, but it cannot be used right now (sign-in, missing provider, access). */
  | { kind: "model_error"; message: string }
  | { kind: "unavailable"; reason: "held_by_live_process" };

/** A transcript notice entry; `data` of `aiden.bot-notice`. */
export type BotNotice =
  | { notice: "interrupted"; submissionId: string }
  | { notice: "session_reset"; movedTo: string }
  /** Precedes a routine's input: the turn is labelled with the routine name. */
  | { notice: "routine"; label: string; requestId: string }
  /** The answer to this submission was `[SILENT]`: kept, but no bubble, preview or unread. */
  | { notice: "silent"; submissionId: string }
  /** Precedes an input the person never typed (the self-intro prompt): the input is not shown. */
  | { notice: "hidden_input"; requestId: string };

export type BotReplyOutcome =
  | { kind: "completed"; text: string }
  | { kind: "failed"; error: string }
  | { kind: "interrupted" };

export interface BotInputAttachment {
  type: "image";
  mimeType: string;
  /** Base64 bytes. */
  data: string;
}

export interface BotSendInput {
  text: string;
  attachments?: readonly BotInputAttachment[];
  requestId: string;
  whenBusy?: "steer" | "followUp";
  /**
   * Unattended senders (routines) set this: an interrupted Bot belongs to the
   * person, so the send is refused with `bot_paused` instead of dismissing the
   * paused turn first.
   */
  ifNotInterrupted?: boolean;
  /** Label shown on the turn, such as the routine name. */
  label?: string;
  /** An Aiden-written prompt (the self-intro): its reply shows, the prompt does not. */
  hidden?: boolean;
}

export type BotSessionErrorReason =
  | "needs_model"
  | "model_error"
  | "unavailable"
  | "access_changed"
  | "bot_missing"
  | "bot_deleted"
  | "bot_paused";

export class BotSessionError extends Error {
  constructor(readonly reason: BotSessionErrorReason, message?: string) {
    super(message ?? defaultMessage(reason));
    this.name = "BotSessionError";
  }
}

function defaultMessage(reason: BotSessionErrorReason): string {
  switch (reason) {
    case "needs_model":
      return "This Bot needs an AI model.";
    case "model_error":
      return "This Bot's AI model is not available right now.";
    case "unavailable":
      return BOTS_HELD_ELSEWHERE_MESSAGE;
    case "access_changed":
      return "This Bot's access changed. Review it in Advanced.";
    case "bot_missing":
    case "bot_deleted":
      return "This Bot no longer exists.";
    case "bot_paused":
      return "I got interrupted while working on this.";
  }
}

export interface BotSessionService {
  send(botId: string, input: BotSendInput): Promise<{ submissionId: string; deduped: boolean }>;
  resume(botId: string, requestId: string): Promise<BotSessionState>;
  dismiss(botId: string, requestId: string): Promise<BotSessionState>;
  /**
   * Stop the reply that is running now (the composer's Stop). What was already
   * written stays in the transcript and queued follow-ups are withdrawn. A
   * paused (interrupted) turn is left for Resume or Dismiss.
   */
  stop(botId: string): Promise<BotSessionState>;
  state(botId: string): Promise<BotSessionState>;
  deleteBot(botId: string): Promise<void>;
  /**
   * Wait for a submission's answer. Never starts a paused Bot: a turn that is
   * interrupted (or becomes so when the app quits) reports `interrupted`.
   * Aborting `signal` stops waiting only.
   */
  awaitReply(botId: string, submissionId: string, signal: AbortSignal): Promise<BotReplyOutcome>;
  /** Keep the submission's answer for audit but hide it from the chat, preview and unread. */
  markSilent(botId: string, submissionId: string): Promise<void>;
}

export interface BotSessionRuntime extends BotSessionService {
  /** Startup: remove orphaned Bot sessions and record interrupted Bots. Never resumes. */
  initialize(): Promise<{ removedOrphans: string[]; interrupted: string[] }>;
  /** The Bot's conversation, opened lazily (for live projection). */
  conversation(botId: string): Promise<Conversation>;
  shutdown(): Promise<void>;
}

export interface BotSessionServiceDeps {
  profileDir: string;
  /** pi-ai model access, per Bot so a Bot's provider binding stays exact. */
  models: Models;
  extension: BotExtensionDeps;
  /**
   * The Bot's current model, or `null` when it has no model configured. Any
   * other failure throws; its message is shown as a `model_error`.
   */
  resolveModel(botId: string): Promise<ModelRef | null>;
  /** Every Bot record that exists. Sessions of other ids are orphans. */
  knownBotIds(): Promise<ReadonlySet<string>>;
  /**
   * Erase everything else a Bot owns, in order (routines, dismissals,
   * Telegram binding, then photo, home, access, chat rows and finally the Bot
   * record). Runs after the session is aborted and removed. Each effect must
   * be idempotent: a failed or interrupted delete is retried from the start.
   */
  deleteEffects?: ReadonlyArray<(botId: string) => Promise<void>>;
  settings?: HarnessSettings;
  idleCloseMs?: number;
  now?: () => number;
  onStateChange?(botId: string, state: BotSessionState): void;
  onReport?(botId: string, error: unknown): void;
}

const ctx = BACKGROUND_CONTEXT;
const REQUEST_MEMORY = 1_000;

function userContent(input: BotSendInput): UserInput {
  if (input.attachments === undefined || input.attachments.length === 0) return input.text;
  const parts: Array<TextContent | ImageContent> = [];
  if (input.text.length > 0) parts.push({ type: "text", text: input.text });
  for (const attachment of input.attachments) {
    parts.push({ type: "image", mimeType: attachment.mimeType, data: attachment.data });
  }
  return parts;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function unfinishedInput(inspection: HarnessInspection): SubmissionRecord | undefined {
  return inspection.submissions.find((submission) => submission.type === "input");
}

/** A keyed promise chain: one operation per Bot at a time. */
function createKeyedQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

export async function createBotSessionService(deps: BotSessionServiceDeps): Promise<BotSessionRuntime> {
  const registries = new Map<string, BotRegistry>();
  const hostOrUnavailable = await createBotHarnessHost({
    profileDir: deps.profileDir,
    models: deps.models,
    buildRegistry: (botId) => {
      const registry = createBotRegistry(botId, deps.extension);
      registries.set(botId, registry);
      return registry;
    },
    ...(deps.settings === undefined ? {} : { settings: deps.settings }),
    ...(deps.idleCloseMs === undefined ? {} : { idleCloseMs: deps.idleCloseMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onReport === undefined ? {} : { onReport: deps.onReport }),
  });
  const host: BotHarnessHost | null = isBotHarnessHostUnavailable(hostOrUnavailable) ? null : hostOrUnavailable;
  const serialize = createKeyedQueue();
  /** Outcomes of resume/dismiss requests, so a retried request replays its answer. */
  const answered = new Map<string, BotSessionState>();
  /** Interrupted turns whose Resume was refused because the Bot's access changed. */
  const blocked = new Map<string, "access_changed" | "bot_missing">();
  const deleted = new Set<string>();

  function requireHost(): BotHarnessHost {
    if (host === null) throw new BotSessionError("unavailable");
    return host;
  }

  function remember(key: string, state: BotSessionState): BotSessionState {
    answered.set(key, state);
    if (answered.size > REQUEST_MEMORY) answered.delete(answered.keys().next().value!);
    return state;
  }

  function publish(botId: string, state: BotSessionState): BotSessionState {
    deps.onStateChange?.(botId, state);
    return state;
  }

  async function openBot(botId: string): Promise<{ conversation: Conversation; registry: BotRegistry }> {
    if (deleted.has(botId)) throw new BotSessionError("bot_deleted");
    const opened = await requireHost().open(botId);
    if (opened.recoveredCorruptFile !== undefined) {
      await writeNotice(opened.conversation, { notice: "session_reset", movedTo: opened.recoveredCorruptFile });
    }
    const registry = registries.get(botId);
    if (registry === undefined) throw new Error(`Bot ${botId} has no registry`);
    return { conversation: opened.conversation, registry };
  }

  async function writeNotice(conversation: Conversation, notice: BotNotice): Promise<void> {
    await conversation.submit({ type: "write", entry: { kind: BOT_NOTICE_ENTRY_KIND, data: notice } }, ctx);
  }

  /** Current state without taking the per-Bot queue. */
  async function currentState(botId: string): Promise<BotSessionState> {
    if (host === null) return { kind: "unavailable", reason: "held_by_live_process" };
    if (deleted.has(botId)) return { kind: "idle" };
    if (host.isOpen(botId)) {
      const inspection = await host.inspect(botId);
      const unfinished = unfinishedInput(inspection);
      if (unfinished !== undefined) {
        const submissionId = String(unfinished.id);
        if (inspection.scheduling === "paused") {
          const reason = blocked.get(botId);
          return { kind: "interrupted", submissionId, ...(reason === undefined ? {} : { blocked: reason }) };
        }
        return { kind: "running", submissionId };
      }
    }
    const model = await modelFor(botId);
    if (model.kind === "none") return { kind: "needs_model" };
    if (model.kind === "error") return { kind: "model_error", message: model.message };
    return { kind: "idle" };
  }

  async function modelFor(
    botId: string,
  ): Promise<{ kind: "ok"; ref: ModelRef } | { kind: "none" } | { kind: "error"; message: string }> {
    try {
      const ref = await deps.resolveModel(botId);
      return ref === null ? { kind: "none" } : { kind: "ok", ref };
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0 ? error.message : defaultMessage("model_error");
      return { kind: "error", message };
    }
  }

  /** Bind the Bot's current model and reload its extension before anything runs. */
  async function prepareToRun(
    botId: string,
    conversation: Conversation,
    registry: BotRegistry,
    requestId: string | undefined,
  ): Promise<void> {
    const resolved = await modelFor(botId);
    if (resolved.kind === "none") throw new BotSessionError("needs_model");
    if (resolved.kind === "error") throw new BotSessionError("model_error", resolved.message);
    const model = resolved.ref;
    await registry.refresh(requestId === undefined ? {} : { requestId });
    const agent = await conversation.agent(ctx);
    if (agent.model?.provider !== model.provider || agent.model?.modelId !== model.modelId) {
      await conversation.configure({ model }, ctx);
    }
  }

  /** Abort the paused turn without running it, and mark its partial answer interrupted. */
  async function dismissPaused(conversation: Conversation, submissionId: string): Promise<void> {
    await conversation.abort(ctx);
    await writeNotice(conversation, { notice: "interrupted", submissionId });
  }

  /** The request that started the paused turn, so its tools match a routine run. */
  async function pausedRequestId(botId: string): Promise<string | undefined> {
    return unfinishedInput(await requireHost().inspect(botId))?.requestId;
  }

  async function lookupRequest(conversation: Conversation, requestId: string) {
    return conversation.commit((tx) => tx.submissionByRequest(conversation.id, requestId), ctx);
  }

  const service: BotSessionRuntime = {
    async initialize() {
      if (host === null) return { removedOrphans: [], interrupted: [] };
      const removedOrphans = await host.sweepOrphans(await deps.knownBotIds());
      const interrupted = await host.interruptedBots();
      for (const { botId } of interrupted) {
        publish(botId, await currentState(botId));
      }
      return { removedOrphans, interrupted: interrupted.map(({ botId }) => botId) };
    },

    async conversation(botId) {
      return (await openBot(botId)).conversation;
    },

    state(botId) {
      return currentState(botId);
    },

    send(botId, input) {
      return serialize(botId, async () => {
        const { conversation, registry } = await openBot(botId);
        const existing = await lookupRequest(conversation, input.requestId);
        if (existing !== undefined) return { submissionId: String(existing.id), deduped: true };

        const before = await currentState(botId);
        if (before.kind === "interrupted" && input.ifNotInterrupted) throw new BotSessionError("bot_paused");
        await prepareToRun(botId, conversation, registry, input.requestId);
        if (before.kind === "interrupted") {
          await dismissPaused(conversation, before.submissionId);
          blocked.delete(botId);
        }
        if (input.label !== undefined) {
          await writeNotice(conversation, { notice: "routine", label: input.label, requestId: input.requestId });
        }
        if (input.hidden === true) {
          await writeNotice(conversation, { notice: "hidden_input", requestId: input.requestId });
        }
        const submission = await conversation.submit(
          {
            type: "input",
            content: userContent(input),
            requestId: input.requestId,
            whenBusy: input.whenBusy ?? "followUp",
          },
          ctx,
        );
        requireHost().touch(botId);
        publish(botId, await currentState(botId));
        return { submissionId: String(submission.id), deduped: false };
      });
    },

    resume(botId, requestId) {
      const key = `resume:${botId}:${requestId}`;
      return serialize(botId, async () => {
        const replay = answered.get(key);
        if (replay !== undefined) return replay;
        const before = await currentState(botId);
        if (before.kind !== "interrupted") return remember(key, before);

        const readmission: BotReadmission = await deps.extension.readmit(botId);
        if (!readmission.ok) {
          blocked.set(botId, readmission.reason);
          return remember(key, publish(botId, await currentState(botId)));
        }
        blocked.delete(botId);
        const { conversation, registry } = await openBot(botId);
        await prepareToRun(botId, conversation, registry, await pausedRequestId(botId));
        const opened = await requireHost().open(botId);
        opened.harness.resume();
        requireHost().touch(botId);
        return remember(key, publish(botId, await currentState(botId)));
      });
    },

    dismiss(botId, requestId) {
      const key = `dismiss:${botId}:${requestId}`;
      return serialize(botId, async () => {
        const replay = answered.get(key);
        if (replay !== undefined) return replay;
        const before = await currentState(botId);
        if (before.kind !== "interrupted") return remember(key, before);
        const { conversation, registry } = await openBot(botId);
        // Pending tool calls settle against the Bot's tools while aborting.
        const requestId = await pausedRequestId(botId);
        await registry.refresh(requestId === undefined ? {} : { requestId }).catch(() => undefined);
        await dismissPaused(conversation, before.submissionId);
        blocked.delete(botId);
        return remember(key, publish(botId, await currentState(botId)));
      });
    },

    stop(botId) {
      return serialize(botId, async () => {
        const before = await currentState(botId);
        if (before.kind !== "running") return before;
        const { conversation } = await openBot(botId);
        await conversation.abort(ctx);
        return publish(botId, await currentState(botId));
      });
    },

    deleteBot(botId) {
      return serialize(botId, async () => {
        // Another process holding the profile owns the session; erasing the
        // Bot's data underneath it would orphan a live harness.
        const owner = requireHost();
        deleted.add(botId);
        blocked.delete(botId);
        await owner.destroy(botId);
        registries.delete(botId);
        for (const effect of deps.deleteEffects ?? []) await effect(botId);
      });
    },

    async awaitReply(botId, submissionId, signal) {
      if (deleted.has(botId)) return { kind: "interrupted" };
      const opened = await requireHost().open(botId);
      const id = Number(submissionId) as SubmissionId;
      const submission = await opened.harness.submission(id, ctx);
      if (submission === undefined) return { kind: "failed", error: "This reply is no longer tracked." };
      // `wait()` would start a paused scheduler, which is Resume's decision.
      const inspection = await opened.harness.inspect(ctx);
      if (inspection.scheduling === "paused" && inspection.submissions.some((record) => record.id === id)) {
        return { kind: "interrupted" };
      }
      const { context, cancel } = withCancel(ctx);
      const onAbort = () => cancel(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      let settled: Awaited<ReturnType<typeof submission.wait>>;
      try {
        settled = await submission.wait(context);
      } catch (error) {
        if (signal.aborted) throw error;
        return { kind: "interrupted" };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (settled.status === "done" && settled.type === "input") {
        const answer = await opened.conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer!), ctx);
        return { kind: "completed", text: assistantText(answer?.model?.[0] as AssistantMessage | undefined) };
      }
      if (settled.reason === "aborted") return { kind: "interrupted" };
      return { kind: "failed", error: settled.reason ?? "The reply failed." };
    },

    async markSilent(botId, submissionId) {
      const { conversation } = await openBot(botId);
      await writeNotice(conversation, { notice: "silent", submissionId });
    },

    async shutdown() {
      await host?.shutdown();
    },
  };
  return service;
}
