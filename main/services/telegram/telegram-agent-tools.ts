// Target-aware Telegram tools available only to Telegram-interactive Aiden generations.

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { getTelegramDirectRuntime } from "./telegram-direct-runtime.js";

function result(value: unknown): AgentToolResult<null> {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: null };
}

function runtime() {
  const value = getTelegramDirectRuntime();
  if (!value) throw new Error("Telegram direct delivery is unavailable.");
  return value;
}

const targetFields = {
  profile: Type.Optional(Type.String({ description: "Named Telegram bot profile; defaults to the active profile." })),
  thread: Type.Optional(Type.Union([
    Type.String({ description: "Case-insensitive live thread name." }),
    Type.Integer({ minimum: 1, description: "Live Telegram thread id." }),
  ])),
};

export function buildTelegramAgentTools(): AgentTool[] {
  return [
    {
      name: "telegram_help",
      label: "Telegram Help",
      description: "List paired Telegram profiles and their live thread targets before direct delivery.",
      parameters: Type.Object({}),
      execute: async () => {
        const profiles = await runtime().listProfiles();
        const targets = await Promise.all(profiles.map(async (profile) => ({
          profile: profile.name,
          paired: profile.settings.allowedUserId !== undefined,
          hasToken: profile.hasToken,
          targets: await runtime().listTargets(profile.name),
        })));
        return result({ profiles: targets });
      },
    },
    {
      name: "telegram_message",
      label: "Send Telegram Message",
      description: "Send an explicit Markdown message to the paired owner or another live thread target.",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }), ...targetFields }),
      execute: async (_id, params) => {
        const input = params as { text: string; profile?: string; thread?: string | number };
        await runtime().sendDirectMessage(input);
        return result({ delivered: true });
      },
    },
    {
      name: "telegram_attach",
      label: "Send Telegram File",
      description: "Send a regular file inside the destination target's authorized Aiden workspace.",
      parameters: Type.Object({ path: Type.String({ minLength: 1 }), caption: Type.Optional(Type.String()), ...targetFields }),
      execute: async (_id, params) => {
        const input = params as { path: string; caption?: string; profile?: string; thread?: string | number };
        await runtime().sendDirectAttachment(input);
        return result({ delivered: true });
      },
    },
    {
      name: "telegram_voice",
      label: "Send Telegram Voice",
      description: "Synthesize and send Telegram-native voice through a registered Aiden Telegram TTS provider.",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }), lang: Type.Optional(Type.String()), rate: Type.Optional(Type.String()), ...targetFields }),
      execute: async (_id, params) => {
        const input = params as { text: string; lang?: string; rate?: string; profile?: string; thread?: string | number };
        await runtime().sendDirectVoice(input);
        return result({ delivered: true });
      },
    },
  ];
}
