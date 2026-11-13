// The Bot's `update_bot` tool (plan §4.6). See `service.ts`.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/chord";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
} from "../../../renderer/shared/bots.js";
import { UPDATE_BOT_TOOL_NAME } from "../../../renderer/shared/bot-settings-changes.js";
import type { BotToolCandidate } from "../bot-runtime/bot-tool-assembly.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotSettingsChangeService } from "./service.js";
import { botRunStartedByOwner } from "../bot-runtime/bot-owner-request.js";

/**
 * Whether the person alone started the calling run: both the run's execution
 * scope and the call's own run inputs say so. A routine, an event, another
 * Bot, Telegram, a peer, a self-intro or a wake-up is not the person.
 */
export function updateBotOwnerStarted(
  scopeRequestIds: readonly (string | undefined)[] | undefined,
  runRequestIds: readonly (string | undefined)[] | undefined,
): boolean {
  return botRunStartedByOwner(scopeRequestIds) && (runRequestIds === undefined || botRunStartedByOwner(runRequestIds));
}

const DESCRIPTION = [
  "Read or change your own settings. Call with no fields to read them, with the models you can switch to.",
  "Change a setting only when the person asked for it in this chat, or when you have no job yet and the person just told you what to do (then write yourself a short description and first instructions).",
  "You can change: name, description, look (color, shape), instructions, dailyCheckIns, notifications (perDay, quietHours) and model (only one of the connected models this tool lists).",
  "You can't change access, tools, connections, other Bots, Bot messaging, the computer, approvals, hooks or spending: the person changes those in your settings.",
  "When the person didn't start this run, the change waits on a card for them to apply.",
].join(" ");

export function updateBotCandidate(
  botId: string,
  ports: {
    service: Pick<BotSettingsChangeService, "call">;
    /** Whether the person alone started the calling run. */
    ownerStarted(call: BotToolCall): Promise<boolean>;
  },
): BotToolCandidate {
  const build = (call?: BotToolCall): AgentTool => ({
    name: UPDATE_BOT_TOOL_NAME,
    label: "Update settings",
    description: DESCRIPTION,
    parameters: Type.Object(
      {
        name: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        look: Type.Optional(Type.Object({
          color: Type.Optional(Type.Union(BOT_AVATAR_COLORS.map((color) => Type.Literal(color)))),
          shape: Type.Optional(Type.Union(BOT_AVATAR_SHAPES.map((shape) => Type.Literal(shape)))),
        }, { additionalProperties: false })),
        instructions: Type.Optional(Type.String()),
        dailyCheckIns: Type.Optional(Type.Boolean()),
        notifications: Type.Optional(Type.Object({
          perDay: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
          quietHours: Type.Optional(Type.Object({
            enabled: Type.Optional(Type.Boolean()),
            start: Type.Optional(Type.String()),
            end: Type.Optional(Type.String()),
          }, { additionalProperties: false })),
        }, { additionalProperties: false })),
        model: Type.Optional(Type.Object({ providerId: Type.String(), modelId: Type.String() }, { additionalProperties: false })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, input) {
      if (!call) throw new Error("update_bot needs its calling Bot conversation.");
      const owner = await ports.ownerStarted(call);
      call.signal.throwIfAborted();
      const text = await ports.service.call(botId, input, {
        owner,
        append: (kind, data) => call.appendEntry(kind, data as JsonValue),
      });
      return { content: [{ type: "text", text }], details: null };
    },
  });
  // Unsafe to replay: a change applies once, so an interrupted call is never run again.
  return { tool: build(), replay: "unsafe", bind: (call) => build(call) };
}
