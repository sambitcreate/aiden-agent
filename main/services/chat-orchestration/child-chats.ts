// What a lead chat can do with the chats it starts (docs/plans/proactive-aiden-plan.md,
// Phase 5, D3): start them in its own workspace, send to them, wait for them,
// read them, list them and stop them. Every turn goes through the same Remote
// chat and stream services a paired phone uses, under the internal audience
// `chat:<leadChatId>`, so workspace permissions, model resolution, spending
// limits and idempotency behave as they do there. No count caps: depth 1 is
// the limit (a started chat never gets `child_chats`), and Ask mode asks
// before each start.
//
// Replies and messages from started chats are fenced as data. A lead reaches
// only the chats it started, and once the person writes in one after the
// lead's last message, `send` refuses: that chat is theirs now.

import { createHash } from "node:crypto";
import { fenceAsData } from "../../../renderer/shared/agent-notices.js";
import { CHILD_CHATS_LIMITS, type ChildChatsSendMode } from "../../../renderer/shared/child-chats.js";
import type { AidenRemoteChatService } from "../aiden-remote-chats.js";
import type { AidenRemoteStreamService } from "../aiden-remote-streams.js";
import type { ApprovalCeiling } from "../approval-gate/run-approval.js";
import { chatAudience } from "./audience.js";
import type { ChatLink, ChatLinkRunEnd, ChatLinkStore } from "./links.js";
import { checkResult, compileResultSchema } from "./result-schema.js";
import { CHAT_RUN_TERMINAL_STATES, ChatRunCore, projectRunMessage, type ChatRunSnapshot } from "./run-core.js";

export interface ChildChatServices {
  chats: Pick<
    AidenRemoteChatService,
    "create" | "rename" | "remove" | "startTurn" | "runMutation" | "classify" | "messagesWindow" | "moveToNewWorktree"
  >;
  streams: Pick<
    AidenRemoteStreamService,
    "status" | "pendingApproval" | "pendingQuestion" | "watch" | "cancel" | "submitInput"
  >;
}

export interface ChildChatLead {
  /** The lead's workspace: started chats run in the same one. */
  workspaceId: string;
  /** The lead's title, named in each started chat's first message. */
  title: string;
  /** The lead's approval policy now: the most its started chats may do. */
  ceiling: ApprovalCeiling;
}

export interface ChildChatsDependencies {
  services(): Promise<ChildChatServices>;
  links: Pick<ChatLinkStore, "restore" | "get" | "byKey" | "childrenOf" | "add" | "update">;
  lead(leadChatId: string): Promise<ChildChatLead>;
  /** Where the person answers a started chat's approval, for example "Aiden on Studio". */
  answerIn(): Promise<string>;
  /** A turn the lead started in a chat ended (not an approval or question wait: those never end a turn). */
  onRunEnded?(event: ChildChatRunEnded): void;
  /** Removes a managed worktree a failed start made, after its chat is gone. */
  discardWorktree?(workspaceId: string): Promise<void>;
  /** The lead's started chats changed (a start, a new turn, a stop, an end), for the desktop's chip. */
  onChanged?(leadChatId: string): void;
  now?(): number;
}

export interface ChildChatRunEnded {
  leadChatId: string;
  chatId: string;
  runId: string;
  end: ChatLinkRunEnd;
}

/** How a finished stream reads to the lead. */
export function childRunEnd(state: ChatRunSnapshot["state"] | string): ChatLinkRunEnd | undefined {
  switch (state) {
    case "done":
      return "done";
    case "cancelled":
      return "stopped";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return undefined;
  }
}

export class ChildChatRefusal extends Error {}

export interface ChildChatStartRequest {
  title: string;
  task: string;
  model?: string;
  /** Run in a new worktree of the lead's workspace (or, for a lead in a worktree, stacked on its branch). */
  workspace?: "same" | "new_worktree";
  baseRef?: string;
  branchName?: string;
  /** A JSON Schema the chat's result must match; the chat hands it back with `submit_result`. */
  resultSchema?: Record<string, unknown>;
}

export type ChildChatStartOutcome =
  | { chatId: string; title: string; runId: string; state: "running"; branch?: string }
  | { title: string; error: string };

export type ChildChatView = {
  chatId: string;
  title: string;
  /** Idle when the lead has not started a turn there or it was forgotten. */
  state: ChatRunSnapshot["state"] | "idle";
  runId?: string;
  /** The person wrote in it after the lead's last message. */
  tookOver?: true;
  /** Waiting for the person: where to answer. */
  answerIn?: string;
  approval?: { toolName: string; summary: string };
  outcome?: "completed" | "stopped";
  reason?: "interrupted" | "error";
  /** The chat's last reply, fenced as data. */
  reply?: string;
  /** The newest result the chat submitted that matched its schema. */
  result?: unknown;
  /** The branch of its new worktree, when it runs in one. */
  branch?: string;
};

const ENDED: ReadonlySet<ChatRunSnapshot["state"]> = new Set(["done", "failed"]);

/** Whether the person wrote in a started chat after the lead's last message. */
export function personTookOver(link: Pick<ChatLink, "tookOverAt" | "leadSentAt">): boolean {
  return link.tookOverAt !== undefined && link.tookOverAt > (link.leadSentAt ?? 0);
}

/**
 * A short, fixed-alphabet digest of a lead and one of its tool calls. Call ids
 * come from providers (a Responses-API id is `call_id|item_id`) and lead ids
 * may be long, so neither goes into a key as is: every key stays well inside
 * the link store's and Remote's idempotency-key formats (128 printable ASCII).
 */
function callDigest(leadChatId: string, callKey: string): string {
  return createHash("sha256").update(`${leadChatId}\u0000${callKey}`).digest("hex").slice(0, 32);
}

/** The key a lead's start of one chat uses; a replay of the same call finds the same chat. */
export function childChatKey(leadChatId: string, callKey: string, index: number): string {
  return `agent-chat:${callDigest(leadChatId, callKey)}:${index}`;
}

export class ChildChats {
  private readonly core: ChatRunCore;
  private readonly now: () => number;
  private readonly followed = new Set<string>();

  constructor(private readonly dependencies: ChildChatsDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.core = new ChatRunCore({
      answerIn: () => dependencies.answerIn(),
      untrackedRun: () => new ChildChatRefusal("Aiden no longer tracks that turn. Read the chat for its result."),
    });
  }

  /**
   * Starts each chat in the lead's workspace with its task as the first
   * message. `callKey` (the tool call's id) makes a replay of the same call
   * find the chats it started instead of starting more.
   */
  async start(leadChatId: string, callKey: string, requests: readonly ChildChatStartRequest[]): Promise<ChildChatStartOutcome[]> {
    await this.dependencies.links.restore();
    // A schema that can't be used refuses the whole call before anything is made.
    for (const request of requests) {
      if (request.resultSchema === undefined) continue;
      const compiled = compileResultSchema(request.resultSchema);
      if (!compiled.ok) throw new ChildChatRefusal(`“${request.title}”: ${compiled.error}`);
    }
    const services = await this.dependencies.services();
    const audience = chatAudience(leadChatId);
    const lead = await this.dependencies.lead(leadChatId);
    const outcomes: ChildChatStartOutcome[] = [];
    for (const [index, request] of requests.entries()) {
      const key = childChatKey(leadChatId, callKey, index);
      const title = request.title.trim().slice(0, CHILD_CHATS_LIMITS.titleChars) || "Started chat";
      try {
        let link = this.dependencies.links.byKey(leadChatId, key);
        if (!link) link = await this.create(services, audience, lead, leadChatId, key, title, request);
        const runId =
          link.runId ?? (await this.startTurn(services, link, `${key}:turn`, firstMessage(lead.title, request.task, link.resultSchema)));
        outcomes.push({ chatId: link.childChatId, title: link.title, runId, state: "running", ...(link.branch ? { branch: link.branch } : {}) });
      } catch (error) {
        outcomes.push({ title, error: errorText(error) });
      }
    }
    return outcomes;
  }

  /**
   * Makes one started chat (and its worktree) and links it to the lead. If a
   * step fails before the link is saved, what was made is removed again, so a
   * failed start leaves no chat or worktree behind.
   */
  private async create(
    services: ChildChatServices,
    audience: string,
    lead: ChildChatLead,
    leadChatId: string,
    key: string,
    title: string,
    request: ChildChatStartRequest,
  ): Promise<ChatLink> {
    const created = await services.chats.create(audience, key, {
      workspaceId: lead.workspaceId,
      ...(request.model ? { modelId: request.model } : {}),
    });
    let revision = created.revision;
    let worktreeId: string | undefined;
    try {
      let branch: string | undefined;
      if (request.workspace === "new_worktree") {
        // Keyed like the chat, so a replay finds the worktree instead of making another.
        // The branch is named from the title: the task can be far longer than a phone's first message.
        const moved = await services.chats.moveToNewWorktree(audience, created.id, revision, `${key}:worktree`, { text: title }, {
          key: `${key}:worktree`,
          stackOnWorktree: true,
          ...(request.baseRef ? { baseRef: request.baseRef } : {}),
          ...(request.branchName ? { branchName: request.branchName } : {}),
        });
        revision = moved.chat.revision;
        worktreeId = moved.chat.workspaceId ?? undefined;
        branch = moved.branch;
      }
      const renamed = await services.chats.rename(created.id, revision, { title }).catch(() => undefined);
      if (renamed) revision = renamed.revision;
      return await this.dependencies.links.add({
        childChatId: created.id,
        leadChatId,
        key,
        title,
        createdAt: this.now(),
        ceiling: lead.ceiling,
        ...(branch ? { branch } : {}),
        ...(request.resultSchema ? { resultSchema: request.resultSchema } : {}),
      });
    } catch (error) {
      await services.chats.remove(created.id, revision).catch(() => undefined);
      if (worktreeId && worktreeId !== lead.workspaceId) await this.dependencies.discardWorktree?.(worktreeId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Sends to a started chat. A running turn takes it as steering (`auto`,
   * `steer`) or after the turn ends (`queue`); an idle chat starts a new turn.
   */
  async send(
    leadChatId: string,
    callKey: string,
    input: { chatId: string; text: string; mode: ChildChatsSendMode },
  ): Promise<{ chatId: string; runId: string; delivered: "new_turn" | "steered" | "queued" }> {
    const link = await this.owned(leadChatId, input.chatId);
    if (personTookOver(link)) {
      throw new ChildChatRefusal(
        `The person has written in “${link.title}” since your last message, so it is theirs now. Read it, or ask the person before sending more.`,
      );
    }
    const services = await this.dependencies.services();
    const audience = chatAudience(leadChatId);
    const key = `agent-chat:${callDigest(leadChatId, callKey)}:send`;
    if (link.runId && this.live(services, audience, link.runId)) {
      // A chat owing a structured result finishes its turn first: steering could cut it short.
      const mode = input.mode === "queue" || link.resultSchema ? "queue" : "steer";
      const admitted = await services.streams.submitInput(audience, link.runId, { mode, text: input.text }, key, (_chatId, action) => action());
      if (admitted.status === "admitted") {
        await this.dependencies.links.update(link.childChatId, (draft) => {
          draft.leadSentAt = this.now();
        });
        return { chatId: link.childChatId, runId: link.runId, delivered: mode === "queue" ? "queued" : "steered" };
      }
      if (admitted.reason !== "run_not_active") {
        throw new ChildChatRefusal(`“${link.title}” could not take that message now (${admitted.reason ?? "rejected"}). Wait for it, then send again.`);
      }
    }
    const runId = await this.startTurn(services, link, `${key}:turn`, input.text);
    return { chatId: link.childChatId, runId, delivered: "new_turn" };
  }

  /**
   * Waits up to `timeoutMs` for the named chats' turns to end (`any` or
   * `all`). A chat waiting for the person's approval or answer keeps waiting;
   * a timeout never stops anything. Ended turns count as told, so their
   * completion notice does not repeat it.
   */
  async wait(
    leadChatId: string,
    input: { chatIds: readonly string[]; timeoutMs: number; until: "any" | "all" },
    signal: AbortSignal,
  ): Promise<ChildChatView[]> {
    const links = await Promise.all(input.chatIds.map((chatId) => this.owned(leadChatId, chatId)));
    const services = await this.dependencies.services();
    const audience = chatAudience(leadChatId);
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop.abort(), Math.max(0, input.timeoutMs));
    try {
      const ended = await Promise.all(
        links.map(async (link) => {
          if (!link.runId) return;
          const snapshot = await this.untilEnded(services, audience, link, stop.signal).catch(() => undefined);
          if (snapshot && ENDED.has(snapshot.state) && input.until === "any") stop.abort();
        }),
      );
      void ended;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
    const views = await Promise.all(links.map((link) => this.view(services, audience, link)));
    for (const view of views) {
      if (view.runId && (view.state === "done" || view.state === "failed")) await this.markTold(view.chatId, view.runId);
    }
    return views;
  }

  /** The chat's newest messages, oldest first, each fenced as data. */
  async read(leadChatId: string, input: { chatId: string; limit: number }): Promise<{ chatId: string; title: string; messages: string[] }> {
    const link = await this.owned(leadChatId, input.chatId);
    const services = await this.dependencies.services();
    const window = await services.chats.messagesWindow(link.childChatId, { limit: input.limit });
    const messages = window.messages.map((message) => {
      const projected = projectRunMessage(message);
      const label = `${projected.role} message in “${link.title}” at ${projected.createdAt}${projected.truncated ? " (cut)" : ""}`;
      return fenceAsData(label, projected.text);
    });
    return { chatId: link.childChatId, title: link.title, messages };
  }

  async list(leadChatId: string): Promise<ChildChatView[]> {
    await this.dependencies.links.restore();
    const links = this.dependencies.links.childrenOf(leadChatId);
    if (links.length === 0) return [];
    const services = await this.dependencies.services();
    const audience = chatAudience(leadChatId);
    return Promise.all(links.map((link) => this.view(services, audience, link, false)));
  }

  /** Stops the lead's running turn in a started chat. A turn the person started there is theirs. */
  async stop(leadChatId: string, chatId: string): Promise<{ chatId: string; stopped: boolean }> {
    const link = await this.owned(leadChatId, chatId);
    if (!link.runId) return { chatId, stopped: false };
    const services = await this.dependencies.services();
    const audience = chatAudience(leadChatId);
    if (!this.live(services, audience, link.runId)) return { chatId, stopped: false };
    const runId = link.runId;
    const classification = await services.chats.classify(link.childChatId);
    await services.chats.runMutation(audience, link.childChatId, classification, () =>
      Promise.resolve(services.streams.cancel(audience, runId, `agent-chat-stop:${runId}`)),
    );
    // The lead stopped it, so its end is no news to the lead. Only once the stop went through:
    // a failed stop leaves the turn running, and its real end must still be told.
    await this.markTold(link.childChatId, runId);
    return { chatId, stopped: true };
  }

  /**
   * Stops every lead turn still running in its started chats, except chats the
   * person took over. For the lead's Stop.
   */
  async stopAll(leadChatId: string): Promise<string[]> {
    await this.dependencies.links.restore();
    const stopped: string[] = [];
    for (const link of this.dependencies.links.childrenOf(leadChatId)) {
      if (personTookOver(link)) continue;
      const outcome = await this.stop(leadChatId, link.childChatId).catch(() => ({ chatId: link.childChatId, stopped: false }));
      if (outcome.stopped) stopped.push(link.childChatId);
    }
    return stopped;
  }

  /**
   * A started chat hands back its result. It must match the schema its lead
   * gave; the newest accepted result replaces any earlier one.
   */
  async submitResult(chatId: string, value: unknown): Promise<{ accepted: true }> {
    await this.dependencies.links.restore();
    const link = this.dependencies.links.get(chatId);
    if (!link?.resultSchema) throw new ChildChatRefusal("This chat has no result to submit: the chat that started it didn't ask for one.");
    const checked = checkResult(link.resultSchema, value);
    if (!checked.ok) throw new ChildChatRefusal(checked.error);
    await this.dependencies.links.update(chatId, (draft) => {
      draft.result = { value: structuredClone(value), at: this.now() };
    });
    return { accepted: true };
  }

  private async owned(leadChatId: string, chatId: string): Promise<ChatLink> {
    await this.dependencies.links.restore();
    const link = this.dependencies.links.get(chatId);
    if (!link || link.leadChatId !== leadChatId) {
      throw new ChildChatRefusal("You can only reach chats this chat started. Use list to see them.");
    }
    return link;
  }

  private live(services: ChildChatServices, audience: string, runId: string): boolean {
    try {
      return !CHAT_RUN_TERMINAL_STATES.has(services.streams.status(audience, runId).state);
    } catch {
      return false;
    }
  }

  private async startTurn(services: ChildChatServices, link: ChatLink, key: string, text: string): Promise<string> {
    const audience = chatAudience(link.leadChatId);
    const classification = await services.chats.classify(link.childChatId);
    const turn = await services.chats.runMutation(audience, link.childChatId, classification, () =>
      services.chats.startTurn(audience, link.childChatId, key, { text }),
    );
    this.core.track(audience, turn.streamId);
    await this.dependencies.links.update(link.childChatId, (draft) => {
      draft.runId = turn.streamId;
      draft.leadSentAt = this.now();
    });
    this.follow(services, link, turn.streamId);
    this.dependencies.onChanged?.(link.leadChatId);
    return turn.streamId;
  }

  /** Tells `onRunEnded` once the run ends. In memory: nothing resumes after a quit. */
  private follow(services: ChildChatServices, link: ChatLink, runId: string): void {
    const onRunEnded = this.dependencies.onRunEnded ?? (() => undefined);
    if (this.followed.has(runId)) return;
    this.followed.add(runId);
    const audience = chatAudience(link.leadChatId);
    let detach: (() => void) | undefined;
    let done = false;
    let waiting: boolean | undefined;
    const look = () => {
      if (done) return;
      let state: string;
      try {
        state = services.streams.status(audience, runId).state;
      } catch {
        // The stream is gone without an end we saw: nothing to report.
        finish();
        return;
      }
      const end = childRunEnd(state);
      if (!end) {
        // Moving to or from "needs you" (an approval or a question) changes the desktop's chip.
        const now =
          state === "waiting_for_approval" ||
          Boolean(services.streams.pendingApproval(audience, runId)) ||
          Boolean(services.streams.pendingQuestion(audience, runId));
        if (waiting !== undefined && now !== waiting) this.dependencies.onChanged?.(link.leadChatId);
        waiting = now;
        return;
      }
      finish();
      onRunEnded({ leadChatId: link.leadChatId, chatId: link.childChatId, runId, end });
      this.dependencies.onChanged?.(link.leadChatId);
    };
    const finish = () => {
      done = true;
      this.followed.delete(runId);
      detach?.();
    };
    try {
      detach = services.streams.watch(audience, runId, { onChange: look, onClose: look });
    } catch {
      finish();
      return;
    }
    if (done) detach();
    look();
  }

  /** Resolves once the run has ended, its stream closed, or `signal` aborted. */
  private async untilEnded(
    services: ChildChatServices,
    audience: string,
    link: ChatLink,
    signal: AbortSignal,
  ): Promise<ChatRunSnapshot | undefined> {
    const runId = link.runId!;
    const read = () => this.core.snapshot(services, audience, link.childChatId, runId);
    const first = await read();
    if (ENDED.has(first.state) || signal.aborted) return first;
    return new Promise<ChatRunSnapshot | undefined>((resolve) => {
      let detach: (() => void) | undefined;
      let settled = false;
      const finish = (snapshot: ChatRunSnapshot | undefined) => {
        if (settled) return;
        settled = true;
        detach?.();
        signal.removeEventListener("abort", onAbort);
        resolve(snapshot);
      };
      const onAbort = () => finish(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      const look = () => {
        void read().then(
          (snapshot) => {
            if (ENDED.has(snapshot.state)) finish(snapshot);
          },
          () => finish(undefined),
        );
      };
      try {
        detach = services.streams.watch(audience, runId, { onChange: look, onClose: () => look() });
      } catch {
        finish(undefined);
        return;
      }
      // The run may have changed before the watch attached.
      look();
    });
  }

  private async view(services: ChildChatServices, audience: string, link: ChatLink, withReply = true): Promise<ChildChatView> {
    const base = {
      chatId: link.childChatId,
      title: link.title,
      ...(personTookOver(link) ? { tookOver: true as const } : {}),
      ...(link.branch ? { branch: link.branch } : {}),
    };
    if (!link.runId) return { ...base, state: "idle", ...(link.result ? { result: link.result.value } : {}) };
    let snapshot: ChatRunSnapshot;
    try {
      snapshot = await this.core.snapshot(services, audience, link.childChatId, link.runId, { withReply });
    } catch {
      return { ...base, state: "idle" };
    }
    const view: ChildChatView = { ...base, state: snapshot.state, runId: link.runId };
    if (snapshot.state === "waiting_for_input") view.answerIn = snapshot.answerIn;
    if (snapshot.state === "waiting_for_approval") {
      view.answerIn = snapshot.approveIn;
      if (snapshot.approval) view.approval = { toolName: snapshot.approval.toolName, summary: snapshot.approval.summary };
    }
    if (snapshot.state === "done") {
      view.outcome = snapshot.outcome;
      if (withReply && snapshot.reply) view.reply = fenceAsData(`Last reply in “${link.title}”`, snapshot.reply.text);
    }
    if (snapshot.state === "failed") view.reason = snapshot.reason;
    if (link.result) view.result = link.result.value;
    return view;
  }

  private async markTold(chatId: string, runId: string): Promise<void> {
    await this.dependencies.links
      .update(chatId, (draft) => {
        if (!draft.delivered?.includes(runId)) draft.delivered = [...(draft.delivered ?? []), runId];
        if (draft.owed?.runId === runId) delete draft.owed;
      })
      .catch(() => undefined);
  }
}

function firstMessage(leadTitle: string, task: string, resultSchema?: Record<string, unknown>): string {
  const ask = resultSchema
    ? `Do this task, then call submit_result with your result as JSON matching this schema (call it again to replace it), and end with a short summary.\n\nSchema:\n\`\`\`json\n${JSON.stringify(resultSchema, null, 2)}\n\`\`\``
    : "Do this task, then end with a short summary of the result.";
  return `The chat “${leadTitle}” started this chat and will read your last reply. ${ask}\n\n${task}`;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Aiden could not start that chat.";
}
