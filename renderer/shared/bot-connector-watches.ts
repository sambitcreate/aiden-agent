/** Person-facing connector watch contract; private bindings/tool arguments stay on the host. */
export type BotConnectorWatchTemplateId = "mail_messages" | "calendar_upcoming";
export type BotConnectorWatchInterval = 15 | 30 | 60;
export type BotConnectorWatchCondition =
  | { kind: "email"; sender?: string; subject?: string; unreadOnly: boolean }
  | { kind: "calendar"; lookAheadMinutes: number; timezone: string };

export interface BotConnectorWatchTemplate {
  id: BotConnectorWatchTemplateId;
  title: string;
  description: string;
  kind: BotConnectorWatchCondition["kind"];
  available: boolean;
  unavailableReason?: string;
  intervals: readonly BotConnectorWatchInterval[];
}

export interface BotConnectorWatchSourceChoice {
  /** Opaque host-minted option; never a provider account/tool identifier. */
  id: string;
  templateId: BotConnectorWatchTemplateId;
  providerLabel: string;
  accountLabel: string;
  resourceLabel: string;
  available: boolean;
  unavailableReason?: string;
}

export interface BotConnectorWatchView {
  id: string;
  botId: string;
  revision: string;
  name: string;
  prompt: string;
  templateId: BotConnectorWatchTemplateId;
  condition: BotConnectorWatchCondition;
  everyMinutes: BotConnectorWatchInterval;
  source: Pick<BotConnectorWatchSourceChoice, "providerLabel" | "accountLabel" | "resourceLabel">;
  enabled: boolean;
  state: "waiting" | "empty" | "unchanged" | "changed" | "error" | "paused";
  lastCheckAt?: number;
  nextCheckAt?: number;
  lastRunAt?: number;
  lastError?: string;
}

export interface BotConnectorWatchList {
  supported: boolean;
  unavailableReason?: string;
  templates: BotConnectorWatchTemplate[];
  watches: BotConnectorWatchView[];
}

export interface BotConnectorWatchSourceList {
  choices: BotConnectorWatchSourceChoice[];
  /** Safe foreground repair guidance; never raw connector errors or credentials. */
  unavailableReasons: string[];
}

export interface BotConnectorWatchConfig {
  name: string;
  prompt: string;
  condition: BotConnectorWatchCondition;
  everyMinutes: BotConnectorWatchInterval;
}
export interface BotConnectorWatchCreateInput extends BotConnectorWatchConfig {
  botId: string;
  sourceChoiceId: string;
  mutationId: string;
}
export interface BotConnectorWatchIdentityInput {
  botId: string;
  id: string;
  expectedRevision: string;
  mutationId: string;
}
export interface BotConnectorWatchUpdateInput extends BotConnectorWatchIdentityInput, BotConnectorWatchConfig {
  /** Omit to retain the current privately bound source. */
  sourceChoiceId?: string;
}
export interface BotConnectorWatchEnableInput extends BotConnectorWatchIdentityInput { enabled: boolean }
export type BotConnectorWatchTestInput =
  | { botId: string; id: string; expectedRevision: string }
  | { botId: string; sourceChoiceId: string; condition: BotConnectorWatchCondition };
export interface BotConnectorWatchTestResult {
  checkedAt: number;
  result: "baseline" | "empty" | "unchanged" | "changed";
  itemCount: number;
  changeCount: number;
  /** Bounded data labels; this preview never advances the saved baseline or runs the Bot. */
  preview: string[];
}
export interface BotConnectorWatchRemoval { id: string; revision: string; removed: boolean }
export interface BotConnectorWatchRunResult { id: string; revision: string; admitted: boolean }

export const BOT_CONNECTOR_WATCH_CHANNELS = {
  list: "bots:connectorWatches:list",
  discoverSources: "bots:connectorWatches:discoverSources",
  create: "bots:connectorWatches:create",
  update: "bots:connectorWatches:update",
  setEnabled: "bots:connectorWatches:setEnabled",
  remove: "bots:connectorWatches:remove",
  testCheck: "bots:connectorWatches:testCheck",
  runNow: "bots:connectorWatches:runNow",
  changed: "bots:connectorWatches:changed",
} as const;

export const BOT_CONNECTOR_WATCH_TEMPLATES: readonly BotConnectorWatchTemplate[] = [
  { id: "mail_messages", kind: "email", title: "Mail messages", description: "Watch a selected local Mail mailbox for new messages and meaningful changes.", available: true, intervals: [15, 30, 60] },
  { id: "calendar_upcoming", kind: "calendar", title: "Upcoming calendar events", description: "Watch timed events entering an upcoming window.", available: false, unavailableReason: "This connector cannot safely bind an exact calendar account or report every recurrence and cancellation. Calendar watches are not available yet.", intervals: [15, 30, 60] },
];

export const BOT_CONNECTOR_WATCH_LIMITS = {
  watches: 16, sources: 500, templates: 2,
  nameChars: 120, promptChars: 32_768, labelChars: 500, errorChars: 200,
  filterChars: 200, timezoneChars: 100, previewItems: 8, previewChars: 500,
  lookAheadMinMinutes: 15, lookAheadMaxMinutes: 1_440,
} as const;

export interface BotConnectorWatchRejection {
  ok: false;
  code: "invalid_request" | "not_found" | "revision_conflict" | "idempotency_conflict" | "idempotency_capacity" | "capability_denied" | "unavailable";
  message: string;
  currentRevision?: string;
  current?: BotConnectorWatchView;
}
export type BotConnectorWatchReply<T> = T | BotConnectorWatchRejection;
