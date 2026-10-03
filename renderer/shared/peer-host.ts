/** Resource identity is independent of display names and transport addresses. */
export interface HostResource {
  hostId: string;
  resourceId: string;
}

export const LOCAL_HOST_ID = "local";
export const MAX_PEER_HOSTS = 32;

export function hostIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) {
    throw new Error("Invalid host resource identifier.");
  }
  return value;
}

export function hostResourceKey(ref: HostResource): string {
  return JSON.stringify([
    hostIdentifier(ref.hostId),
    hostIdentifier(ref.resourceId),
  ]);
}

export type PeerConnectionState =
  "disabled" | "disconnected" | "connecting" | "connected" | "unavailable";

export interface PeerHostView {
  id: string;
  name: string;
  enabled: boolean;
  state: PeerConnectionState;
  features: string[];
  capabilities: string[];
}

/** Why a supervisor stopped retrying; only re-pairing, or disable and enable, clears it. */
export type PeerBlockedReason = "auth" | "identity_changed" | "protocol";

/** Main's per-host supervisor state. Credentials and endpoints never appear here. */
export type PeerSupervisorState =
  | { kind: "disabled" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; since: number }
  | { kind: "backoff"; attempt: number; retryAt: number }
  | { kind: "blocked"; reason: PeerBlockedReason };

/** `unsupported` means the host or this device lacks the host feed grant or feature. */
export type PeerFeedState = "off" | "unsupported" | "syncing" | "live";

export interface PeerHostStatus {
  hostId: string;
  /** Increments on every transition; renderers drop older statuses. */
  generation: number;
  state: PeerSupervisorState;
  feed: PeerFeedState;
  /** Last-known rows are kept while the host is offline and marked stale. */
  stale: boolean;
}

/** One run's state as the host feed reports it. */
export interface PeerRunState {
  chatId: string;
  runId: string;
  state: string;
  unread: boolean;
}

/** Credential-free repository identity (contract revision 19); equal keys mean the same repository. */
export interface PeerRepositoryIdentity {
  canonicalKey: string;
  /** POSIX path of the workspace folder inside the repository; `""` at the root. */
  relativePath: string;
}

/** Feed rows are the host's list projections, passed through as plain JSON objects. */
export type PeerFeedRow = Record<string, unknown> & { id: string };

export interface PeerHostFeedSnapshot {
  hostId: string;
  epoch: string | null;
  sequence: number;
  stale: boolean;
  summaries: PeerFeedRow[];
  workspaces: PeerFeedRow[];
  bots: PeerFeedRow[];
  runs: PeerRunState[];
}

export type PeerHostFeedChange =
  /** A full snapshot replaced every row (first sync, epoch change or resync). */
  | {
      type: "reset";
      summaries: PeerFeedRow[];
      workspaces: PeerFeedRow[];
      bots: PeerFeedRow[];
      runs: PeerRunState[];
    }
  | { type: "chat.upsert" | "workspace.upsert" | "bot.upsert"; row: PeerFeedRow }
  | { type: "chat.remove" | "workspace.remove" | "bot.remove"; id: string }
  | { type: "run.state"; run: PeerRunState }
  | { type: "stale"; stale: boolean };

/** Broadcast once to every window on `remote:host-feed`. */
export interface PeerHostFeedMessage {
  hostId: string;
  epoch: string | null;
  sequence: number;
  change: PeerHostFeedChange;
}

/** A live run stream follows a chat's current run, or one specific run. */
export type PeerRunTarget = { chatId: string } | { runId: string };

/** A validated run-stream envelope (the host's `/runs/{runId}/events` vocabulary). */
export interface PeerRunEvent {
  protocolVersion: 1;
  streamId: string;
  sequence: number;
  timestamp: string;
  type: string;
  terminal: boolean;
  payload: Record<string, unknown>;
}

/**
 * `idle`: a chat target with no current run, waiting for the feed to announce one.
 * `ended`: the run finished. `gone`: the host no longer retains the run.
 * `waiting`: the host is not connected; the stream resumes when it is.
 */
export type PeerRunStreamState = "streaming" | "idle" | "ended" | "gone" | "waiting";

/** Broadcast on `remote:peer-run-frame`; `key` identifies the shared stream within a host. */
export type PeerRunFrameMessage =
  | {
      kind: "event";
      hostId: string;
      key: string;
      runId: string;
      chatId: string | null;
      event: PeerRunEvent;
    }
  | {
      kind: "state";
      hostId: string;
      key: string;
      runId: string | null;
      chatId: string | null;
      state: PeerRunStreamState;
    };

export interface PeerRunSubscription {
  subscriptionId: string;
  key: string;
  runId: string | null;
  chatId: string | null;
  state: PeerRunStreamState;
  /** Buffered events after the caller's `afterSequence`, for the current run. */
  events: PeerRunEvent[];
  /** The buffer no longer reaches back to `afterSequence`; refetch the chat window first. */
  truncated: boolean;
}

export interface PeerOperationErrorDetails {
  decision?: "allow" | "deny";
  outcome?: "answered" | "expired";
  resolvedAt?: string;
  currentRevision?: string;
}

export interface PeerOperationError {
  /** A transport code, `outcome_unknown`, or `failed`. */
  code: string;
  message: string;
  status?: number;
  remoteCode?: string;
  retryable?: boolean;
  /**
   * The host's sanitized error details: the winning decision or outcome of a
   * run-control race, when it was resolved, and a chat's current revision.
   */
  details?: PeerOperationErrorDetails;
  /** For `outcome_unknown`: the state one read-only reconciliation observed, if any. */
  reconciled?: unknown;
}

export type PeerOperationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: PeerOperationError };

/** The renderer mints one key per user intent and reuses it on a retry. */
export function mintPeerIdempotencyKey(): string {
  return `aiden-${crypto.randomUUID()}`;
}
