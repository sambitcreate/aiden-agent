/**
 * Profile-owned trust state for hooks, never stored in a repo: approved
 * digests per scope, per-hook disable flags, the pause-all switch and
 * consecutive-failure counters. Lives at `<root>/hooks-trust.json`.
 */

import * as path from "node:path";
import { HookJsonFile } from "./hook-json-file.js";
import { hookScopeKey, isHookEvent } from "./hook-config.js";
import type { HookDefinition, HookEvent, HookScope } from "./hook-types.js";

export const HOOK_FAILURE_LIMIT = 3;

export interface HookApprovalRecord {
  hookId: string;
  digest: string;
  event: HookEvent;
  matcher: string;
  approvedAt: number;
}

export interface HookTrustState {
  version: 1;
  paused: boolean;
  /** Keyed by `hookScopeKey`. */
  approvals: Record<string, HookApprovalRecord[]>;
  disabled: string[];
  /** Consecutive failures, and the digest that was auto-disabled at the limit. */
  failures: Record<string, { consecutive: number; disabledDigest?: string }>;
}

export type HookTrustVerdict = "approved" | "waiting-for-approval" | "changed";

function emptyTrust(): HookTrustState {
  return { version: 1, paused: false, approvals: {}, disabled: [], failures: {} };
}

function sanitizeTrust(raw: unknown): HookTrustState {
  const state = emptyTrust();
  if (!raw || typeof raw !== "object") return state;
  const record = raw as Record<string, unknown>;
  state.paused = record.paused === true;
  if (record.approvals && typeof record.approvals === "object") {
    for (const [scope, list] of Object.entries(record.approvals as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const approvals = list.filter(
        (item): item is HookApprovalRecord =>
          !!item &&
          typeof item === "object" &&
          typeof (item as HookApprovalRecord).hookId === "string" &&
          typeof (item as HookApprovalRecord).digest === "string" &&
          /^[0-9a-f]{64}$/u.test((item as HookApprovalRecord).digest) &&
          isHookEvent((item as HookApprovalRecord).event) &&
          typeof (item as HookApprovalRecord).matcher === "string",
      );
      if (approvals.length > 0) state.approvals[scope] = approvals.map((item) => ({ ...item, approvedAt: Number(item.approvedAt) || 0 }));
    }
  }
  if (Array.isArray(record.disabled)) state.disabled = [...new Set(record.disabled.filter((id): id is string => typeof id === "string"))];
  if (record.failures && typeof record.failures === "object") {
    for (const [id, value] of Object.entries(record.failures as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const consecutive = Number((value as { consecutive?: unknown }).consecutive);
      const disabledDigest = (value as { disabledDigest?: unknown }).disabledDigest;
      state.failures[id] = {
        consecutive: Number.isFinite(consecutive) && consecutive > 0 ? Math.floor(consecutive) : 0,
        ...(typeof disabledDigest === "string" ? { disabledDigest } : {}),
      };
    }
  }
  return state;
}

export class HookTrustStore {
  private state: HookTrustState = emptyTrust();
  private readonly file: HookJsonFile<HookTrustState>;

  constructor(root: () => string, private readonly now: () => number = Date.now) {
    this.file = new HookJsonFile(() => path.join(root(), "hooks-trust.json"), sanitizeTrust, emptyTrust);
  }

  async load(): Promise<void> {
    this.state = await this.file.read();
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  private save(): Promise<void> {
    return this.file.write(this.state);
  }

  get paused(): boolean {
    return this.state.paused;
  }

  setPaused(paused: boolean): Promise<void> {
    this.state.paused = paused;
    return this.save();
  }

  approvalsFor(scope: HookScope): readonly HookApprovalRecord[] {
    return this.state.approvals[hookScopeKey(scope)] ?? [];
  }

  verdict(hook: Pick<HookDefinition, "id" | "digest" | "scope">): HookTrustVerdict {
    const approvals = this.approvalsFor(hook.scope);
    if (approvals.some((record) => record.digest === hook.digest)) return "approved";
    return approvals.some((record) => record.hookId === hook.id) ? "changed" : "waiting-for-approval";
  }

  /** Approve exactly this digest for this hook id, replacing any earlier approval of the id. */
  approve(hook: Pick<HookDefinition, "id" | "digest" | "scope" | "event" | "matcher">): Promise<void> {
    const key = hookScopeKey(hook.scope);
    const others = (this.state.approvals[key] ?? []).filter((record) => record.hookId !== hook.id && record.digest !== hook.digest);
    this.state.approvals[key] = [...others, { hookId: hook.id, digest: hook.digest, event: hook.event, matcher: hook.matcher, approvedAt: this.now() }];
    this.state.disabled = this.state.disabled.filter((id) => id !== hook.id);
    delete this.state.failures[hook.id];
    return this.save();
  }

  /** Forget every approval and flag for a hook id. */
  revoke(hook: Pick<HookDefinition, "id" | "scope">): Promise<void> {
    const key = hookScopeKey(hook.scope);
    const remaining = (this.state.approvals[key] ?? []).filter((record) => record.hookId !== hook.id);
    if (remaining.length > 0) this.state.approvals[key] = remaining;
    else delete this.state.approvals[key];
    this.state.disabled = this.state.disabled.filter((id) => id !== hook.id);
    delete this.state.failures[hook.id];
    return this.save();
  }

  isDisabled(hookId: string): boolean {
    return this.state.disabled.includes(hookId);
  }

  isDisabledAfterFailures(hook: Pick<HookDefinition, "id" | "digest">): boolean {
    return this.state.failures[hook.id]?.disabledDigest === hook.digest;
  }

  setEnabled(hookId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      this.state.disabled = this.state.disabled.filter((id) => id !== hookId);
      delete this.state.failures[hookId];
    } else if (!this.state.disabled.includes(hookId)) {
      this.state.disabled.push(hookId);
    }
    return this.save();
  }

  /** Count a failure; returns true when this one reached the limit and disabled the hook. */
  async recordFailure(hook: Pick<HookDefinition, "id" | "digest">): Promise<boolean> {
    const entry = this.state.failures[hook.id] ?? { consecutive: 0 };
    if (entry.disabledDigest === hook.digest) return false;
    entry.consecutive += 1;
    const reached = entry.consecutive >= HOOK_FAILURE_LIMIT;
    if (reached) entry.disabledDigest = hook.digest;
    this.state.failures[hook.id] = entry;
    await this.save();
    return reached;
  }

  async recordSuccess(hookId: string): Promise<void> {
    const entry = this.state.failures[hookId];
    if (!entry || (entry.consecutive === 0 && !entry.disabledDigest)) return;
    delete this.state.failures[hookId];
    await this.save();
  }

  consecutiveFailures(hookId: string): number {
    return this.state.failures[hookId]?.consecutive ?? 0;
  }

  /** Every scope key that has approvals, for listing workspace roots. */
  approvedScopeKeys(): string[] {
    return Object.keys(this.state.approvals);
  }
}
