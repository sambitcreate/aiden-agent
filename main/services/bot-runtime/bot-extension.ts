// The `aiden-bot` Pi Durable extension: everything a Bot turn needs from
// Aiden, installed in a Bot harness's registry before anything can run.
//
// - System prompt: the Bot's sections in the order base, persona, authority,
//   then connection guidance, rendered verbatim (Aiden already escapes and
//   tags their content). Sections are built after the tools, so the base
//   prompt and MCP guidance describe exactly the tools offered.
// - Tools: Aiden tools adapted by `tool-adapter.ts`, rebuilt from the current
//   inventory on every `refresh()` (each submit and Resume). MCP tools are
//   never replay-safe; the caller declares replay for the rest.
// - Policy: `beforeTool` re-checks the Bot's current policy at every call and
//   blocks a disallowed tool without running it.
// - Images: a model without image input gets text references in place of the
//   person's images, for that request only (see `bot-images.ts`).
// - Approvals: an approval-gated call asks through `requestApproval` with a
//   `waitId` persisted in the tool task's memo, so a restart re-asks the same
//   approval instead of minting a new one.
// - Authority: the first request after the harness opens re-admits the Bot and
//   fails closed (no provider request) when its access changed.

import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createRegistry,
  defineExtension,
  GenerationTask,
  hook,
  section,
  ToolTask,
  type Extension,
  type Harness,
  type Registry,
} from "@earendil-works/pi-durable";
import type { BotDefinition } from "../../../renderer/shared/bots.js";
import { withImageReferences } from "./bot-images.js";
import { adaptAidenTool, type BotToolCall, type DurableTool, type ToolReplay } from "./tool-adapter.js";

export const BOT_EXTENSION_NAME = "aiden-bot";
/** Section keys, in render order. */
export const BOT_SECTION_KEYS = ["aiden-base", "aiden-persona", "aiden-authority", "aiden-guidance"] as const;
const APPROVAL_MEMO = "aiden.approval";

export interface BotApprovalRequirement {
  summary: string;
  /**
   * Runs after the person allows, before the tool executes (for example to
   * bind a Computer Use grant to this call). A throw blocks the call.
   */
  onAllow?(): void | Promise<void>;
}

export type BotPolicyDecision =
  | { allowed: true; approval?: BotApprovalRequirement }
  | { allowed: false; reason: string };

/** The call being checked. */
export interface BotToolCallCheck {
  callId: string;
  args: unknown;
  signal: AbortSignal | undefined;
}

export type BotReadmission = { ok: true } | { ok: false; reason: "access_changed" | "bot_missing" };

export interface BotApprovalRequest {
  botId: string;
  /** Stable across restarts for the same tool call. */
  waitId: string;
  toolCallId: string;
  toolName: string;
  summary: string;
  /** Aborted when the turn is stopped; the approval prompt should be withdrawn. */
  signal: AbortSignal | undefined;
}

export interface BotToolEntry {
  tool: AgentTool;
  replay: ToolReplay;
  /** MCP tools are forced to `unsafe` replay. */
  mcp?: boolean;
  /** Build the tool per call from the conversation it runs in (see `tool-adapter.ts`). */
  bind?: (call: BotToolCall) => AgentTool;
}

/** What the next request offers, so the sections can describe it. */
export interface BotOfferedTools {
  toolNames: readonly string[];
}

/** What the next run is for: the request that started (or will start) it. */
export interface BotTurnContext {
  /** Routine runs (`routine:*`) get no routine-editing tools. */
  requestId?: string;
}

export interface BotExtensionDeps {
  /** Re-read on every refresh. */
  loadBot(botId: string): Promise<BotDefinition>;
  /** Base, persona, authority and guidance sections, in this order. Built after `currentTools`. */
  systemSections(bot: BotDefinition, offered: BotOfferedTools): Promise<string[]>;
  currentTools(bot: BotDefinition, turn: BotTurnContext): Promise<BotToolEntry[]>;
  checkPolicy(botId: string, toolName: string, call?: BotToolCallCheck): Promise<BotPolicyDecision>;
  /**
   * Ask the person. Resolves with their answer; rejects when `signal` aborts
   * (the turn stopped or the app is quitting), so the call stays unanswered
   * and is re-asked with the same `waitId` after Resume.
   */
  requestApproval(request: BotApprovalRequest): Promise<"allow" | "deny">;
  readmit(botId: string): Promise<BotReadmission>;
  /** Whether the Bot's model takes images. Defaults to true. */
  imageInput?(botId: string): Promise<boolean>;
}

export class BotAccessChangedError extends Error {
  constructor(readonly reason: "access_changed" | "bot_missing") {
    super(reason === "bot_missing" ? "This Bot no longer exists." : "This Bot's access changed. Review it in Advanced.");
    this.name = "BotAccessChangedError";
  }
}

export interface BotRegistry extends Registry {
  /**
   * Reload the Bot, its sections and its tools, and reinstall the extension.
   * Call before every submit and Resume; pending tool calls resolve against
   * the tools installed here.
   */
  refresh(turn?: BotTurnContext): Promise<void>;
  /** The readmission failure that stopped the latest request, if any. */
  admissionFailure(): BotReadmission | null;
  /**
   * Bind the harness this registry serves. Required for failing closed: a
   * hook's own error is only reported by Pi Durable, so a failed readmission
   * aborts the generation task instead.
   */
  attachHarness(harness: Harness): void;
}

interface ApprovalMemo {
  [key: string]: JsonValue;
  waitId: string;
  toolCallId: string;
  summary: string;
}

export function createBotRegistry(botId: string, deps: BotExtensionDeps): BotRegistry {
  const registry = createRegistry();
  let sections: readonly string[] = [];
  let admitted = false;
  let failure: BotReadmission | null = null;
  let harness: Harness | undefined;

  /**
   * Stop the generation before it reaches the provider. Pi Durable reports and
   * ignores errors thrown by hooks, so throwing alone would still send the
   * request; aborting the task ends the run as `unanswered` instead.
   */
  async function failClosed(taskId: Parameters<Harness["abortTask"]>[0], context: Context, error: Error): Promise<never> {
    if (harness === undefined) throw error;
    void harness.abortTask(taskId, BACKGROUND_CONTEXT).catch(() => undefined);
    await new Promise<void>((resolve) => {
      const signal = context.abortSignal;
      if (signal === undefined || signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw error;
  }

  const hooks = [
    hook(GenerationTask, {
      beforeRequest: async (request, api, context) => {
        if (!admitted) {
          const readmission = await deps.readmit(botId);
          if (!readmission.ok) {
            failure = readmission;
            return failClosed(api.taskId, context, new BotAccessChangedError(readmission.reason));
          }
          failure = null;
          admitted = true;
        }
        if (deps.imageInput === undefined || (await deps.imageInput(botId))) return undefined;
        return { messages: withImageReferences(request.messages) };
      },
    }),
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const decision = await deps.checkPolicy(botId, call.name, {
          callId: call.id,
          args: call.arguments,
          signal: context.abortSignal,
        });
        if (!decision.allowed) return { block: decision.reason };
        if (decision.approval === undefined) return undefined;
        const memo = await api.memo<ApprovalMemo>(
          APPROVAL_MEMO,
          { waitId: randomUUID(), toolCallId: call.id, summary: decision.approval.summary },
          context,
        );
        const answer = await deps.requestApproval({
          botId,
          waitId: memo.waitId,
          toolCallId: memo.toolCallId,
          toolName: call.name,
          summary: memo.summary,
          signal: context.abortSignal,
        });
        if (answer !== "allow") return { block: "The person declined this action." };
        try {
          await decision.approval.onAllow?.();
        } catch (error) {
          return { block: error instanceof Error ? error.message : "This action can no longer run." };
        }
        return undefined;
      },
    }),
  ];

  function build(tools: readonly DurableTool[]): Extension {
    return defineExtension({
      name: BOT_EXTENSION_NAME,
      tools,
      sections: BOT_SECTION_KEYS.map((key, index) =>
        section(key, () => {
          const text = sections[index];
          return text === undefined || text.length === 0 ? undefined : text;
        }, { tag: false }),
      ),
      hooks,
    });
  }

  registry.install(build([]));

  return Object.assign(registry, {
    async refresh(turn: BotTurnContext = {}) {
      const bot = await deps.loadBot(botId);
      const entries = await deps.currentTools(bot, turn);
      const nextSections = await deps.systemSections(bot, { toolNames: entries.map(({ tool }) => tool.name) });
      sections = nextSections.slice(0, BOT_SECTION_KEYS.length);
      const tools = entries.map(({ tool, replay, mcp, bind }) =>
        adaptAidenTool(tool, { replay: mcp ? "unsafe" : replay, ...(bind === undefined ? {} : { bind }) }),
      );
      registry.install(build(tools));
    },
    admissionFailure() {
      return failure;
    },
    attachHarness(next: Harness) {
      harness = next;
    },
  });
}
