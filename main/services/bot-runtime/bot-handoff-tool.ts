// The durable `hand_off` tool for Bot turns (plan §4.2): the Bot hands one
// step to the person ("Enter the 2FA code for your bank") and waits for Done
// or Skip through `bot-handoffs.ts`.
//
// - Waiting: the card's `waitId` is a memo of the tool task, so a Resume after
//   a quit or crash shows the same card under the same id.
// - Replay: `safe`. Its only effect is showing a card; the answer lands in the
//   one tool result the harness commits, so re-asking after an interruption is
//   idempotent and an answer is applied exactly once.
// - Stopped (Stop, Dismiss, delete): the wait rejects, so no answer is
//   recorded; the harness writes its own `aborted` result.
// - Not offered on routine or Telegram turns (`bot-tool-policy.ts`): nobody is
//   watching a card there.
// - Interactive: the call waits for a person, so it holds no authority
//   admission while it waits (`interactive` on the candidate).

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  BOT_HANDOFF_ACTION_MAX_CHARS,
  BOT_HANDOFF_TOOL_NAME,
  BOT_HANDOFF_URL_MAX_CHARS,
  BOT_HANDOFF_WHY_MAX_CHARS,
  isBotHandoffOpenUrl,
  normalizeBotHandoffAction,
  withoutBotHandoffControls,
  type BotHandoffResultDetails,
  type BotHandoffTarget,
} from "../../../renderer/shared/bot-handoffs.js";
import { isBoundedBotText } from "../../../renderer/shared/bot-capabilities.js";
import { handoffDoneText, handoffSkippedText } from "./bot-handoff-text.js";
import type { BotHandoffs } from "./bot-handoffs.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import type { BotToolCall } from "./tool-adapter.js";

export const BOT_HANDOFF_MEMO = "aiden.handoff";

const DESCRIPTION =
  "Hand one step of the task to the person when you must not or cannot do it yourself: entering a password or " +
  "2FA code, changing account security, a payment, a CAPTCHA, a legal sign-off, or anything your rules hand to " +
  "them. `action` is the step as a short imperative (\"Enter the 2FA code for your bank\"); `why` says in a " +
  "sentence why it needs them; `open.url` is an https page that helps them do it. The app shows a card with Done " +
  "and Skip, and their answer comes back as this tool's result: wait for it, then check the result before you " +
  "continue. Never ask for passwords or codes in the chat.";

/** Where this Bot can hand a step over in its own browser or on its own computer, this turn. */
export interface BotHandoffTargets {
  browser: boolean;
  computer: boolean;
}

/** The tool's description, with `where` explained only for what the Bot has. */
export function botHandoffDescription(targets: BotHandoffTargets = { browser: false, computer: false }): string {
  const where = [
    targets.browser ? 'where: "browser" for a page in your browser' : undefined,
    targets.computer ? 'where: "computer" for a step on your own computer' : undefined,
  ].filter((value) => value !== undefined);
  if (where.length === 0) return DESCRIPTION;
  return (
    `${DESCRIPTION} When the step is in your own ${targets.browser && targets.computer ? "browser or computer" : targets.browser ? "browser" : "computer"}, ` +
    `pass ${where.join(", or ")} (with \`open.url\` for the page): the person does it there, on the Mac or by ` +
    "finishing on the Mac from their phone, never in their own browser."
  );
}

export interface BotHandoffDeps {
  /** Where the step may be, for the description and the check. Left out: neither. */
  targets?: BotHandoffTargets;
}

interface HandoffParams {
  action: string;
  why?: string;
  open?: { url: string };
  target?: BotHandoffTarget;
}

/**
 * A card's `why` as the model wrote it, trimmed and without control or
 * direction marks; `undefined` when left out or blank. Shared with `sign_in`.
 */
export function handoffWhyOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("`why` must be text.");
  const why = withoutBotHandoffControls(value).trim();
  if (why && !isBoundedBotText(why, BOT_HANDOFF_WHY_MAX_CHARS)) {
    throw new Error(`Keep \`why\` under ${BOT_HANDOFF_WHY_MAX_CHARS} characters.`);
  }
  return why || undefined;
}

/** The model's arguments, checked again here: the harness's schema check cannot see https or blank text. */
function parseParams(params: unknown, targets: BotHandoffTargets): HandoffParams {
  const record = (params ?? {}) as { action?: unknown; why?: unknown; open?: unknown; where?: unknown };
  if (typeof record.action !== "string") throw new Error("A hand-off needs an action: the step the person should do.");
  const action = normalizeBotHandoffAction(record.action);
  if (!action) throw new Error("A hand-off needs an action: the step the person should do.");
  if (!isBoundedBotText(action, BOT_HANDOFF_ACTION_MAX_CHARS)) {
    throw new Error(`Keep the action under ${BOT_HANDOFF_ACTION_MAX_CHARS} characters.`);
  }
  const why = handoffWhyOf(record.why);
  let open: { url: string } | undefined;
  if (record.open !== undefined) {
    const url = (record.open as { url?: unknown } | null)?.url;
    // Checked again once normalized: percent-encoding can lengthen it.
    const href = typeof url === "string" && isBotHandoffOpenUrl(url) ? new URL(url).href : undefined;
    if (href === undefined || !isBotHandoffOpenUrl(href)) {
      throw new Error("`open.url` must be an https:// web address without a user name or password.");
    }
    open = { url: href };
  }
  let target: BotHandoffTarget | undefined;
  if (record.where !== undefined) {
    if (record.where !== "browser" && record.where !== "computer") {
      throw new Error("`where` must be \"browser\" or \"computer\".");
    }
    if (!targets[record.where]) {
      throw new Error(
        record.where === "browser" ? "You have no browser to hand a step over in." : "You have no computer to hand a step over on.",
      );
    }
    target = record.where;
  }
  return {
    action,
    ...(why === undefined ? {} : { why }),
    ...(open === undefined ? {} : { open }),
    ...(target === undefined ? {} : { target }),
  };
}

export function botHandoffCandidate(botId: string, handoffs: BotHandoffs, deps: BotHandoffDeps = {}): BotToolCandidate {
  const targets = deps.targets ?? { browser: false, computer: false };
  const schema: AgentTool = {
    name: BOT_HANDOFF_TOOL_NAME,
    label: "Hand Off",
    description: botHandoffDescription(targets),
    // One card at a time: a second hand-off in the same round waits for the first.
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.String({
        minLength: 1,
        maxLength: BOT_HANDOFF_ACTION_MAX_CHARS,
        description: "The step for the person, as a short imperative. Shown as the card's title.",
      }),
      why: Type.Optional(
        Type.String({ maxLength: BOT_HANDOFF_WHY_MAX_CHARS, description: "Why this step needs the person." }),
      ),
      open: Type.Optional(
        Type.Object({
          url: Type.String({
            maxLength: BOT_HANDOFF_URL_MAX_CHARS,
            description: "An https page the person can open to do the step.",
          }),
        }),
      ),
      ...(targets.browser || targets.computer
        ? {
            where: Type.Optional(
              Type.Union(
                [
                  ...(targets.browser ? [Type.Literal("browser")] : []),
                  ...(targets.computer ? [Type.Literal("computer")] : []),
                ],
                { description: "Set when the step is in your own browser or on your own computer." },
              ),
            ),
          }
        : {}),
    }),
    async execute(): Promise<AgentToolResult<null>> {
      throw new Error("A hand-off needs the Bot's conversation.");
    },
  };
  return {
    tool: schema,
    replay: "safe",
    interactive: true,
    bind: (call: BotToolCall): AgentTool => ({
      ...schema,
      async execute(_toolCallId, params): Promise<AgentToolResult<BotHandoffResultDetails>> {
        const { action, why, open, target } = parseParams(params, targets);
        const memo = await call.memo<{ waitId: string }>(BOT_HANDOFF_MEMO, { waitId: randomUUID() });
        const answer = await handoffs.request({
          botId,
          waitId: memo.waitId,
          toolCallId: call.callId,
          kind: "action",
          action,
          ...(why === undefined ? {} : { why }),
          ...(open === undefined ? {} : { open }),
          ...(target === undefined ? {} : { target }),
          source: "tool",
          signal: call.signal,
        });
        const text = answer.outcome === "done" ? handoffDoneText(action, answer.note) : handoffSkippedText(action, answer.note);
        return {
          content: [{ type: "text", text }],
          details: {
            kind: "action",
            outcome: answer.outcome,
            action,
            ...(answer.note === undefined ? {} : { note: answer.note }),
          },
        };
      },
    }),
  };
}
