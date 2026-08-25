// Telegram-native operator controls.
//
// Owns the stable command catalog and pure inline-keyboard renderers. Runtime
// effects stay in telegram-service-core so this module remains a leaf in the
// Telegram domain DAG.

import type { TelegramBotCommand, TelegramInlineKeyboardMarkup } from "./telegram-bot-api.js";
import type { QueuedTelegramTurn } from "./telegram-queue.js";
import type { GenerationThinkingLevel } from "../../../renderer/shared/generation-thinking.js";
import {
  isModelHidden,
  type HiddenModelsByProvider,
} from "../../../renderer/shared/model-visibility.js";

export const TELEGRAM_COMMANDS = [
  { command: "start", description: "Open the Aiden operator menu" },
  { command: "compact", description: "Compact the current Aiden session" },
  { command: "next", description: "Stop this turn and run the next queued prompt" },
  { command: "continue", description: "Queue a continuation prompt" },
  { command: "abort", description: "Abort the active turn" },
  { command: "stop", description: "Abort the turn and clear the queue" },
  { command: "status", description: "Show runtime status and controls" },
  { command: "model", description: "Choose the Telegram model" },
  { command: "thinking", description: "Choose reasoning effort" },
  { command: "queue", description: "Inspect and manage queued prompts" },
  { command: "workspace", description: "Choose an Aiden workspace" },
  { command: "settings", description: "Open Telegram agent settings" },
  { command: "help", description: "Show Telegram agent help" },
] as const satisfies readonly TelegramBotCommand[];

export type TelegramControlCommand = (typeof TELEGRAM_COMMANDS)[number]["command"];

export interface TelegramModelChoice {
  providerId: string;
  providerLabel: string;
  model: string;
  modelLabel?: string;
  reasoning: boolean;
  thinkingLevels?: readonly GenerationThinkingLevel[];
}

export function visibleTelegramModelChoices(
  models: readonly TelegramModelChoice[],
  hiddenModelsByProvider: HiddenModelsByProvider | undefined,
): readonly TelegramModelChoice[] {
  return models.filter(
    (choice) => !isModelHidden(hiddenModelsByProvider, choice.providerId, choice.model),
  );
}

export interface TelegramControlStatus {
  botUsername?: string;
  allowedUserId?: number;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  thinkingLevel: GenerationThinkingLevel;
  queueCount: number;
  active: boolean;
  workspaceLabel: string;
  lastError?: string;
  extensionRows?: readonly string[];
  extensionSections?: readonly { label: string; callbackData: string }[];
}

export interface TelegramWorkspaceChoice {
  id: string;
  name: string;
  folderPath: string;
}

export function commandName(text: string): string {
  return (text.trim().split(/\s+/u)[0] ?? "").toLowerCase().split("@")[0] ?? "";
}

export function commandArgument(text: string): string {
  const separator = text.search(/\s/u);
  return separator === -1 ? "" : text.slice(separator).trim();
}

export function buildStatusText(status: TelegramControlStatus): string {
  return [
    "🤖 <b>Aiden Telegram Agent</b>",
    "",
    `<b>Bot:</b> @${escapeHtml(status.botUsername ?? "unknown")}`,
    `<b>Paired owner:</b> <code>${status.allowedUserId ?? "none"}</code>`,
    `<b>Status:</b> ${status.active ? "working" : "idle"}`,
    `<b>Model:</b> <code>${escapeHtml(status.providerLabel ?? status.providerId ?? "not configured")}/${escapeHtml(status.model ?? "—")}</code>`,
    `<b>Thinking:</b> <code>${status.thinkingLevel}</code>`,
    `<b>Queue:</b> ${status.queueCount}`,
    `<b>Workspace:</b> ${escapeHtml(status.workspaceLabel)}`,
    ...(status.lastError ? [`<b>Last error:</b> ${escapeHtml(status.lastError)}`] : []),
    ...(status.extensionRows ?? []).map((row) => escapeHtml(row)),
  ].join("\n");
}

export function buildMainMenu(status: TelegramControlStatus): TelegramInlineKeyboardMarkup {
  const active = status.providerLabel ?? status.providerId ?? "not configured";
  return {
    inline_keyboard: [
      [
        {
          text: `🤖 Model: ${truncate(`${active}/${status.model ?? "—"}`, 42)}`,
          callback_data: "menu:model",
        },
      ],
      [{ text: `🧠 Thinking: ${status.thinkingLevel}`, callback_data: "menu:thinking" }],
      [
        {
          text: `${status.queueCount ? "⏳" : "⌛"} Queue: ${status.queueCount}`,
          callback_data: "menu:queue",
        },
      ],
      [
        {
          text: `🗂 Workspace: ${truncate(status.workspaceLabel, 40)}`,
          callback_data: "menu:workspace",
        },
      ],
      [
        { text: "🗜 Compact", callback_data: "compact:ask" },
        { text: "⚙️ Settings", callback_data: "menu:settings" },
      ],
      ...(status.active
        ? [
            [
              { text: "⏭ Next", callback_data: "turn:next" },
              { text: "⏹ Abort", callback_data: "turn:abort" },
              { text: "🛑 Stop all", callback_data: "turn:stop" },
            ],
          ]
        : []),
      ...(status.extensionSections ?? []).map((section) => [
        {
          text: section.label,
          callback_data: section.callbackData,
        },
      ]),
    ],
  };
}

export function buildModelMenu(
  models: readonly TelegramModelChoice[],
  activeProviderId: string | undefined,
  activeModel: string | undefined,
  page: number,
  pageSize = 6,
): { text: string; markup: TelegramInlineKeyboardMarkup; page: number } {
  const totalPages = Math.max(1, Math.ceil(models.length / pageSize));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * pageSize;
  const rows = models.slice(start, start + pageSize).map((choice, offset) => {
    const selected = choice.providerId === activeProviderId && choice.model === activeModel;
    return [
      {
        text: `${selected ? "🟢" : "⚫"} ${truncate(`${choice.providerLabel}/${choice.modelLabel ?? choice.model}`, 48)}`,
        callback_data: `model:set:${start + offset}`,
      },
    ];
  });
  return {
    text: `<b>🤖 Choose a model</b>\n\n${models.length ? "The selected model is used for future Telegram turns." : "No configured models are available. Add a provider in Aiden Settings."}`,
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        ...(totalPages > 1
          ? [
              [
                { text: "⬅️", callback_data: `model:page:${Math.max(0, safePage - 1)}` },
                { text: `${safePage + 1}/${totalPages}`, callback_data: "noop" },
                {
                  text: "➡️",
                  callback_data: `model:page:${Math.min(totalPages - 1, safePage + 1)}`,
                },
              ],
            ]
          : []),
        ...rows,
      ],
    },
    page: safePage,
  };
}

export function buildThinkingMenu(
  current: GenerationThinkingLevel,
  supported: readonly GenerationThinkingLevel[],
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const levels = supported.length > 0 ? supported : (["off"] as const);
  return {
    text: "<b>🧠 Choose thinking level</b>\n\nApplies to future Telegram turns.",
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        ...levels.map((level) => [
          {
            text: `${level === current ? "🟢" : "⚫"} ${level}`,
            callback_data: `thinking:set:${level}`,
          },
        ]),
      ],
    },
  };
}

export function buildQueueMenu(items: readonly QueuedTelegramTurn[]): {
  text: string;
  markup: TelegramInlineKeyboardMarkup;
} {
  const rows = items.map((item, index) => [
    {
      text: `${index + 1}. ${item.lane === "priority" ? "⚡ " : ""}${truncate(item.text.replace(/\s+/gu, " "), 42)}`,
      callback_data: `queue:item:${item.id}`,
    },
  ]);
  return {
    text: items.length
      ? `<b>⏳ Queue</b>\n\n${items.length} prompt${items.length === 1 ? "" : "s"} waiting.`
      : "<b>⌛ Queue is empty</b>",
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        [{ text: "🌀 Refresh", callback_data: "menu:queue" }],
        ...rows,
        ...(items.length ? [[{ text: "🧹 Clear queue", callback_data: "queue:clear:ask" }]] : []),
      ],
    },
  };
}

export function buildQueueItemMenu(item: QueuedTelegramTurn): {
  text: string;
  markup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: `<b>Queued prompt</b>\n\n<pre>${escapeHtml(truncate(item.text, 3500))}</pre>`,
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Back", callback_data: "menu:queue" }],
        [
          {
            text: item.lane === "priority" ? "🟡 Priority" : "⚡ Make priority",
            callback_data: `queue:priority:${item.id}`,
          },
          { text: "🗑 Delete", callback_data: `queue:delete:${item.id}` },
        ],
      ],
    },
  };
}

export function confirmationMenu(
  title: string,
  confirmData: string,
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  return {
    text: `<b>${escapeHtml(title)}</b>`,
    markup: {
      inline_keyboard: [
        [
          { text: "✅ Confirm", callback_data: confirmData },
          { text: "❌ Cancel", callback_data: "menu:back" },
        ],
      ],
    },
  };
}

export function buildSettingsMenu(
  options: {
    draftPreviews?: boolean;
    activity?: "quiet" | "thinking" | "tools" | "verbose";
    rendering?: "rich" | "html";
    voiceMode?: "hidden" | "mirror" | "always";
  } = {},
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  return {
    text: [
      "<b>⚙️ Telegram agent settings</b>",
      "",
      "Runtime ownership, credentials, and high-risk permissions remain controlled by Aiden Settings.",
    ].join("\n"),
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        [{ text: "🤖 Model", callback_data: "menu:model" }],
        [{ text: "🧠 Thinking", callback_data: "menu:thinking" }],
        [{ text: "🗂 Workspace", callback_data: "menu:workspace" }],
        [
          {
            text: `${options.draftPreviews ? "🟢" : "⚫"} Draft previews`,
            callback_data: "settings:drafts:toggle",
          },
        ],
        [
          {
            text: `🔧 Activity: ${options.activity ?? "quiet"}`,
            callback_data: "settings:activity:next",
          },
        ],
        [
          {
            text: `📝 Rendering: ${options.rendering ?? "rich"}`,
            callback_data: "settings:rendering:toggle",
          },
        ],
        [
          {
            text: `👄 Voice: ${options.voiceMode ?? "hidden"}`,
            callback_data: "settings:voice:next",
          },
        ],
      ],
    },
  };
}

export function buildWorkspaceMenu(
  workspaces: readonly TelegramWorkspaceChoice[],
  selectedWorkspaceId: string | undefined,
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const selected = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  return {
    text: [
      "<b>🗂 Choose a workspace</b>",
      "",
      `Current: ${escapeHtml(selected?.name ?? (selectedWorkspaceId ? "Unavailable" : "Assistant only"))}`,
      "",
      ...workspaces.map(
        (workspace, index) =>
          `${index + 1}. ${escapeHtml(workspace.name)}\n   <code>${escapeHtml(workspace.folderPath)}</code>`,
      ),
      ...(workspaces.length
        ? ["", "You can also use <code>/workspace &lt;number&gt;</code>."]
        : []),
      "Workspace authority is captured when each prompt enters the queue.",
    ].join("\n"),
    markup: {
      inline_keyboard: [
        [{ text: "⬆️ Main menu", callback_data: "menu:back" }],
        [
          {
            text: `${selectedWorkspaceId === undefined ? "🟢" : "⚫"} Assistant only`,
            callback_data: "workspace:set:off",
          },
        ],
        ...workspaces.map((workspace, index) => [
          {
            text: `${workspace.id === selectedWorkspaceId ? "🟢" : "⚫"} ${truncate(workspace.name, 44)}`,
            callback_data: `workspace:set:${index}`,
          },
        ]),
      ],
    },
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}
