/**
 * Profile-owned trust state for hooks, never stored in a repo: approved
 * digests per scope, per-hook disable flags, the pause-all switch and
 * consecutive-failure counters. Lives at `<root>/hooks-trust.json`.
 *
 * Disable flags and failure counts are keyed by scope and digest, not by hook
 * id: a repo hook's id is its position in `.aiden/hooks.json`, so inserting a
 * hook above another would otherwise move a flag onto a different command.
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
  /** `hookStateKey` of each hook the owner turned off. */
  disabled: string[];
  /** Keyed by `hookStateKey`: consecutive failures, and whether the limit turned the hook off. */
  failures: Record<string, { consecutive: number; autoDisabled?: true }>;
}

type HookStateTarget = Pick<HookDefinition, "digest" | "scope">;

/** Key for per-hook flags: the scope and the exact digest the flag applies to. */
export function hookStateKey(hook: HookStateTarget): string {
  return `${hookScopeKey(hook.scope)}\u0000${hook.digest}`;
}

const DIGEST = /^[0-9a-f]{64}$/u;

/** Whether a saved key has the `hookStateKey` shape: a scope key, a NUL, then a digest. */
function isStateKey(key: string): boolean {
  return key.length > 65 && key.charCodeAt(key.length - 65) === 0 && DIGEST.test(key.slice(-64));
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
          DIGEST.test((item as HookApprovalRecord).digest) &&
          isHookEvent((item as HookApprovalRecord).event) &&
          typeof (item as HookApprovalRecord).matcher === "string",
      );
      if (approvals.length > 0) state.approvals[scope] = approvals.map((item) => ({ ...item, approvedAt: Number(item.approvedAt) || 0 }));
    }
  }
  // Flags saved under the older id keys are dropped: they could point at another hook now.
  if (Array.isArray(record.disabled)) {
    state.disabled = [...new Set(record.disabled.filter((key): key is string => typeof key === "string" && isStateKey(key)))];
  }
  if (record.failures && typeof record.failures === "object") {
    for (const [key, value] of Object.entries(record.failures as Record<string, unknown>)) {
      if (!isStateKey(key) || !value || typeof value !== "object") continue;
      const consecutive = Number((value as { consecutive?: unknown }).consecutive);
      state.failures[key] = {
        consecutive: Number.isFinite(consecutive) && consecutive > 0 ? Math.floor(consecutive) : 0,
        ...((value as { autoDisabled?: unknown }).autoDisabled === true ? { autoDisabled: true as const } : {}),
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

  /**
   * Approve exactly this digest for this hook id, replacing any earlier approval of the id. A fresh approval starts with no flags.
   *
   * `current` lists the hooks now in the same scope. Repo hook ids follow their
   * position in the file, so when a new hook takes an approved hook's place, the
   * earlier approval moves to wherever that unchanged hook now sits instead of
   * being dropped.
   */
  approve(
    hook: Pick<HookDefinition, "id" | "digest" | "scope" | "event" | "matcher">,
    current: ReadonlyArray<Pick<HookDefinition, "id" | "digest">> = [],
  ): Promise<void> {
    const key = hookScopeKey(hook.scope);
    const existing = this.state.approvals[key] ?? [];
    const others: HookApprovalRecord[] = [];
    for (const record of existing) {
      if (record.digest === hook.digest) continue;
      if (record.hookId !== hook.id) {
        others.push(record);
        continue;
      }
      const moved = current.find((candidate) => candidate.digest === record.digest && candidate.id !== hook.id);
      if (moved && !existing.some((other) => other.hookId === moved.id)) others.push({ ...record, hookId: moved.id });
    }
    this.state.approvals[key] = [...others, { hookId: hook.id, digest: hook.digest, event: hook.event, matcher: hook.matcher, approvedAt: this.now() }];
    this.clearFlags(hook);
    return this.save();
  }

  /** Forget every approval and flag for a hook id. */
  revoke(hook: Pick<HookDefinition, "id" | "digest" | "scope">): Promise<void> {
    const key = hookScopeKey(hook.scope);
    const all = this.state.approvals[key] ?? [];
    const remaining = all.filter((record) => record.hookId !== hook.id);
    for (const record of all) if (record.hookId === hook.id) this.clearFlags({ scope: hook.scope, digest: record.digest });
    this.clearFlags(hook);
    if (remaining.length > 0) this.state.approvals[key] = remaining;
    else delete this.state.approvals[key];
    return this.save();
  }

  private clearFlags(hook: HookStateTarget): void {
    const key = hookStateKey(hook);
    this.state.disabled = this.state.disabled.filter((entry) => entry !== key);
    delete this.state.failures[key];
  }

  isDisabled(hook: HookStateTarget): boolean {
    return this.state.disabled.includes(hookStateKey(hook));
  }

  isDisabledAfterFailures(hook: HookStateTarget): boolean {
    return this.state.failures[hookStateKey(hook)]?.autoDisabled === true;
  }

  setEnabled(hook: HookStateTarget, enabled: boolean): Promise<void> {
    const key = hookStateKey(hook);
    if (enabled) this.clearFlags(hook);
    else if (!this.state.disabled.includes(key)) this.state.disabled.push(key);
    return this.save();
  }

  /**
   * Count a failure. At the limit the hook is turned off, unless `canDisable`
   * is false (a fail-closed hook: turning it off would quietly lift the block
   * it exists for), in which case it keeps counting. `autoDisabled` is true
   * only for the failure that turned it off.
   */
  async recordFailure(hook: HookStateTarget, options: { canDisable?: boolean } = {}): Promise<{ autoDisabled: boolean; consecutive: number }> {
    const key = hookStateKey(hook);
    const entry = this.state.failures[key] ?? { consecutive: 0 };
    if (entry.autoDisabled) return { autoDisabled: false, consecutive: entry.consecutive };
    entry.consecutive += 1;
    const reached = entry.consecutive >= HOOK_FAILURE_LIMIT && options.canDisable !== false;
    if (reached) entry.autoDisabled = true;
    this.state.failures[key] = entry;
    await this.save();
    return { autoDisabled: reached, consecutive: entry.consecutive };
  }

  async recordSuccess(hook: HookStateTarget): Promise<void> {
    const key = hookStateKey(hook);
    const entry = this.state.failures[key];
    if (!entry || (entry.consecutive === 0 && !entry.autoDisabled)) return;
    delete this.state.failures[key];
    await this.save();
  }

  consecutiveFailures(hook: HookStateTarget): number {
    return this.state.failures[hookStateKey(hook)]?.consecutive ?? 0;
  }

  /** Every scope key that has approvals, for listing workspace roots. */
  approvedScopeKeys(): string[] {
    return Object.keys(this.state.approvals);
  }
}
