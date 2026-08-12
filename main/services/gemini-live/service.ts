import { randomUUID } from "node:crypto";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import type {
  AssistantLiveAvailabilityReason,
  AssistantLiveRendererEvent,
  AssistantLiveSnapshot,
  AssistantLiveStartIntent,
} from "../../../renderer/shared/assistant-live.js";
import type { RendererDocumentOwner } from "../renderer-document-owner.js";
import {
  GeminiLiveProtocol,
  type GeminiLiveConnector,
  GeminiLiveProtocolFailure,
  type GeminiLiveProtocolEvent,
  type GeminiLiveProtocolOptions,
} from "./protocol.js";
import type { GeminiLiveComputerUseBridge } from "./computer-use-bridge.js";
import type {
  GeminiLiveAcceptanceEvidenceEvent,
  GeminiLiveAcceptanceEvidenceRecorder,
} from "./acceptance-evidence.js";
import { GeminiLiveConnectionError } from "./owned-sdk-connector.js";

const ASSISTANT_LIVE_EVENT_CHANNEL = "assistant-live:event";

export class GeminiLiveStartError extends Error {
  constructor(
    readonly reason:
      | Exclude<AssistantLiveAvailabilityReason, "available">
      | "live_start_failed"
      | "google_live_authentication_failed"
      | "google_live_quota_exceeded"
      | "google_live_model_unavailable"
      | "google_live_service_unavailable"
      | "google_live_network_failed"
      | "google_live_configuration_unsupported",
  ) {
    super(
      reason === "missing_google_credential"
        ? "Connect Google with an API key before starting Live."
        : reason === "google_oauth_unsupported"
          ? "Google OAuth credentials cannot start Live yet."
          : reason === "google_api_key_invalid"
            ? "The saved Google API key is not valid for Live."
            : reason === "live_model_unverified"
              ? "No Google Live model has passed Aiden's production contract probe yet."
              : reason === "google_live_authentication_failed"
                ? "Google rejected this API key for Live. Check the key's restrictions or replace it in Settings."
                : reason === "google_live_quota_exceeded"
                  ? "Google Live quota is unavailable for this API key or project. Check its usage tier and billing."
                  : reason === "google_live_model_unavailable"
                    ? "The approved Google Live model is unavailable for this API key or region."
                    : reason === "google_live_service_unavailable"
                      ? "Google Live is temporarily unavailable. Try again shortly."
                      : reason === "google_live_configuration_unsupported"
                        ? "Google Live rejected Aiden's session configuration."
                        : reason === "google_live_network_failed"
                          ? "Aiden could not establish a connection to Google Live. Check your network, VPN, or firewall and try again."
                          : "The Live session could not start.",
    );
    this.name = "GeminiLiveStartError";
  }
}

/** Collapse connector/provider diagnostics before they can cross the IPC boundary. */
export function safeGeminiLiveStartError(error: unknown): GeminiLiveStartError {
  if (error instanceof GeminiLiveStartError) return error;
  if (error instanceof GeminiLiveConnectionError) {
    return new GeminiLiveStartError(
      error.code === "authentication"
        ? "google_live_authentication_failed"
        : error.code === "quota"
          ? "google_live_quota_exceeded"
          : error.code === "model_unavailable"
            ? "google_live_model_unavailable"
            : error.code === "service_unavailable"
              ? "google_live_service_unavailable"
              : error.code === "unsupported_configuration"
                ? "google_live_configuration_unsupported"
                : "google_live_network_failed",
    );
  }
  if (error instanceof GeminiLiveProtocolFailure) {
    return new GeminiLiveStartError(
      error.code === "connect_timeout"
        ? "google_live_network_failed"
        : "live_start_failed",
    );
  }
  return new GeminiLiveStartError("live_start_failed");
}

export interface GeminiLiveServiceOptions {
  credentials: Pick<CredentialStore, "read">;
  createConnector(apiKey: string): GeminiLiveConnector;
  resolveModel(): string | null | Promise<string | null>;
  createSessionId?: () => string;
  acceptanceEvidence?: GeminiLiveAcceptanceEvidenceRecorder | null;
  prepareComputerUse?(input: {
    chatId: string | null;
    owner: RendererDocumentOwner;
    sessionId: string;
    signal: AbortSignal;
  }): Promise<{
    bridge: GeminiLiveComputerUseBridge;
    tools: NonNullable<GeminiLiveProtocolOptions["tools"]>;
    approve(
      approvalId: string,
      allowed: boolean,
      ownerDocumentId: string,
    ): boolean;
    bindSendResult(
      send: (
        result: Parameters<GeminiLiveProtocol["sendToolResult"]>[0],
      ) => void,
    ): void;
  } | null>;
}

interface OwnedLiveSession {
  readonly abort: AbortController;
  readonly documentKey: string;
  readonly owner: RendererDocumentOwner;
  readonly sessionId: string;
  disposeOwner: () => void;
  protocol: GeminiLiveProtocol | null;
  state: AssistantLiveSnapshot["state"];
  microphone: boolean;
  resumptionAudio: Uint8Array[];
  model?: string;
  computerUse: GeminiLiveComputerUseBridge | null;
  approveComputerUse:
    | ((
        approvalId: string,
        allowed: boolean,
        ownerDocumentId: string,
      ) => boolean)
    | null;
  computerUseChatId: string | null;
}

function documentKey(owner: RendererDocumentOwner): string {
  return `${owner.id}:${owner.documentId}`;
}

type CredentialEligibility =
  | { reason: "available"; apiKey: string }
  | {
      reason: Exclude<
        AssistantLiveAvailabilityReason,
        "available" | "live_model_unverified"
      >;
    };

function credentialEligibility(
  credential: Credential | undefined,
): CredentialEligibility {
  if (!credential) return { reason: "missing_google_credential" };
  if (credential.type !== "api_key")
    return { reason: "google_oauth_unsupported" };
  if (
    typeof credential.key !== "string" ||
    credential.key.trim().length === 0
  ) {
    return { reason: "google_api_key_invalid" };
  }
  return { reason: "available", apiKey: credential.key.trim() };
}

function projectEvent(
  sessionId: string,
  event: GeminiLiveProtocolEvent,
): AssistantLiveRendererEvent | null {
  switch (event.type) {
    case "ready":
      return { type: "ready", sessionId };
    case "audio":
      return {
        type: "audio",
        sessionId,
        pcm: Uint8Array.from(event.pcm),
        sampleRate: 24_000,
      };
    case "playback_flush":
      return { type: "playback_flush", sessionId };
    case "caption":
      return { ...event, sessionId };
    case "model_text":
      return { ...event, sessionId };
    case "turn":
      return { ...event, sessionId };
    case "usage":
      return { ...event, sessionId };
    case "error":
      return {
        type: "error",
        code: event.code,
        message: event.message,
        sessionId,
      };
    case "reconnect_required":
      return { ...event, sessionId };
    case "function_call":
    case "function_cancel":
    case "go_away":
    case "resumption":
    case "state":
      return null;
  }
}

/** In-memory, exact-document session ownership. This store never serializes its records. */
export class GeminiLiveSessionStore {
  private readonly sessions = new Map<string, OwnedLiveSession>();

  get(owner: RendererDocumentOwner): OwnedLiveSession | undefined {
    return this.sessions.get(documentKey(owner));
  }

  isCurrent(session: OwnedLiveSession): boolean {
    return this.sessions.get(session.documentKey) === session;
  }

  install(session: OwnedLiveSession): void {
    if (this.sessions.has(session.documentKey)) {
      throw new Error(
        "A Live session must be closed before its replacement is installed.",
      );
    }
    this.sessions.set(session.documentKey, session);
  }

  delete(session: OwnedLiveSession): boolean {
    if (!this.isCurrent(session)) return false;
    this.sessions.delete(session.documentKey);
    return true;
  }

  values(): readonly OwnedLiveSession[] {
    return [...this.sessions.values()];
  }
}

export class GeminiLiveService {
  readonly sessions = new GeminiLiveSessionStore();
  private shuttingDown = false;

  constructor(private readonly options: GeminiLiveServiceOptions) {}

  async availability(
    owner: RendererDocumentOwner,
  ): Promise<AssistantLiveSnapshot> {
    const active = this.sessions.get(owner);
    if (active) return this.snapshot(active, "available");
    let credential: Credential | undefined;
    try {
      credential = await this.options.credentials.read("google");
    } catch {
      return this.idleSnapshot("google_api_key_invalid");
    }
    const credentialStatus = credentialEligibility(credential);
    if (credentialStatus.reason !== "available")
      return this.idleSnapshot(credentialStatus.reason);
    let model: string | null;
    try {
      model = await this.options.resolveModel();
    } catch {
      return this.idleSnapshot("live_model_unverified");
    }
    return this.idleSnapshot(
      model ? "available" : "live_model_unverified",
      model ?? undefined,
    );
  }

  async start(
    owner: RendererDocumentOwner,
    _intent: AssistantLiveStartIntent,
  ): Promise<AssistantLiveSnapshot> {
    if (this.shuttingDown) throw new GeminiLiveStartError("live_start_failed");
    if (owner.isDestroyed())
      throw new GeminiLiveStartError("live_start_failed");
    // Native picker acceptance is still open. Do not let a crafted renderer
    // request turn the Phase-0 deterministic capture proof into production authority.
    if (_intent.screen) throw new GeminiLiveStartError("live_start_failed");

    const session: OwnedLiveSession = {
      abort: new AbortController(),
      documentKey: documentKey(owner),
      owner,
      sessionId: this.options.createSessionId?.() ?? randomUUID(),
      disposeOwner: () => undefined,
      protocol: null,
      state: "connecting",
      microphone: _intent.microphone,
      resumptionAudio: [],
      computerUse: null,
      approveComputerUse: null,
      computerUseChatId: null,
    };
    const previous = this.sessions.get(owner);
    if (previous) this.closeSession(previous);
    this.sessions.install(session);
    session.disposeOwner = owner.onInvalidated(() =>
      this.closeSession(session),
    );

    try {
      const credential = await this.readGoogleCredential();
      const eligibility = credentialEligibility(credential);
      if (eligibility.reason !== "available")
        throw new GeminiLiveStartError(eligibility.reason);
      if (!this.sessions.isCurrent(session) || session.abort.signal.aborted) {
        throw new Error("The Assistant Live start was superseded.");
      }
      const model = await this.options.resolveModel();
      if (!model) throw new GeminiLiveStartError("live_model_unverified");
      if (!this.sessions.isCurrent(session) || session.abort.signal.aborted) {
        throw new Error("The Assistant Live start was superseded.");
      }
      session.model = model;

      const computerUse = this.options.prepareComputerUse
        ? await this.options.prepareComputerUse({
            chatId: _intent.chatId ?? null,
            owner,
            sessionId: session.sessionId,
            signal: session.abort.signal,
          })
        : null;
      if (!this.sessions.isCurrent(session) || session.abort.signal.aborted) {
        computerUse?.bridge.close();
        throw new Error("The Assistant Live start was superseded.");
      }
      session.computerUse = computerUse?.bridge ?? null;
      session.approveComputerUse = computerUse?.approve ?? null;
      session.computerUseChatId = computerUse ? (_intent.chatId ?? null) : null;

      const protocol = new GeminiLiveProtocol({
        connector: this.options.createConnector(eligibility.apiKey),
        model,
        signal: session.abort.signal,
        onEvent: (event) => this.handleProtocolEvent(session, event),
        tools: computerUse?.tools,
      });
      computerUse?.bindSendResult((result) => protocol.sendToolResult(result));
      session.protocol = protocol;
      await protocol.start();
      if (!this.sessions.isCurrent(session) || owner.isDestroyed()) {
        this.closeSession(session);
        throw new Error("The Assistant Live owner was invalidated.");
      }
      return this.snapshot(session, "available");
    } catch (error) {
      this.closeSession(session);
      const safeError = safeGeminiLiveStartError(error);
      process.stderr.write(
        `[gemini-live] stage=start result=${safeError.reason}\n`,
      );
      throw safeError;
    }
  }

  stop(owner: RendererDocumentOwner): AssistantLiveSnapshot {
    const session = this.sessions.get(owner);
    if (session) {
      this.recordAcceptanceEvidence("stop_requested", session.sessionId);
      this.closeSession(session);
      this.recordAcceptanceEvidence("stopped", session.sessionId);
    }
    return this.idleSnapshot("live_model_unverified");
  }

  approveComputerUse(
    owner: RendererDocumentOwner,
    approvalId: string,
    allowed: boolean,
  ): boolean {
    const session = this.sessions.get(owner);
    return (
      session?.approveComputerUse?.(approvalId, allowed, owner.documentId) ??
      false
    );
  }

  revokeComputerUse(chatId?: string): void {
    for (const session of this.sessions.values()) {
      if (chatId !== undefined && session.computerUseChatId !== chatId)
        continue;
      // A withdrawn global or per-chat gate terminates the attended session,
      // not just its tool adapter. Otherwise an issued provider call can stay
      // synchronously pending after its approval/controller authority vanished.
      // closeSession invalidates bridge queues and approvals before notifying
      // the renderer and before closing the provider transport.
      this.closeSession(session, true);
    }
  }

  sendAudio(
    owner: RendererDocumentOwner,
    sessionId: string,
    pcm: Uint8Array,
  ): boolean {
    const session = this.sessions.get(owner);
    // Preserve at most one second of microphone audio while the provider-owned
    // connection rotates. Latest packets win so a delayed reconnect cannot
    // grow memory without bound or replay stale speech indefinitely. The pinned
    // SDK rejects `transparent` in Gemini Developer API mode, so exact
    // last-consumed-index replay is unavailable on this transport.
    if (
      session?.sessionId === sessionId &&
      session.microphone &&
      session.state === "resuming"
    ) {
      session.resumptionAudio.push(Uint8Array.from(pcm));
      if (session.resumptionAudio.length > 50) session.resumptionAudio.shift();
      return true;
    }
    if (
      !session ||
      session.sessionId !== sessionId ||
      !session.microphone ||
      session.state !== "open" ||
      !session.protocol
    )
      return false;
    try {
      session.protocol.sendAudio(pcm);
      return true;
    } catch {
      this.closeSession(session);
      return false;
    }
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const session of this.sessions.values()) this.closeSession(session);
  }

  private handleProtocolEvent(
    session: OwnedLiveSession,
    event: GeminiLiveProtocolEvent,
  ): void {
    if (!this.sessions.isCurrent(session) || session.owner.isDestroyed())
      return;
    if (event.type === "ready")
      this.recordAcceptanceEvidence("ready", session.sessionId);
    if (event.type === "audio")
      this.recordAcceptanceEvidence("provider_response", session.sessionId);
    if (event.type === "error") {
      // Content-free lifecycle evidence for development/runtime triage. Never
      // include provider payloads, close reasons, transcripts, or credentials.
      process.stderr.write(
        `[gemini-live] stage=runtime result=${event.code}${
          event.diagnostic ? ` schema=${event.diagnostic}` : ""
        }${
          event.diagnosticDetail ? ` detail=${event.diagnosticDetail}` : ""
        }\n`,
      );
    }
    if (event.type === "function_call") {
      if (!session.computerUse) {
        session.protocol?.sendToolResult({
          id: event.id,
          name: event.name,
          response: {
            ok: false,
            error: {
              code: "tool_unavailable",
              message: "Computer Use is not enabled.",
            },
          },
        });
      } else {
        session.computerUse.enqueue(event);
      }
      return;
    }
    if (event.type === "function_cancel") {
      session.computerUse?.cancel(event.id);
      return;
    }
    if (event.type === "playback_flush") {
      // A VAD interruption revokes action authority before renderer playback is flushed.
      session.computerUse?.interrupt();
    }
    if (event.type === "state") {
      session.state = event.state;
      if (event.state === "open" && session.resumptionAudio.length > 0) {
        const pending = session.resumptionAudio.splice(0);
        try {
          for (const pcm of pending) session.protocol?.sendAudio(pcm);
        } catch {
          this.closeSession(session);
          return;
        }
      }
      this.send(session, {
        type: "snapshot",
        snapshot: this.snapshot(session, "available"),
      });
      if (
        event.state === "failed" ||
        event.state === "disconnected" ||
        event.state === "closed"
      ) {
        queueMicrotask(() => this.closeSession(session));
      }
      return;
    }
    const projected = projectEvent(session.sessionId, event);
    if (projected) this.send(session, projected);
  }

  private send(
    session: OwnedLiveSession,
    event: AssistantLiveRendererEvent,
  ): void {
    if (!this.sessions.isCurrent(session) || session.owner.isDestroyed())
      return;
    try {
      session.owner.send(ASSISTANT_LIVE_EVENT_CHANNEL, event);
    } catch {
      this.closeSession(session);
    }
  }

  private closeSession(
    session: OwnedLiveSession,
    notifyRenderer = false,
  ): void {
    if (!this.sessions.delete(session) && session.abort.signal.aborted) return;
    session.disposeOwner();
    session.computerUse?.close();
    session.computerUse = null;
    session.approveComputerUse = null;
    session.computerUseChatId = null;
    session.state = "closed";
    session.resumptionAudio = [];
    if (notifyRenderer && !session.owner.isDestroyed()) {
      try {
        session.owner.send(ASSISTANT_LIVE_EVENT_CHANNEL, {
          type: "snapshot",
          snapshot: this.snapshot(session, "available"),
        });
      } catch {
        // Teardown must continue even when the renderer disappeared between
        // the gate mutation and this terminal projection.
      }
    }
    session.abort.abort();
    session.protocol?.stop("cancelled");
    session.protocol = null;
  }

  private snapshot(
    session: OwnedLiveSession,
    reason: AssistantLiveAvailabilityReason,
  ): AssistantLiveSnapshot {
    return {
      available: reason === "available",
      reason,
      sessionId: session.sessionId,
      model: session.model,
      state: session.state,
    };
  }

  private idleSnapshot(
    reason: AssistantLiveAvailabilityReason,
    model?: string,
  ): AssistantLiveSnapshot {
    return {
      available: reason === "available",
      reason,
      ...(model ? { model } : {}),
      state: "idle",
    };
  }

  private async readGoogleCredential(): Promise<Credential | undefined> {
    try {
      return await this.options.credentials.read("google");
    } catch {
      // Credential-store diagnostics and paths are main-private. The renderer
      // receives only the fixed eligibility error below.
      throw new GeminiLiveStartError("google_api_key_invalid");
    }
  }

  private recordAcceptanceEvidence(
    event: GeminiLiveAcceptanceEvidenceEvent,
    sessionId: string,
  ): void {
    this.options.acceptanceEvidence?.record(event, sessionId);
  }
}
