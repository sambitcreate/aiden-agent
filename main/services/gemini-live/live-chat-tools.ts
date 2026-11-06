import type { FunctionDeclaration } from "@google/genai";
import type { AppSettings } from "../types.js";
import { geminiLiveEnabled } from "./feature-flag.js";
import {
  liveToolError,
  type LiveToolCall,
  type LiveToolContext,
  type LiveToolPrepareInput,
  type LiveToolProvider,
  type LiveToolResponse,
} from "./live-tools.js";
import {
  LIVE_CHAT_MAX_QUERY_CHARS,
  LIVE_CHAT_MAX_READ_MESSAGES,
  LIVE_CHAT_MAX_SEND_CHARS,
  LIVE_CHAT_MAX_WORKSPACE_CHARS,
  LIVE_CHAT_SEND_MODES,
  LIVE_CHAT_TOOL_NAMES,
  type LiveChatToolName,
} from "../../../renderer/shared/live-chat-tools.js";

/** Incident kill switch for Live's chat tools; any value but `1`/`true` turns them off. */
export const GEMINI_LIVE_CHAT_FLAG = "AIDEN_EXPERIMENTAL_GEMINI_LIVE_CHAT";

/**
 * Live's chat tools ship enabled with Live itself. They keep their own kill
 * switch, read the same way as `feature-flag.ts`, and never outlive the Live flag.
 */
export function geminiLiveChatToolsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!geminiLiveEnabled(environment)) return false;
  const rawValue = environment[GEMINI_LIVE_CHAT_FLAG];
  if (rawValue === undefined) return true;
  const value = rawValue.trim().toLowerCase();
  return value === "1" || value === "true";
}

const DECLARATIONS: readonly FunctionDeclaration[] = [
  {
    name: "read_open_chat",
    description:
      "Read the chat open in Aiden's main window: its title, whether it is working, and its latest messages (tool output summarised).",
    parametersJsonSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LIVE_CHAT_MAX_READ_MESSAGES,
          description: `How many recent messages to read, up to ${LIVE_CHAT_MAX_READ_MESSAGES}.`,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "send_to_open_chat",
    description:
      "Send a message to the chat open in Aiden's main window, as the user. auto sends now when the chat is idle and steers it when it is working; steer adds guidance to the running reply; queue sends it after the reply finishes.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: LIVE_CHAT_MAX_SEND_CHARS,
          description: "The message, in the user's own words.",
        },
        mode: { type: "string", enum: [...LIVE_CHAT_SEND_MODES] },
      },
      required: ["text", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_open_chat",
    description: "Stop the reply running in the open chat, like pressing Stop. Queued messages stay queued.",
    parametersJsonSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_and_open_chat",
    description:
      "Find a chat by its title and open it in the main window. When several chats match about equally, nothing opens and the closest titles come back so you can ask which one.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: LIVE_CHAT_MAX_QUERY_CHARS },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "start_new_chat",
    description:
      "Start a new chat in a workspace named by the user (or the current one) and open it. With text, also send that as the first message.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", minLength: 1, maxLength: LIVE_CHAT_MAX_WORKSPACE_CHARS },
        text: { type: "string", minLength: 1, maxLength: LIVE_CHAT_MAX_SEND_CHARS },
      },
      additionalProperties: false,
    },
  },
];

const INSTRUCTIONS: readonly string[] = [
  "You can work with the user's chats in Aiden: read_open_chat reads the chat on screen, send_to_open_chat sends a message to it, stop_open_chat stops its reply, find_and_open_chat opens another chat by title, and start_new_chat starts a new one.",
  "Ask before sending when you are not sure what the user wants sent. Keep messages you send in the user's own words; do not add your own instructions.",
  "Never say a message was sent, steered, queued or stopped until the tool result says so. If a tool fails, say so plainly.",
  "These tools never answer tool approvals. Short notes about chats you sent to may arrive while you talk; mention them briefly.",
];

function invalid(message: string): LiveToolResponse {
  return liveToolError("invalid_arguments", message);
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

/**
 * Validates Gemini's arguments into the exact shape the window expects. The
 * renderer validates again; nothing here is trusted to be well formed.
 */
export function validateLiveChatToolArgs(
  name: LiveChatToolName,
  args: Record<string, unknown>,
): { ok: true; args: Record<string, unknown> } | { ok: false; response: LiveToolResponse } {
  switch (name) {
    case "read_open_chat": {
      if (args.limit === undefined) return { ok: true, args: {} };
      const limit = args.limit;
      if (typeof limit !== "number" || !Number.isFinite(limit)) {
        return { ok: false, response: invalid("limit must be a number.") };
      }
      const clamped = Math.min(LIVE_CHAT_MAX_READ_MESSAGES, Math.max(1, Math.floor(limit)));
      return { ok: true, args: { limit: clamped } };
    }
    case "send_to_open_chat": {
      const text = boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
      if (!text) {
        return {
          ok: false,
          response: invalid(`text must be 1 to ${LIVE_CHAT_MAX_SEND_CHARS} characters.`),
        };
      }
      const mode = args.mode === undefined ? "auto" : args.mode;
      if (typeof mode !== "string" || !(LIVE_CHAT_SEND_MODES as readonly string[]).includes(mode)) {
        return { ok: false, response: invalid("mode must be auto, steer or queue.") };
      }
      return { ok: true, args: { text, mode } };
    }
    case "stop_open_chat":
      return { ok: true, args: {} };
    case "find_and_open_chat": {
      const query = boundedText(args.query, LIVE_CHAT_MAX_QUERY_CHARS);
      if (!query) return { ok: false, response: invalid("query must name the chat.") };
      return { ok: true, args: { query } };
    }
    case "start_new_chat": {
      const next: Record<string, unknown> = {};
      if (args.workspace !== undefined) {
        const workspace = boundedText(args.workspace, LIVE_CHAT_MAX_WORKSPACE_CHARS);
        if (!workspace) return { ok: false, response: invalid("workspace must be a workspace name.") };
        next.workspace = workspace;
      }
      if (args.text !== undefined) {
        const text = boundedText(args.text, LIVE_CHAT_MAX_SEND_CHARS);
        if (!text) {
          return {
            ok: false,
            response: invalid(`text must be 1 to ${LIVE_CHAT_MAX_SEND_CHARS} characters.`),
          };
        }
        next.text = text;
      }
      return { ok: true, args: next };
    }
  }
}

function isLiveChatToolName(name: string): name is LiveChatToolName {
  return (LIVE_CHAT_TOOL_NAMES as readonly string[]).includes(name);
}

/** Live's chat tools. Every call runs in the window that owns the chat on screen. */
export function createLiveChatToolProvider(input: Pick<LiveToolPrepareInput, "renderer">): LiveToolProvider {
  return {
    declarations: DECLARATIONS,
    instructions: INSTRUCTIONS,
    async handle(call: LiveToolCall, context: LiveToolContext): Promise<LiveToolResponse> {
      if (!isLiveChatToolName(call.name)) {
        return liveToolError("tool_unavailable", "That tool is not available in this Live session.");
      }
      const validated = validateLiveChatToolArgs(call.name, call.args ?? {});
      if (!validated.ok) return validated.response;
      return input.renderer.request(call.name, validated.args, context.signal);
    },
  };
}

/** The `LIVE_TOOL_PROVIDER_FACTORIES` entry: off with "Let Live use the open chat" or the kill switch. */
export function liveChatToolProviderFactory(
  input: LiveToolPrepareInput,
  settings: AppSettings,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): LiveToolProvider | null {
  if (settings.aidenLiveChatAccess === false) return null;
  if (!geminiLiveChatToolsEnabled(environment)) return null;
  return createLiveChatToolProvider(input);
}
