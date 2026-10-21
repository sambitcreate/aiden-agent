// The durable `sign_in` tool for Bot turns (plan §5.2): the Bot asks the
// person to sign in to one site in its own browser, and waits for "I'm signed
// in" or Skip through `bot-handoffs.ts`. It is a hand-off card of
// `kind: "sign_in"`.
//
// - Site: normalized to a public `https://` origin (`sign-in-origin.ts`), so
//   the card names exactly what opens. The card's Open sign-in opens that
//   origin in a new tab of the Bot's browser, held for the person until the
//   card settles (`bot-browser-handoff.ts`); the Bot can't read or drive that
//   tab meanwhile, and never sees the password.
// - Waiting: the card's `waitId` is a memo of the tool task, so a Resume after
//   a quit or crash shows the same card under the same id.
// - Replay: `safe`. Its only effect is showing a card; the answer lands in the
//   one tool result the harness commits.
// - Stopped (Stop, Dismiss, delete): the wait rejects, so no answer is
//   recorded, and the tab is released.
// - Offered only with the Browser in the Bot's access, and never on routine
//   or Telegram turns (`bot-tool-policy.ts`): nobody could sign in there.
// - A Bot computer (`where: "computer"`) arrives with Bot computers; until
//   then that is an error result.

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  BOT_HANDOFF_ACTION_MAX_CHARS,
  BOT_HANDOFF_WHY_MAX_CHARS,
  BOT_SIGN_IN_TOOL_NAME,
  type BotHandoffResultDetails,
  type BotHandoffTarget,
} from "../../../renderer/shared/bot-handoffs.js";
import { normalizeSignInOrigin } from "../browser/sign-in-origin.js";
import { handoffSkippedText, signInDoneText } from "./bot-handoff-text.js";
import { handoffWhyOf } from "./bot-handoff-tool.js";
import type { BotHandoffs } from "./bot-handoffs.js";
import type { BotToolCandidate } from "./bot-tool-assembly.js";
import type { BotToolCall } from "./tool-adapter.js";

export const BOT_SIGN_IN_MEMO = "aiden.sign_in";
/** The longest site name the tool takes (a DNS name's limit). */
export const BOT_SIGN_IN_SITE_MAX_CHARS = 253;

const ACTION_PREFIX = "Sign in to ";

const DESCRIPTION =
  "Ask the person to sign in to one website for you, in your own browser, when a site you need asks for an " +
  "account. `site` is the site's name or https address (\"github.com\"); `why` says in a sentence why you need " +
  "it. The app shows a card: the person signs in in a new tab of your browser, which you can't see or use until " +
  "they finish, then answers I'm signed in or Skip. Their answer comes back as this tool's result: wait for it. " +
  "You never see or type their password, so never ask for it in the chat. Afterwards your browser has their " +
  "sign-in: call `browser` to find the tab they used, and check with browser_snapshot.";

export interface BotSignInDeps {
  /** The Bot's name, for what the tool tells it. */
  botName?(botId: string): Promise<string | undefined>;
  /**
   * Whether the Bot has a computer to sign in on (Bot computers). Without it,
   * `where: "computer"` is an error result.
   */
  hasComputer?(botId: string): Promise<boolean>;
}

interface SignInParams {
  origin: string;
  host: string;
  why?: string;
  target: BotHandoffTarget;
}

/** The model's arguments, checked again here: the harness's schema check cannot see https or a local address. */
function parseParams(params: unknown): SignInParams {
  const record = (params ?? {}) as { site?: unknown; why?: unknown; where?: unknown };
  if (typeof record.site !== "string" || !record.site.trim()) {
    throw new Error("A sign-in needs a site: the name of the website, like github.com.");
  }
  if ([...record.site.trim()].length > BOT_SIGN_IN_SITE_MAX_CHARS) {
    throw new Error(`Name the site, like github.com, in under ${BOT_SIGN_IN_SITE_MAX_CHARS} characters.`);
  }
  // Throws "Use an https site name like github.com." for anything else.
  const origin = normalizeSignInOrigin(record.site);
  const host = new URL(origin).host;
  if ([...`${ACTION_PREFIX}${host}`].length > BOT_HANDOFF_ACTION_MAX_CHARS) {
    throw new Error("That site name is too long to show on a card. Use the site's main address.");
  }
  if (record.where !== undefined && record.where !== "browser" && record.where !== "computer") {
    throw new Error("`where` must be \"browser\" or \"computer\".");
  }
  const why = handoffWhyOf(record.why);
  return {
    origin,
    host,
    ...(why === undefined ? {} : { why }),
    target: record.where === "computer" ? "computer" : "browser",
  };
}

export function signInCandidate(botId: string, handoffs: BotHandoffs, deps: BotSignInDeps = {}): BotToolCandidate {
  const schema: AgentTool = {
    name: BOT_SIGN_IN_TOOL_NAME,
    label: "Sign In",
    description: DESCRIPTION,
    // One card at a time, with hand-offs too: a second card in the same round waits for the first.
    executionMode: "sequential",
    parameters: Type.Object({
      site: Type.String({
        minLength: 1,
        maxLength: BOT_SIGN_IN_SITE_MAX_CHARS,
        description: "The website to sign in to, as its name or https address, like github.com.",
      }),
      why: Type.Optional(
        Type.String({ maxLength: BOT_HANDOFF_WHY_MAX_CHARS, description: "Why you need the person signed in there." }),
      ),
      where: Type.Optional(
        Type.Union([Type.Literal("browser"), Type.Literal("computer")], {
          description: "Where the person signs in: your browser (the default), or your own computer once you have one.",
        }),
      ),
    }),
    async execute(): Promise<AgentToolResult<null>> {
      throw new Error("A sign-in needs the Bot's conversation.");
    },
  };
  return {
    tool: schema,
    replay: "safe",
    interactive: true,
    bind: (call: BotToolCall): AgentTool => ({
      ...schema,
      async execute(_toolCallId, params): Promise<AgentToolResult<BotHandoffResultDetails>> {
        const { origin, host, why, target } = parseParams(params);
        if (target === "computer" && (await deps.hasComputer?.(botId).catch(() => false)) !== true) {
          const name = (await deps.botName?.(botId).catch(() => undefined)) ?? "This Bot";
          throw new Error(`${name} has no computer to sign in on yet.`);
        }
        const action = `${ACTION_PREFIX}${host}`;
        const memo = await call.memo<{ waitId: string }>(BOT_SIGN_IN_MEMO, { waitId: randomUUID() });
        const answer = await handoffs.request({
          botId,
          waitId: memo.waitId,
          toolCallId: call.callId,
          kind: "sign_in",
          action,
          ...(why === undefined ? {} : { why }),
          open: { url: origin },
          origin,
          target,
          source: "tool",
          signal: call.signal,
        });
        const text =
          answer.outcome === "done" ? signInDoneText(origin, answer.note, target) : handoffSkippedText(action, answer.note);
        return {
          content: [{ type: "text", text }],
          details: {
            kind: "sign_in",
            outcome: answer.outcome,
            action,
            origin,
            ...(answer.note === undefined ? {} : { note: answer.note }),
          },
        };
      },
    }),
  };
}
