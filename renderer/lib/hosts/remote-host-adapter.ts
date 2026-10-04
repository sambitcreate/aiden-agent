import { peerHostsApi } from "../ipc";
import type { ChatRunInputAdmissionResult } from "../../shared/chat-run-input";
import type { PeerOperation } from "../../shared/peer-operation";
import { hostAvailability } from "../sidebar-remote-groups";
import {
  mintPeerIdempotencyKey,
  type PeerHostStatus,
  type PeerOperationError,
  type PeerHostView,
  type PeerRunFrameMessage,
} from "../../shared/peer-host";
import {
  FENCED_ERROR,
  HostChatControlError,
  type HostChatAdapter,
  type HostChatApprovalInput,
  type HostChatApprovalResult,
  type HostChatAttachmentUpload,
  type HostStagedAttachment,
  type HostChatCancelInput,
  type HostChatCapability,
  type HostChatError,
  type HostChatInput,
  type HostChatQuestionInput,
  type HostChatQuestionResult,
  type HostChatRenameInput,
  type HostChatSendInput,
  type HostChatTurnReceipt,
  type HostChatObserver,
  type HostChatResult,
  type HostChatStatus,
  type HostChatWindowRequest,
} from "./host-chat-adapter";
import { mapRemoteMessagesWindow, type RemoteMessagesWindow } from "./remote-chat-mapper";
import { parseSkillCatalog, type SkillCatalogEntry } from "../../shared/slash-commands";
import {
  mapHostBrowserPage,
  mapHostBrowserRoots,
  mapHostCreatedChat,
  mapHostCreatedWorkspace,
  mapHostFolderSelection,
  mapHostModelCatalog,
  type HostBrowserPage,
  type HostBrowserRoot,
  type HostCreatedChat,
  type HostCreatedWorkspace,
  type HostFolderSelection,
  type HostModelCatalog,
  type HostNewChatInput,
  type HostWorkspaceCreate,
} from "./host-resources";

/** The slice of `peerHostsApi` a remote adapter needs; tests wire main's handlers in-process. */
export type PeerHostTransport = Pick<
  typeof peerHostsApi,
  "call" | "runSubscribe" | "runUnsubscribe" | "onRunFrame" | "statuses" | "onHostState"
>;

export const DEFAULT_WINDOW_LIMIT = 50;

/** What a paired host grants this Mac, from the features and capabilities it reported. */
export function remoteHostCapabilities(host: Pick<PeerHostView, "features" | "capabilities">): Set<HostChatCapability> {
  const features = new Set(host.features);
  const grants = new Set(host.capabilities);
  const capabilities = new Set<HostChatCapability>();
  if (features.has("chat-messages-window-v1") && grants.has("chat:read")) capabilities.add("messagesWindow");
  if (features.has("run-streams-v1") && grants.has("runs:observe")) capabilities.add("observe");
  if (features.has("chat-read-state-v1") && grants.has("chat:read")) capabilities.add("markRead");
  if (grants.has("workspace:browse")) capabilities.add("browseFolders");
  if (grants.has("workspace:manage")) capabilities.add("createWorkspace");
  if (grants.has("chat:write")) {
    capabilities.add("send");
    capabilities.add("rename");
    capabilities.add("remove");
    capabilities.add("attach");
    capabilities.add("createChat");
    // The host checks both grants on every skill read and invocation.
    if (features.has("chat-skills-v1") && grants.has("skills:invoke")) capabilities.add("skills");
    // Bot grants are bound at pairing; a Bot chat also reads the Bot and writes a chat.
    if (grants.has("bot:write") && grants.has("bot:read")) capabilities.add("botChats");
    // Run control also needs chat write access on the host.
    if (features.has("run-control-v1") && grants.has("runs:control")) {
      capabilities.add("cancel");
      capabilities.add("respondApproval");
      capabilities.add("answerQuestion");
      capabilities.add("steer");
    }
  }
  return capabilities;
}

/** Why a host refuses control right now, or null when it is online. */
export function hostControlRefusal(status: Pick<HostChatStatus, "availability" | "blockedReason">): HostChatError | null {
  switch (status.availability) {
    case "online":
      return null;
    case "connecting":
      return { code: "host_unavailable", message: "Still connecting to this Mac. Try again once it is online." };
    case "offline":
      return { code: "host_unavailable", message: "This Mac is offline. Nothing is sent until it is back online." };
    case "blocked":
      return {
        code: "host_blocked",
        message:
          status.blockedReason === "protocol"
            ? "This Mac runs an incompatible version of Aiden. Update both Macs to control it."
            : "This Mac needs to be paired again before it can be controlled.",
      };
  }
}

const OUTCOME_UNKNOWN_MESSAGE = "The connection to this Mac changed before it answered. It may or may not have applied this change.";

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function failure(error: unknown): HostChatError {
  return { code: "failed", message: error instanceof Error ? error.message : "The host request failed." };
}

/**
 * `HostChatAdapter` for a paired host, over the peer IPC. It never holds or
 * sees host credentials; main signs and sends every request.
 */
export class RemoteHostAdapter implements HostChatAdapter {
  readonly hostId: string;
  private readonly transport: PeerHostTransport;
  private readonly granted: ReadonlySet<HostChatCapability>;
  private current: HostChatStatus = { availability: "connecting", generation: -1 };
  private readonly listeners = new Set<(status: HostChatStatus) => void>();
  private readonly chatListeners = new Set<(chatId: string) => void>();
  private readonly offHostState: () => void;
  private disposed = false;
  private readonly initial: Promise<void>;

  constructor(host: PeerHostView, transport: PeerHostTransport = peerHostsApi) {
    this.hostId = host.id;
    this.transport = transport;
    this.granted = remoteHostCapabilities(host);
    this.offHostState = transport.onHostState((status) => this.acceptStatus(status));
    this.initial = transport.statuses().then(
      (statuses) => {
        const status = statuses.find((entry) => entry.hostId === this.hostId);
        if (status) this.acceptStatus(status);
      },
      () => {},
    );
  }

  ready(): Promise<void> {
    return this.initial;
  }

  capabilities(): ReadonlySet<HostChatCapability> {
    return this.granted;
  }

  status(): HostChatStatus {
    return this.current;
  }

  onStatus(listener: (status: HostChatStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onChatChanged(listener: (chatId: string) => void): () => void {
    this.chatListeners.add(listener);
    return () => this.chatListeners.delete(listener);
  }

  private chatChanged(chatId: string): void {
    if (this.disposed) return;
    for (const listener of [...this.chatListeners]) listener(chatId);
  }

  /** Runs a revision-guarded change; a stale or unknown outcome means the loaded revision may be out of date. */
  private async guarded<T>(chatId: string, change: () => Promise<T>): Promise<T> {
    try {
      return await change();
    } catch (error) {
      if (
        error instanceof HostChatControlError &&
        (error.code === "outcome_unknown" || error.remoteCode === "revision_conflict" || error.status === 409)
      )
        this.chatChanged(chatId);
      throw error;
    }
  }

  private acceptStatus(status: PeerHostStatus): void {
    // Statuses are broadcast for every host and may arrive out of order.
    if (this.disposed || status.hostId !== this.hostId || status.generation <= this.current.generation) return;
    this.current = { ...hostAvailability(status), generation: status.generation };
    for (const listener of [...this.listeners]) listener(this.current);
  }

  /** Runs a read and drops its answer when the host connection moved on meanwhile. */
  private async fenced<T>(read: () => Promise<HostChatResult<T>>): Promise<HostChatResult<T>> {
    const generation = this.current.generation;
    let result: HostChatResult<T>;
    try {
      result = await read();
    } catch (error) {
      result = { ok: false, error: failure(error) };
    }
    if (this.disposed || this.current.generation !== generation) return { ok: false, error: FENCED_ERROR };
    return result;
  }

  getMessagesWindow(chatId: string, request: HostChatWindowRequest = {}): Promise<HostChatResult<RemoteMessagesWindow>> {
    return this.fenced(async () => {
      const outcome = await this.transport.call(this.hostId, {
        operation: "messagesWindow",
        resourceId: chatId,
        ...(request.before ? { before: request.before } : {}),
        limit: request.limit ?? DEFAULT_WINDOW_LIMIT,
      });
      if (!outcome.ok) return outcome;
      const window = mapRemoteMessagesWindow(outcome.value);
      if (window.chatId !== chatId) return { ok: false, error: { code: "failed", message: "The host answered for another chat." } };
      return { ok: true, value: window };
    });
  }

  markRead(chatId: string, throughMessageId?: string): Promise<HostChatResult<void>> {
    return this.fenced(async () => {
      const outcome = await this.transport.call(this.hostId, {
        operation: "markRead",
        resourceId: chatId,
        body: throughMessageId ? { throughMessageId } : {},
        // A fresh intent each time: a later mark must not replay an earlier one.
        idempotencyKey: mintPeerIdempotencyKey(),
      });
      return outcome.ok ? { ok: true, value: undefined } : outcome;
    });
  }

  /**
   * Runs one mutation bound to this host and its current generation. It is
   * refused while the host is not online, and an answer that lands after the
   * connection changed is reported as `outcome_unknown`: the request may have
   * been applied, so only a same-key retry is safe.
   */
  private async mutate(
    capability: HostChatCapability,
    operation: PeerOperation,
    recover?: (error: PeerOperationError) => { value: unknown } | null,
  ): Promise<unknown> {
    if (this.disposed) throw new HostChatControlError(FENCED_ERROR);
    if (!this.granted.has(capability))
      throw new HostChatControlError({ code: "unsupported", message: "This Mac does not allow that from here." });
    const refusal = hostControlRefusal(this.current);
    if (refusal) throw new HostChatControlError(refusal);
    const generation = this.current.generation;
    let outcome: Awaited<ReturnType<PeerHostTransport["call"]>>;
    try {
      outcome = await this.transport.call(this.hostId, operation);
    } catch (error) {
      outcome = { ok: false, error: { code: "outcome_unknown", message: failure(error).message } };
    }
    if (this.disposed || this.current.generation !== generation) {
      throw new HostChatControlError({ code: "outcome_unknown", message: OUTCOME_UNKNOWN_MESSAGE });
    }
    if (outcome.ok) return outcome.value;
    // The host answered, but not in the expected shape: it may have applied the change.
    if (outcome.error.code === "invalid_response")
      throw new HostChatControlError({ ...outcome.error, code: "outcome_unknown", message: OUTCOME_UNKNOWN_MESSAGE });
    const recovered = recover?.(outcome.error);
    if (recovered) return recovered.value;
    throw new HostChatControlError(outcome.error);
  }

  async send(chatId: string, input: HostChatSendInput): Promise<HostChatTurnReceipt> {
    const value = record(
      await this.mutate("send", {
        operation: "send",
        resourceId: chatId,
        body: {
          text: input.text,
          ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
          ...(input.skill ? { skill: input.skill } : {}),
        },
        idempotencyKey: input.idempotencyKey,
      }),
    );
    const turnId = text(value.turnId);
    const streamId = text(value.streamId);
    if (!turnId || !streamId) throw new HostChatControlError({ code: "invalid_response", message: "The host's answer was incomplete." });
    return { turnId, streamId };
  }

  async cancel(_chatId: string, input: HostChatCancelInput): Promise<boolean> {
    const value = await this.mutate(
      "cancel",
      { operation: "runCancel", resourceId: input.runId, body: {}, idempotencyKey: input.idempotencyKey ?? mintPeerIdempotencyKey() },
      // The run already finished and the host let it go: nothing is left to stop.
      (error) => (error.remoteCode === "run_gone" ? { value: { cancelRequested: false } } : null),
    );
    return record(value).cancelRequested === true;
  }

  async respondApproval(_chatId: string, input: HostChatApprovalInput): Promise<HostChatApprovalResult> {
    if (!input.runId) throw new HostChatControlError({ code: "invalid", message: "This approval is no longer attached to a run." });
    const value = await this.mutate(
      "respondApproval",
      {
        operation: "runRespondApproval",
        resourceId: input.runId,
        itemId: input.approvalId,
        body: { decision: input.decision, ...(input.decision === "allow" && input.scope ? { scope: input.scope } : {}) },
        idempotencyKey: input.idempotencyKey ?? mintPeerIdempotencyKey(),
      },
      // First responder wins: another device or the host's own screen answered.
      (error) =>
        error.remoteCode === "approval_resolved"
          ? { value: { elsewhere: true, decision: error.details?.decision } }
          : null,
    );
    const result = record(value);
    if (result.elsewhere === true) {
      const decision = result.decision === "allow" || result.decision === "deny" ? result.decision : undefined;
      return { resolution: "elsewhere", ...(decision ? { decision } : {}) };
    }
    return { resolution: "applied" };
  }

  async answerQuestion(_chatId: string, input: HostChatQuestionInput): Promise<HostChatQuestionResult> {
    if (!input.runId) throw new HostChatControlError({ code: "invalid", message: "This question is no longer attached to a run." });
    const value = await this.mutate(
      "answerQuestion",
      {
        operation: "runRespondQuestion",
        resourceId: input.runId,
        itemId: input.promptId,
        body: { cancelled: input.response.cancelled, answers: input.response.cancelled ? [] : input.response.answers },
        idempotencyKey: input.idempotencyKey ?? mintPeerIdempotencyKey(),
      },
      (error) =>
        error.remoteCode === "question_already_resolved"
          ? { value: { outcome: error.details?.outcome === "expired" ? "expired" : "elsewhere" } }
          : null,
    );
    const outcome = record(value).outcome;
    return { status: outcome === "answered" || outcome === "expired" || outcome === "elsewhere" ? outcome : undefined };
  }

  async submitInput(_chatId: string, input: HostChatInput): Promise<ChatRunInputAdmissionResult> {
    const value = record(
      await this.mutate("steer", {
        operation: "runInputs",
        resourceId: input.runId,
        body: { mode: input.mode, text: input.text },
        idempotencyKey: input.idempotencyKey ?? mintPeerIdempotencyKey(),
      }),
    );
    const queue = value.queue === "steer" || value.queue === "follow-up" ? value.queue : undefined;
    const reason =
      value.reason === "run_not_active" || value.reason === "cancelled" || value.reason === "capacity" || value.reason === "invalid"
        ? value.reason
        : undefined;
    const messageId = text(value.messageId);
    return {
      admitted: value.status === "admitted",
      committed: value.committed === true,
      ...(queue ? { queue } : {}),
      ...(reason ? { reason } : {}),
      ...(messageId ? { messageId } : {}),
    };
  }

  async rename(chatId: string, input: HostChatRenameInput): Promise<void> {
    if (!input.revision) throw new HostChatControlError({ code: "invalid", message: "Load the chat before renaming it." });
    const revision = input.revision;
    await this.guarded(chatId, () =>
      this.mutate("rename", { operation: "renameChat", resourceId: chatId, body: { title: input.title }, revision }),
    );
    // The rename gave the chat a new revision; reread it before another guarded change.
    this.chatChanged(chatId);
  }

  async remove(chatId: string, input: { revision?: string } = {}): Promise<void> {
    if (!input.revision) throw new HostChatControlError({ code: "invalid", message: "Load the chat before deleting it." });
    const revision = input.revision;
    await this.guarded(chatId, () => this.mutate("remove", { operation: "deleteChat", resourceId: chatId, revision }));
  }

  async uploadAttachment(chatId: string, upload: HostChatAttachmentUpload): Promise<HostStagedAttachment> {
    // Not keyed: an unused upload expires on the host, so a retry after a
    // lost answer only leaves a short-lived orphan behind.
    const value = record(await this.mutate("attach", { operation: "uploadAttachment", resourceId: chatId, body: upload }));
    const id = text(value.id);
    if (!id || typeof value.size !== "number")
      throw new HostChatControlError({ code: "invalid_response", message: "The host's answer was incomplete." });
    return { id, name: text(value.name) ?? upload.name, size: value.size };
  }

  async removeAttachment(chatId: string, attachmentId: string): Promise<void> {
    await this.mutate("attach", { operation: "removeAttachment", resourceId: chatId, itemId: attachmentId });
  }

  /** Runs a read the host must grant first, dropping its answer when the connection moved on. */
  private read<T>(capability: HostChatCapability, operation: PeerOperation, map: (value: unknown) => T): Promise<HostChatResult<T>> {
    if (!this.granted.has(capability))
      return Promise.resolve({ ok: false, error: { code: "unsupported", message: "This Mac does not allow that from here." } });
    return this.fenced(async () => {
      const outcome = await this.transport.call(this.hostId, operation);
      if (!outcome.ok) return outcome;
      try {
        return { ok: true, value: map(outcome.value) };
      } catch (error) {
        return { ok: false, error: failure(error) };
      }
    });
  }

  /** The host's skill catalog for one of its chats. */
  skills(chatId: string): Promise<HostChatResult<SkillCatalogEntry[]>> {
    return this.read("skills", { operation: "skills", resourceId: chatId }, (value) => parseSkillCatalog(record(value).skills));
  }

  /** The models the host has configured, for a chat that runs there. */
  models(): Promise<HostChatResult<HostModelCatalog>> {
    return this.read("createChat", { operation: "models" }, mapHostModelCatalog);
  }

  /** The folders the host's owner approved for browsing from paired devices. */
  roots(): Promise<HostChatResult<HostBrowserRoot[]>> {
    return this.read("browseFolders", { operation: "roots" }, mapHostBrowserRoots);
  }

  children(location: string, cursor?: string): Promise<HostChatResult<HostBrowserPage>> {
    return this.read(
      "browseFolders",
      { operation: "children", resourceId: location, ...(cursor ? { cursor } : {}) },
      mapHostBrowserPage,
    );
  }

  /** Asks the host for a single-use nonce naming one browsed folder. */
  async selectFolder(location: string): Promise<HostFolderSelection> {
    return this.shaped(
      await this.mutate("browseFolders", { operation: "selectFolder", body: { location } }),
      mapHostFolderSelection,
    );
  }

  async createWorkspace(body: HostWorkspaceCreate, idempotencyKey: string): Promise<HostCreatedWorkspace> {
    return this.shaped(
      await this.mutate("createWorkspace", { operation: "createWorkspace", body, idempotencyKey }),
      mapHostCreatedWorkspace,
    );
  }

  async createChat(input: HostNewChatInput, idempotencyKey: string): Promise<HostCreatedChat> {
    return this.shaped(
      await this.mutate("createChat", {
        operation: "createChat",
        body: { workspaceId: input.workspaceId, ...(input.model ? { ...input.model } : {}) },
        idempotencyKey,
      }),
      mapHostCreatedChat,
    );
  }

  /** Opens the Bot's chat on the host; the host returns the existing one when there is one. */
  async createBotChat(botId: string, idempotencyKey: string): Promise<HostCreatedChat> {
    return this.shaped(
      await this.mutate("botChats", { operation: "createBotChat", resourceId: botId, body: {}, idempotencyKey }),
      mapHostCreatedChat,
    );
  }

  private shaped<T>(value: unknown, map: (value: unknown) => T): T {
    try {
      return map(value);
    } catch {
      throw new HostChatControlError({ code: "invalid_response", message: "The host's answer was incomplete." });
    }
  }

  observe(chatId: string, observer: HostChatObserver): () => void {
    let closed = false;
    let key: string | null = null;
    let subscriptionId: string | null = null;
    // Frames that land before the subscription resolves are held, then
    // replayed after its buffered events so nothing is lost or reordered.
    let pending: PeerRunFrameMessage[] | null = [];
    const deliver = (frame: PeerRunFrameMessage) => {
      if (frame.key !== key) return;
      if (frame.kind === "event") observer.onEvent(frame.event);
      else observer.onState(frame.state);
    };
    const offFrames = this.transport.onRunFrame((frame) => {
      if (closed || this.disposed || frame.hostId !== this.hostId) return;
      if (pending) pending.push(frame);
      else deliver(frame);
    });
    this.transport.runSubscribe(this.hostId, { chatId }).then(
      (subscription) => {
        if (closed || this.disposed) {
          void this.transport.runUnsubscribe(subscription.subscriptionId).catch(() => {});
          return;
        }
        subscriptionId = subscription.subscriptionId;
        key = subscription.key;
        observer.onSubscription(subscription);
        const held = pending ?? [];
        pending = null;
        for (const frame of held) if (!closed) deliver(frame);
      },
      (error: unknown) => {
        pending = null;
        if (!closed && !this.disposed) observer.onError?.(failure(error));
      },
    );
    return () => {
      if (closed) return;
      closed = true;
      offFrames();
      if (subscriptionId) void this.transport.runUnsubscribe(subscriptionId).catch(() => {});
    };
  }

  dispose(): void {
    this.disposed = true;
    this.offHostState();
    this.listeners.clear();
    this.chatListeners.clear();
  }
}
