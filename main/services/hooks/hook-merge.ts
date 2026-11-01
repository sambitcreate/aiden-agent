/**
 * Combine every matching hook's answer for one event. Strictest wins:
 * deny > ask > allow. Reasons are attributed to hook names; context is
 * fenced as data and capped per hook and per event.
 */

import { fenceAsData } from "../../../renderer/shared/agent-notices.js";
import { aidenToolInput } from "./hook-aliases.js";
import type { HookHandlerResult } from "./hook-runner.js";
import type { HookDefinition, HookEvent, HookOutcome, HookPayload, HookPermissionDecision } from "./hook-types.js";

export const MAX_HOOK_CONTEXT_CHARS = 10_000;
export const MAX_EVENT_CONTEXT_CHARS = 20_000;
const MAX_REASON_CHARS = 2_000;
const MAX_MESSAGE_CHARS = 1_000;

const RANK: Record<HookPermissionDecision, number> = { allow: 1, ask: 2, deny: 3 };

/** Tools whose input a hook may never rewrite: the approval card showed the original. */
const NO_UPDATED_INPUT_TOOLS: ReadonlySet<string> = new Set(["run_command"]);

export interface HookMergeEntry {
  hook: Pick<HookDefinition, "id" | "name">;
  result: HookHandlerResult;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The stricter of two decisions. */
export function stricterDecision(a: HookPermissionDecision | undefined, b: HookPermissionDecision | undefined): HookPermissionDecision | undefined {
  if (!a) return b;
  if (!b) return a;
  return RANK[b] > RANK[a] ? b : a;
}

function contextBlocks(entries: readonly HookMergeEntry[]): string | undefined {
  const blocks: string[] = [];
  let used = 0;
  for (const { hook, result } of entries) {
    const text = result.additionalContext?.trim();
    if (!text) continue;
    const label = `Context from hook "${hook.name}"`;
    const overhead = fenceAsData(label, "").length + 2;
    const room = Math.min(MAX_HOOK_CONTEXT_CHARS, MAX_EVENT_CONTEXT_CHARS - used - overhead);
    if (room <= 0) break;
    const block = fenceAsData(label, cap(text, room));
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * Merge per-hook results (in definition order) into one outcome for `event`.
 * `payload` supplies the tool name and original input for `updatedInput`.
 */
export function mergeHookResults(event: HookEvent, entries: readonly HookMergeEntry[], payload?: HookPayload): HookOutcome {
  const outcome: HookOutcome = { ranHooks: entries.map((entry) => entry.hook.name) };
  if (event === "PreToolUse") {
    let decision: HookPermissionDecision | undefined;
    for (const entry of entries) decision = stricterDecision(decision, entry.result.decision);
    if (decision) {
      outcome.decision = decision;
      const reasons = entries
        .filter((entry) => entry.result.decision === decision && entry.result.reason)
        .map((entry) => `${entry.hook.name}: ${cap(entry.result.reason ?? "", MAX_REASON_CHARS)}`);
      if (reasons.length > 0) outcome.reason = reasons.join("\n");
      if (decision === "allow") {
        const toolName = payload?.aiden_tool_name ?? payload?.tool_name;
        const winner = entries.find((entry) => entry.result.decision === "allow" && entry.result.updatedInput);
        if (winner?.result.updatedInput && toolName && !NO_UPDATED_INPUT_TOOLS.has(toolName)) {
          outcome.updatedInput = aidenToolInput(toolName, winner.result.updatedInput, payload?.tool_input);
        }
      }
    }
  } else {
    const blocking = entries.filter((entry) => entry.result.block);
    if (blocking.length > 0) {
      outcome.reason = blocking.map((entry) => `${entry.hook.name}: ${cap(entry.result.reason ?? "Blocked by hook.", MAX_REASON_CHARS)}`).join("\n");
      if (event === "UserPromptSubmit") outcome.blockPrompt = true;
      else if (event === "Stop" || event === "SubagentStop") outcome.continueTurn = true;
      else if (event === "PostToolUse") outcome.flaggedResult = true;
    }
  }
  if (outcome.reason) outcome.reasonForModel = fenceAsData("Hook result", outcome.reason);
  const context = contextBlocks(entries);
  if (context) outcome.additionalContext = context;
  const stopping = entries.filter((entry) => entry.result.stopTurn);
  if (stopping.length > 0) {
    outcome.stopTurn = true;
    const reasons = stopping.filter((entry) => entry.result.stopReason).map((entry) => `${entry.hook.name}: ${cap(entry.result.stopReason ?? "", MAX_REASON_CHARS)}`);
    if (reasons.length > 0) outcome.stopReason = reasons.join("\n");
  }
  const messages = entries
    .filter((entry) => entry.result.systemMessage)
    .map((entry) => `${entry.hook.name}: ${cap(entry.result.systemMessage ?? "", MAX_MESSAGE_CHARS)}`);
  if (messages.length > 0) outcome.systemMessages = messages;
  const notices = entries
    .filter((entry) => entry.result.result === "error" && entry.result.error)
    .map((entry) =>
      entry.result.decision === "deny"
        ? `Hook "${entry.hook.name}" ${entry.result.error}; the tool was blocked.`
        : `Hook "${entry.hook.name}" ${entry.result.error}; Aiden continued without it.`,
    );
  if (notices.length > 0) outcome.notices = notices;
  return outcome;
}
