/** Internal foundation contract; not advertised over IPC or Remote API yet. */
export type DurableJobState =
  | "admitting"
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "interrupted"
  | "needs_attention"
  | "waiting_approval"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled";

export type DurableJobAction = "pause" | "resume" | "cancel" | "retry";
export type DurableJobIntent = "none" | "pause" | "stop" | "cancel";

export interface DurableJobInput {
  profileId: string;
  botId: string;
  workspaceId: string;
  chatId: string;
  messageId: string;
  turnId: string;
  /** Reference to already durable, bounded input; never a renderer-only draft. */
  inputRef: string;
  inputDigest: string;
  providerId: string;
  modelId: string;
  authorityRevision: string;
}

export interface DurableJobCheckpoint {
  sessionId: string;
  headId: string;
  inputMessageId: string;
  operationIds: string[];
  childRunIds: string[];
}

export type DurableJobRecovery =
  | "not_started"
  | "checkpoint"
  | "completed"
  | "failed_safe"
  | "waiting_approval"
  | "waiting_input"
  | "interrupted"
  | "unknown"
  | "missing"
  | "stale_authority"
  | "unsettled";

export interface DurableJobSnapshot {
  version: 1;
  id: string;
  input: DurableJobInput;
  state: DurableJobState;
  intent: DurableJobIntent;
  revision: number;
  createdAt: number;
  updatedAt: number;
  recovery: DurableJobRecovery;
  checkpoint: DurableJobCheckpoint | null;
  resultRef: string | null;
  waitId: string | null;
  /** An execution-start marker is never cleared by reclaim or a user control. */
  dispatched: boolean;
  executionCount: number;
  attemptId: string | null;
  continuation: "none" | "resume" | "retry";
  pendingReconciliation: boolean;
}
