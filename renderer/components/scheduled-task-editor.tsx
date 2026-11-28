import * as React from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import {
  Button,
  Callout,
  Dialog,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Text,
  Textarea,
} from "./ui";
import { scheduleApi } from "../lib/ipc";
import { isUsable } from "../lib/model-picker-data";
import { resolveModelDisplay } from "../lib/model-display";
import { ProviderIcon } from "./provider-icon";
import { useProvidersModelInfo } from "../lib/queries";
import {
  cronFromScheduleDraft,
  formatSchedule,
  scheduleDraftFromCron,
  scheduledTaskProviderGuardrail,
  scheduledTaskProviderModelOptions,
  type ScheduledTaskCadence,
  type ScheduledTaskScheduleDraft,
} from "../lib/scheduled-task-view";
import { readModelSelection } from "../lib/use-model-selection";
import type { HiddenModelsByProvider } from "../shared/model-visibility";
import type {
  McpServer,
  Provider,
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  Workspace,
} from "../lib/types";
import { isAcpHarnessProvider } from "../shared/acp-harness";
import { mcpServerOffersTools } from "../shared/mcp-exposure";
import { isNoWorkspace } from "../lib/no-workspace";
import {
  SCHEDULED_TASK_CONNECTOR_INTERVALS,
  SCHEDULED_TASK_WATCH_INTERVALS,
  formatScheduledTaskTriggerLabel,
  type ScheduledTaskConnectorTrigger,
  type ScheduledTaskLinkTrigger,
  type ScheduledTaskWatchTrigger,
} from "../shared/scheduled-task-trigger";
import {
  BOT_CONNECTOR_WATCH_LIMITS,
  type BotConnectorWatchCondition,
  type BotConnectorWatchSourceList,
} from "../shared/bot-connector-watches";
import { formatBotWatchInterval, parseBotWatchUrl } from "../shared/bot-routine-trigger";

function upcomingLabel(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

const CADENCE_OPTIONS: Array<{ value: ScheduledTaskCadence; label: string }> = [
  { value: "minutes", label: "Every few minutes" },
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom schedule" },
];

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const APP_DEFAULT_PROVIDER_CHOICE = "__app_default__";
const NO_PROVIDERS: Provider[] = [];

/** The soft inline warning under the Provider select when an LLM task may not be able to run. */
/**
 * The connections the editor lists: every usable server plus each selected
 * one, including selections whose server is missing. A missing server is
 * named by its id so the person can tell which approval needs repair. A
 * server switched off for the model is usable by no schedule: it is listed
 * only when already selected, as unavailable with that reason.
 */
export function scheduledTaskMcpServerChoices(
  mcpServers: readonly Pick<McpServer, "id" | "name" | "enabled" | "exposure">[],
  selectedMcpIds: readonly string[],
): {
  unavailableMcpIds: string[];
  visibleMcpServers: Array<
    Pick<McpServer, "id" | "name" | "enabled"> & { unavailableReason?: string }
  >;
} {
  const usable = (server: Pick<McpServer, "enabled" | "exposure">) =>
    server.enabled && mcpServerOffersTools(server);
  const enabledMcpIds = new Set(mcpServers.filter(usable).map((server) => server.id));
  const unavailableMcpIds = selectedMcpIds.filter((id) => !enabledMcpIds.has(id));
  const visibleMcpServers = [
    ...mcpServers
      .filter((server) => usable(server) || selectedMcpIds.includes(server.id))
      .map(({ id, name, enabled, exposure }) =>
        enabled && !mcpServerOffersTools({ exposure })
          ? {
              id,
              name,
              enabled: false,
              unavailableReason: "Off for the model in Settings → Connectors",
            }
          : { id, name, enabled },
      ),
    ...unavailableMcpIds
      .filter((id) => !mcpServers.some((server) => server.id === id))
      .map((id) => ({ id, name: `Unavailable connector (${id})`, enabled: false })),
  ];
  return { unavailableMcpIds, visibleMcpServers };
}

export function ScheduledTaskProviderWarning({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <div
      className="mt-2 flex items-start gap-1.5 rounded-control bg-status-warning-surface px-2.5 py-1.5 text-small text-status-warning"
      role="status"
    >
      <span>{message}</span>
    </div>
  );
}

/** What a "When something changes" task checks, and how often. */
export function WatchTriggerFields({
  trigger,
  scripts,
  fullAccess,
  onChange,
}: {
  trigger: ScheduledTaskWatchTrigger;
  scripts: string[];
  fullAccess: boolean;
  onChange: (trigger: ScheduledTaskWatchTrigger) => void;
}) {
  const source = trigger.source;
  const urlInvalid =
    source.type === "url" && source.url.trim() !== "" && parseBotWatchUrl(source.url) === undefined;
  const intervals = [
    ...new Set<number>([...SCHEDULED_TASK_WATCH_INTERVALS, trigger.everyMinutes]),
  ].sort((a, b) => a - b);
  return (
    <>
      <Field
        label="Check"
        description="An address is fetched without your cookies or sign-ins. A script runs from the project's .aiden/scripts folder; it reports something by printing it."
      >
        <Select
          value={source.type}
          onValueChange={(type) =>
            onChange({
              ...trigger,
              source:
                type === "script"
                  ? { type: "script", script: scripts[0] ?? "" }
                  : { type: "url", url: "" },
            })
          }
        >
          <SelectTrigger aria-label="What the task checks">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="url">A web address</SelectItem>
            <SelectItem value="script">A project script</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {source.type === "url" ? (
        <Field label="Address" description="https, or http only on this computer.">
          <Input
            value={source.url}
            onChange={(event) =>
              onChange({ ...trigger, source: { type: "url", url: event.target.value } })
            }
            placeholder="https://example.com/status"
            aria-label="Address to watch"
            aria-invalid={urlInvalid}
          />
        </Field>
      ) : (
        <Field
          label="Script"
          description={
            fullAccess
              ? "It can keep notes between checks in the file named by AIDEN_CHECK_STATE (up to 8 KB)."
              : "A script watch runs unattended, so the task needs Full permission below."
          }
        >
          <Select
            value={source.script || undefined}
            onValueChange={(script) => onChange({ ...trigger, source: { type: "script", script } })}
          >
            <SelectTrigger aria-label="Script to run for each check">
              <SelectValue placeholder={scripts.length ? "Choose a script" : "No scripts found"} />
            </SelectTrigger>
            <SelectContent>
              {scripts.map((script) => (
                <SelectItem value={script} key={script}>
                  {script}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Field
        label="Check every"
        description="Runs at most once every 5 minutes and 48 times a day."
      >
        <Select
          value={String(trigger.everyMinutes)}
          onValueChange={(value) => onChange({ ...trigger, everyMinutes: Number(value) })}
        >
          <SelectTrigger aria-label="How often to check">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {intervals.map((minutes) => (
              <SelectItem value={String(minutes)} key={minutes}>
                {formatBotWatchInterval(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {source.type === "url" && urlInvalid ? (
        <Text role="alert" variant="small" color="red">
          Use an https address, or http only on this computer.
        </Text>
      ) : null}
    </>
  );
}

/** Names shown for a connected-app task until Find sources picks its source; main replaces them on save. */
const UNCHOSEN_SOURCE = {
  providerLabel: "Connected app",
  accountLabel: "Not chosen",
  resourceLabel: "Not chosen",
};

export function newConnectorTrigger(
  kind: BotConnectorWatchCondition["kind"] = "email",
): ScheduledTaskConnectorTrigger {
  return {
    kind: "connector",
    everyMinutes: 15,
    condition:
      kind === "email"
        ? { kind: "email", unreadOnly: false }
        : {
            kind: "calendar",
            lookAheadMinutes: 60,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          },
    source: { ...UNCHOSEN_SOURCE },
  };
}

/**
 * What a "When a connected app has news" task watches. Its source is chosen
 * with Find sources, which lists sources through connections already open in
 * Settings → Connectors; main keeps the exact source and never shows it here.
 */
export function ConnectorTriggerFields({
  trigger,
  savedKind,
  onChange,
  findSources = scheduleApi.findTriggerConnectorSources,
}: {
  trigger: ScheduledTaskConnectorTrigger;
  /** What the saved task already has a source for, if it watches a connected app. */
  savedKind?: BotConnectorWatchCondition["kind"];
  onChange: (trigger: ScheduledTaskConnectorTrigger) => void;
  findSources?: () => Promise<BotConnectorWatchSourceList>;
}) {
  const [sources, setSources] = React.useState<BotConnectorWatchSourceList | null>(null);
  const [finding, setFinding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const condition = trigger.condition;
  const templateId = condition.kind === "email" ? "mail_messages" : "calendar_upcoming";
  const choices =
    sources?.choices.filter((choice) => choice.templateId === templateId && choice.available) ?? [];
  const keepsSaved = !trigger.sourceChoiceId && savedKind === condition.kind;
  const limits = BOT_CONNECTOR_WATCH_LIMITS;
  const find = async () => {
    setFinding(true);
    setError(null);
    try {
      setSources(await findSources());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Aiden couldn't list sources.");
    } finally {
      setFinding(false);
    }
  };
  const setEmail = (patch: Partial<Extract<BotConnectorWatchCondition, { kind: "email" }>>) => {
    if (condition.kind !== "email") return;
    const next = { ...condition, ...patch };
    if (!next.sender) delete next.sender;
    if (!next.subject) delete next.subject;
    onChange({ ...trigger, condition: next });
  };
  const setCalendar = (
    patch: Partial<Extract<BotConnectorWatchCondition, { kind: "calendar" }>>,
  ) => {
    if (condition.kind === "calendar")
      onChange({ ...trigger, condition: { ...condition, ...patch } });
  };
  return (
    <>
      <Field
        label="Watch"
        description="Mail reads a mailbox through iMCP on a Mac. Calendar reads a calendar through Composio. Checks use only connections you already opened in Settings → Connectors and never sign in."
      >
        <Select
          value={condition.kind}
          onValueChange={(kind) => {
            if (kind === condition.kind) return;
            const next = newConnectorTrigger(kind as BotConnectorWatchCondition["kind"]);
            onChange({ ...next, everyMinutes: trigger.everyMinutes });
          }}
        >
          <SelectTrigger aria-label="What the task watches">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">New mail</SelectItem>
            <SelectItem value="calendar">Upcoming calendar events</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Source"
        description={
          trigger.sourceChoiceId || keepsSaved
            ? `${trigger.source.providerLabel} · ${trigger.source.accountLabel} · ${trigger.source.resourceLabel}`
            : "Not chosen yet."
        }
      >
        <Button size="small" variant="filled" disabled={finding} onClick={() => void find()}>
          {finding
            ? "Finding…"
            : keepsSaved || trigger.sourceChoiceId
              ? "Find a different source"
              : "Find sources"}
        </Button>
      </Field>
      {sources ? (
        <Field label="Connected source" orientation="vertical">
          {choices.length ? (
            <Select
              value={trigger.sourceChoiceId ?? ""}
              onValueChange={(id) => {
                const choice = choices.find((item) => item.id === id);
                if (choice)
                  onChange({
                    ...trigger,
                    sourceChoiceId: id,
                    source: {
                      providerLabel: choice.providerLabel,
                      accountLabel: choice.accountLabel,
                      resourceLabel: choice.resourceLabel,
                    },
                  });
              }}
            >
              <SelectTrigger aria-label="Connected source">
                <SelectValue placeholder="Choose a source" />
              </SelectTrigger>
              <SelectContent>
                {choices.map((choice) => (
                  <SelectItem value={choice.id} key={choice.id}>
                    {choice.providerLabel} · {choice.accountLabel} · {choice.resourceLabel}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Text variant="small" color="tertiary">
              No {condition.kind === "email" ? "mailboxes" : "calendars"} found. Open the connector
              in Settings → Connectors, then try again.
            </Text>
          )}
          {sources.unavailableReasons.map((reason, index) => (
            <Text key={index} variant="small" color="tertiary">
              {reason}
            </Text>
          ))}
        </Field>
      ) : null}
      {error ? (
        <Text role="alert" variant="small" color="red">
          {error}
        </Text>
      ) : null}
      {condition.kind === "email" ? (
        <>
          <Field label="From" description="Optional. Only mail whose sender contains this.">
            <Input
              value={condition.sender ?? ""}
              maxLength={limits.filterChars}
              onChange={(event) => setEmail({ sender: event.target.value })}
              placeholder="Anyone"
              aria-label="Sender contains"
            />
          </Field>
          <Field label="Subject contains" description="Optional.">
            <Input
              value={condition.subject ?? ""}
              maxLength={limits.filterChars}
              onChange={(event) => setEmail({ subject: event.target.value })}
              placeholder="Any subject"
              aria-label="Subject contains"
            />
          </Field>
          <Field label="Unread mail only">
            <Switch
              aria-label="Unread mail only"
              checked={condition.unreadOnly}
              onCheckedChange={(unreadOnly) => setEmail({ unreadOnly })}
            />
          </Field>
        </>
      ) : (
        <>
          <Field
            label="Look ahead"
            description={`Minutes, from ${limits.lookAheadMinMinutes} to ${limits.lookAheadMaxMinutes}.`}
          >
            <Input
              type="number"
              min={limits.lookAheadMinMinutes}
              max={limits.lookAheadMaxMinutes}
              value={condition.lookAheadMinutes}
              onChange={(event) => setCalendar({ lookAheadMinutes: Number(event.target.value) })}
              aria-label="Minutes to look ahead"
            />
          </Field>
          <Field label="Time zone">
            <Input
              value={condition.timezone}
              maxLength={limits.timezoneChars}
              onChange={(event) => setCalendar({ timezone: event.target.value })}
              aria-label="Calendar time zone"
            />
          </Field>
        </>
      )}
      <Field
        label="Check every"
        description="The first check only records what's there. The task runs from the next change on."
      >
        <Select
          value={String(trigger.everyMinutes)}
          onValueChange={(value) =>
            onChange({
              ...trigger,
              everyMinutes: Number(value) as ScheduledTaskConnectorTrigger["everyMinutes"],
            })
          }
        >
          <SelectTrigger aria-label="How often to check the connected app">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCHEDULED_TASK_CONNECTOR_INTERVALS.map((minutes) => (
              <SelectItem value={String(minutes)} key={minutes}>
                {formatBotWatchInterval(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </>
  );
}

/** Whether a connected-app trigger can be saved: it has a fresh choice, or keeps the saved task's source. */
export function connectorTriggerReady(
  trigger: ScheduledTaskConnectorTrigger,
  saved: ScheduledTaskInput["trigger"],
): boolean {
  const condition = trigger.condition;
  const filtersFit =
    condition.kind === "email"
      ? (condition.sender ?? "").length <= BOT_CONNECTOR_WATCH_LIMITS.filterChars &&
        (condition.subject ?? "").length <= BOT_CONNECTOR_WATCH_LIMITS.filterChars
      : Number.isSafeInteger(condition.lookAheadMinutes) &&
        condition.lookAheadMinutes >= BOT_CONNECTOR_WATCH_LIMITS.lookAheadMinMinutes &&
        condition.lookAheadMinutes <= BOT_CONNECTOR_WATCH_LIMITS.lookAheadMaxMinutes &&
        condition.timezone.trim() !== "";
  return (
    filtersFit &&
    (Boolean(trigger.sourceChoiceId) ||
      (saved?.kind === "connector" && saved.condition.kind === condition.kind))
  );
}

const LINK_GAPS = [1, 2, 5, 10, 15, 30, 60] as const;

/** `field = value` per line, for a link's filters. */
export function parseLinkFilterLines(text: string): Array<{ path: string; equals: string }> {
  return text.split("\n").flatMap((line) => {
    const at = line.indexOf("=");
    if (at < 1) return [];
    return [{ path: line.slice(0, at).trim(), equals: line.slice(at + 1).trim() }];
  });
}

/** How a "When its link is called" task treats calls. The link itself is made after saving. */
export function LinkTriggerFields({
  trigger,
  onChange,
}: {
  trigger: ScheduledTaskLinkTrigger;
  onChange: (trigger: ScheduledTaskLinkTrigger) => void;
}) {
  const [filterText, setFilterText] = React.useState(() =>
    (trigger.filters ?? []).map((filter) => `${filter.path} = ${filter.equals}`).join("\n"),
  );
  const [fieldsText, setFieldsText] = React.useState(() =>
    (trigger.includeFields ?? []).join(", "),
  );
  const set = (patch: Partial<ScheduledTaskLinkTrigger>) => {
    const next = { ...trigger, ...patch };
    for (const key of ["signatureHeader", "dedupePath"] as const) if (!next[key]) delete next[key];
    if (!next.filters?.length) delete next.filters;
    if (!next.includeFields?.length) delete next.includeFields;
    onChange(next);
  };
  const gaps = [...new Set<number>([...LINK_GAPS, trigger.gapMinutes])].sort((a, b) => a - b);
  return (
    <>
      <Field
        label="Link"
        description="After you save, the task's details give you a private link on Aiden On The Go's address to call with a POST. Calls work only while Aiden On The Go is on."
      >
        <Text variant="small" color="secondary">
          Made after saving
        </Text>
      </Field>
      <Field
        label="At most every"
        description="Calls that arrive sooner wait and run together, up to 20."
      >
        <Select
          value={String(trigger.gapMinutes)}
          onValueChange={(value) => set({ gapMinutes: Number(value) })}
        >
          <SelectTrigger aria-label="Shortest gap between runs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {gaps.map((minutes) => (
              <SelectItem value={String(minutes)} key={minutes}>
                {formatBotWatchInterval(minutes)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Only when"
        description="One field = value per line, from the JSON body (like action = opened). Calls that don't match are logged and ignored."
        orientation="vertical"
      >
        <Textarea
          value={filterText}
          rows={2}
          onChange={(event) => {
            setFilterText(event.target.value);
            set({ filters: parseLinkFilterLines(event.target.value) });
          }}
          placeholder="action = opened"
          aria-label="Filters for calls"
        />
      </Field>
      <Field
        label="Fields to pass"
        description="Comma-separated. Only these reach Aiden; empty passes the body, cut to 4,000 characters. Credential-looking values are always withheld."
      >
        <Input
          value={fieldsText}
          onChange={(event) => {
            setFieldsText(event.target.value);
            set({
              includeFields: event.target.value
                .split(",")
                .map((field) => field.trim())
                .filter(Boolean),
            });
          }}
          placeholder="pull_request.title, sender.login"
          aria-label="Fields to pass to Aiden"
        />
      </Field>
      <Field
        label="Same call when"
        description="Calls with the same value in this field count once."
      >
        <Input
          value={trigger.dedupePath ?? ""}
          onChange={(event) => set({ dedupePath: event.target.value.trim() })}
          placeholder="delivery.id"
          aria-label="Field that identifies a repeated call"
        />
      </Field>
      <Field
        label="Signature header"
        description="Optional. Calls must carry sha256=<HMAC of the body> in this header; you get the secret with the link."
      >
        <Input
          value={trigger.signatureHeader ?? ""}
          onChange={(event) => set({ signatureHeader: event.target.value.trim() })}
          placeholder="x-signature-256"
          aria-label="Header that carries the signature"
        />
      </Field>
    </>
  );
}

/** "Posts in <chat>" with Use its own chat: the binding a chat-made task carries. */
function PostsInField({
  chatTitle,
  onUseOwnChat,
}: {
  chatTitle: string;
  onUseOwnChat: () => Promise<void>;
}) {
  const [moving, setMoving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Field
      label={`Posts in ${chatTitle}`}
      description={
        error ??
        "Each run’s prompt and answer land in that chat. Use its own chat to keep runs in a chat of their own."
      }
    >
      <Button
        variant="filled"
        size="small"
        disabled={moving}
        onClick={() => {
          setMoving(true);
          setError(null);
          void onUseOwnChat()
            .catch((cause: unknown) =>
              setError(
                cause instanceof Error ? cause.message : "Couldn’t change where this task posts.",
              ),
            )
            .finally(() => setMoving(false));
        }}
      >
        Use its own chat
      </Button>
    </Field>
  );
}

export function ScheduledTaskEditor({
  open,
  initial,
  workspaces,
  mcpServers,
  mcpServersUnavailable = false,
  assistantOwned = false,
  busy,
  providers,
  hiddenModelsByProvider,
  lastProviderId,
  onOpenChange,
  onSave,
  postsIn,
}: {
  open: boolean;
  initial: ScheduledTaskInput;
  workspaces: Workspace[];
  mcpServers: McpServer[];
  mcpServersUnavailable?: boolean;
  assistantOwned?: boolean;
  providers: Provider[];
  hiddenModelsByProvider?: HiddenModelsByProvider;
  lastProviderId?: string;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: ScheduledTaskInput) => Promise<void>;
  /** The chat this task was made in and posts into; absent when it runs in its own chat. */
  postsIn?: { chatTitle: string; onUseOwnChat: () => Promise<void> };
}) {
  const [reviewing, setReviewing] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState(initial);
  const [scheduleDraft, setScheduleDraft] = React.useState(() =>
    scheduleDraftFromCron(initial.cron),
  );
  const [preview, setPreview] = React.useState<number[]>([]);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [scripts, setScripts] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setReviewing(false);
      setSaveError(null);
      setScheduleDraft(scheduleDraftFromCron(initial.cron));
      setDraft({
        ...initial,
        permission: initial.mode === "script" ? "full" : initial.permission,
        mcpServerIds: initial.mode === "llm" ? (initial.mcpServerIds ?? []) : [],
      });
    }
  }, [initial, open]);

  const updateSchedule = (
    update: (current: ScheduledTaskScheduleDraft) => ScheduledTaskScheduleDraft,
  ) => {
    let next = update(scheduleDraft);
    const cron = cronFromScheduleDraft(next);
    if (next.cadence !== "custom") next = { ...next, customCron: cron };
    setScheduleDraft(next);
    setDraft((task) => ({ ...task, cron }));
  };

  React.useEffect(() => {
    if (!open || !draft.cron.trim() || !draft.timezone?.trim()) {
      setPreview([]);
      setPreviewError(null);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void scheduleApi
        .preview(draft.cron, draft.timezone as string, 3)
        .then((runs) => {
          if (!active) return;
          setPreview(runs);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreview([]);
          setPreviewError(error instanceof Error ? error.message : "Invalid schedule.");
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draft.cron, draft.timezone, open]);

  React.useEffect(() => {
    const watchesScript = draft.trigger?.kind === "watch" && draft.trigger.source.type === "script";
    if (!open || (draft.mode !== "script" && !watchesScript)) return;
    let active = true;
    void scheduleApi
      .scripts(draft.workspaceId)
      .then((next) => {
        if (active) setScripts(next);
      })
      .catch(() => {
        if (active) setScripts([]);
      });
    return () => {
      active = false;
    };
  }, [draft.mode, draft.trigger, draft.workspaceId, open]);

  const setMode = (mode: ScheduledTaskMode) => {
    setDraft((current) => ({
      ...current,
      mode,
      permission: mode === "script" ? "full" : current.permission,
      mcpServerIds: mode === "script" ? [] : current.mcpServerIds,
      // Only "Ask Aiden" tasks run when something changes.
      ...(mode === "script" && current.trigger
        ? { trigger: initial.trigger ? null : undefined }
        : {}),
    }));
  };
  const setPermission = (permission: ScheduledTaskPermission) => {
    setDraft((current) => ({
      ...current,
      permission,
      mcpServerIds: permission === "read-only" ? [] : current.mcpServerIds,
    }));
  };
  const selectedMcpIds = draft.mcpServerIds ?? [];
  const { unavailableMcpIds, visibleMcpServers } = scheduledTaskMcpServerChoices(
    mcpServers,
    selectedMcpIds,
  );
  const toggleMcpServer = (id: string, enabled: boolean) => {
    setDraft((current) => {
      const ids = new Set(current.mcpServerIds ?? []);
      if (enabled) ids.add(id);
      else ids.delete(id);
      return {
        ...current,
        permission: enabled ? "full" : current.permission,
        workspaceId: enabled ? undefined : current.workspaceId,
        mcpServerIds: [...ids],
      };
    });
  };
  const trigger = draft.trigger ?? undefined;
  const triggerValid =
    !trigger ||
    (draft.mode === "llm" &&
      (trigger.kind === "webhook" ||
        (trigger.kind === "connector" && connectorTriggerReady(trigger, initial.trigger)) ||
        (trigger.kind === "watch" &&
          (trigger.source.type === "url"
            ? parseBotWatchUrl(trigger.source.url) !== undefined
            : Boolean(trigger.source.script) && draft.permission === "full"))));
  const valid =
    draft.name.trim() &&
    (trigger ? triggerValid : draft.cron.trim() && draft.timezone?.trim() && !previewError) &&
    (draft.mode === "llm" ? draft.prompt?.trim() : draft.script?.trim()) &&
    selectedMcpIds.length <= 16 &&
    !(draft.workspaceId && selectedMcpIds.length > 0) &&
    (!selectedMcpIds.length || (!mcpServersUnavailable && unavailableMcpIds.length === 0)) &&
    (!assistantOwned ||
      (draft.mode === "llm" &&
        draft.workspaceId === initial.workspaceId &&
        draft.permission === initial.permission &&
        draft.webSearchEnabled === initial.webSearchEnabled &&
        JSON.stringify(selectedMcpIds) === JSON.stringify(initial.mcpServerIds ?? [])));
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const timezoneOptions = React.useMemo(() => {
    let supported: string[] = [];
    try {
      const supportedValuesOf = (
        Intl as typeof Intl & {
          supportedValuesOf?: (key: "timeZone") => string[];
        }
      ).supportedValuesOf;
      supported = supportedValuesOf?.("timeZone") ?? [];
    } catch {
      // Older runtimes still retain the current, saved, and UTC choices below.
    }
    return [...new Set([localTimezone, draft.timezone ?? localTimezone, "UTC", ...supported])];
  }, [draft.timezone, localTimezone]);

  // Agent harnesses need someone watching to answer approvals; schedules run unattended.
  const usableProviders = providers.filter(
    (provider) => isUsable(provider) && !isAcpHarnessProvider(provider.id),
  );
  const pinnedProvider = usableProviders.find((provider) => provider.id === draft.providerId);
  // The same cached model names the chat model picker shows.
  const pinnedModelInfo = useProvidersModelInfo(pinnedProvider ? [pinnedProvider] : NO_PROVIDERS)
    .data[pinnedProvider?.id ?? ""];
  const providerModelOptions = pinnedProvider
    ? scheduledTaskProviderModelOptions(
        pinnedProvider,
        hiddenModelsByProvider,
        draft.model,
        readModelSelection().model,
      )
    : undefined;
  const providerGuardrail = scheduledTaskProviderGuardrail(
    draft.mode,
    draft.providerId,
    lastProviderId,
    providers,
  );
  const chooseProvider = (choice: string) => {
    if (choice === APP_DEFAULT_PROVIDER_CHOICE) {
      setDraft((current) => ({ ...current, providerId: undefined, model: undefined }));
      return;
    }
    const provider = usableProviders.find((candidate) => candidate.id === choice);
    if (!provider) return;
    setDraft((current) => {
      // A pinned model only stays pinned when the provider is unchanged; a
      // hidden pinned model survives re-selecting its own provider but a stale
      // model from another provider must not leak into the new one.
      const { model } = scheduledTaskProviderModelOptions(
        provider,
        hiddenModelsByProvider,
        current.providerId === provider.id ? current.model : undefined,
        readModelSelection().model,
      );
      return { ...current, providerId: provider.id, model };
    });
  };
  const chooseModel = (model: string) => setDraft((current) => ({ ...current, model }));

  return (
    <Dialog
      submitOnEnter
      open={open}
      onOpenChange={onOpenChange}
      title={draft.id ? "Edit scheduled task" : "Create scheduled task"}
      description="Aiden runs this task on your device while the app is open."
      size="large"
      busy={busy}
      confirmLabel={reviewing ? (draft.id ? "Save task" : "Create task") : "Review task"}
      confirmDisabled={!valid}
      onConfirm={async () => {
        if (!reviewing) {
          setReviewing(true);
          return;
        }
        try {
          setSaveError(null);
          await onSave(draft);
        } catch (error) {
          setSaveError(
            error instanceof Error
              ? error.message
              : "Couldn’t save this task. Your choices are still here.",
          );
        }
      }}
    >
      {reviewing ? (
        <FieldSet title="Review your task">
          <Field
            label={draft.name}
            description={
              trigger
                ? formatScheduledTaskTriggerLabel(trigger)
                : formatSchedule(draft.cron, draft.timezone ?? localTimezone)
            }
          >
            <Button variant="transparent" size="small" onClick={() => setReviewing(false)}>
              Edit choices
            </Button>
          </Field>
          <Field label="What Aiden will do" orientation="vertical">
            <Text as="p">{draft.mode === "script" ? draft.script : draft.prompt}</Text>
          </Field>
          <Field label="Access" orientation="vertical">
            <Text as="p">
              {draft.permission === "full"
                ? "Full access · Runs without asking you each time."
                : "Read-only · Can inspect information without making changes."}
            </Text>
            <Text as="p" color="secondary">
              {workspaces.find((workspace) => workspace.id === draft.workspaceId)?.name ??
                "No selected workspace"}{" "}
              ·{" "}
              {selectedMcpIds.length
                ? selectedMcpIds
                    .map(
                      (id) =>
                        visibleMcpServers.find((server) => server.id === id)?.name ??
                        "Unavailable connection",
                    )
                    .join(", ")
                : "No connections"}{" "}
              · Web search {draft.webSearchEnabled ? "on" : "off"}
            </Text>
          </Field>
          <Field label="Keep this device awake" orientation="vertical">
            <Text as="p" color="secondary">
              Aiden must be open on this device for the task to run.{" "}
              {postsIn
                ? `Results appear in “${postsIn.chatTitle}”.`
                : "Results appear in the task’s chat."}
            </Text>
          </Field>
          {saveError ? (
            <Callout color="red" role="alert">
              {saveError}
            </Callout>
          ) : null}
        </FieldSet>
      ) : (
        <>
          <FieldSet title="What should Aiden do?">
            <Field label="Name" description="A short label for the task and its dedicated chat.">
              <Input
                autoFocus
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Daily repository brief"
              />
            </Field>
            <Field
              label="Mode"
              description="Ask Aiden with a prompt or run a local script without a model."
            >
              {assistantOwned ? (
                <Text variant="small-strong">Ask Aiden · locked by the approved automation</Text>
              ) : (
                <div className="grid grid-cols-2 rounded-control bg-control p-0.5">
                  <Button
                    size="small"
                    variant={draft.mode === "llm" ? "filled" : "transparent"}
                    aria-pressed={draft.mode === "llm"}
                    onClick={() => setMode("llm")}
                  >
                    Ask Aiden
                  </Button>
                  <Button
                    size="small"
                    variant={draft.mode === "script" ? "filled" : "transparent"}
                    aria-pressed={draft.mode === "script"}
                    onClick={() => setMode("script")}
                  >
                    Run script
                  </Button>
                </div>
              )}
            </Field>
            {draft.mode === "llm" ? (
              <Field
                label="Prompt"
                description="Each run is self-contained and is written to this task's dedicated chat."
                orientation="vertical"
              >
                <Textarea
                  value={draft.prompt ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, prompt: event.target.value }))
                  }
                  placeholder="Summarize unread Git changes and highlight anything risky."
                  className="min-h-28"
                />
              </Field>
            ) : (
              <Field
                label="Script"
                description="Choose a file from the workspace or global .aiden/scripts folder."
                orientation="vertical"
              >
                <Input
                  list="scheduled-script-options"
                  value={draft.script ?? ""}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, script: event.target.value }))
                  }
                  placeholder="daily-report.sh"
                />
                <datalist id="scheduled-script-options">
                  {scripts.map((script) => (
                    <option value={script} key={script} />
                  ))}
                </datalist>
                {scripts.length === 0 ? (
                  <Text variant="small" color="tertiary" className="mt-2 block">
                    No scripts found for this workspace. Add one under .aiden/scripts first.
                  </Text>
                ) : null}
              </Field>
            )}
          </FieldSet>
          <FieldSet title="When should it run?">
            {draft.mode === "llm" ? (
              <Field
                label="When"
                description={
                  trigger?.kind === "watch"
                    ? "Aiden checks on its own and runs the task only when something changed. A check never uses a model."
                    : trigger?.kind === "webhook"
                      ? "Another app or service calls the task's private link, and what it sends reaches Aiden as data."
                      : trigger?.kind === "connector"
                        ? "Aiden checks a mailbox or calendar on its own and runs the task when something new arrives. A check never uses a model."
                        : "Runs at the times you choose."
                }
              >
                <Select
                  disabled={assistantOwned}
                  value={trigger?.kind ?? "schedule"}
                  onValueChange={(value) =>
                    setDraft((current) => ({
                      ...current,
                      // Leaving a trigger task's trigger sends null so main removes it.
                      trigger:
                        value === "watch"
                          ? current.trigger?.kind === "watch"
                            ? current.trigger
                            : initial.trigger?.kind === "watch"
                              ? initial.trigger
                              : {
                                  kind: "watch",
                                  source: { type: "url", url: "" },
                                  everyMinutes: 15,
                                }
                          : value === "webhook"
                            ? current.trigger?.kind === "webhook"
                              ? current.trigger
                              : initial.trigger?.kind === "webhook"
                                ? initial.trigger
                                : { kind: "webhook", gapMinutes: 5 }
                            : value === "connector"
                              ? current.trigger?.kind === "connector"
                                ? current.trigger
                                : initial.trigger?.kind === "connector"
                                  ? initial.trigger
                                  : newConnectorTrigger()
                              : initial.trigger
                                ? null
                                : undefined,
                    }))
                  }
                >
                  <SelectTrigger aria-label="When the task runs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="schedule">On a schedule</SelectItem>
                    <SelectItem value="watch">When something changes</SelectItem>
                    <SelectItem value="webhook">When its link is called</SelectItem>
                    <SelectItem value="connector">When a connected app has news</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {trigger?.kind === "watch" ? (
              <WatchTriggerFields
                trigger={trigger}
                scripts={scripts}
                fullAccess={draft.permission === "full"}
                onChange={(next) => setDraft((current) => ({ ...current, trigger: next }))}
              />
            ) : trigger?.kind === "webhook" ? (
              <LinkTriggerFields
                trigger={trigger}
                onChange={(next) => setDraft((current) => ({ ...current, trigger: next }))}
              />
            ) : trigger?.kind === "connector" ? (
              <ConnectorTriggerFields
                trigger={trigger}
                savedKind={
                  initial.trigger?.kind === "connector" ? initial.trigger.condition.kind : undefined
                }
                onChange={(next) => setDraft((current) => ({ ...current, trigger: next }))}
              />
            ) : (
              <>
                <Field label="Repeat">
                  <Select
                    value={scheduleDraft.cadence}
                    onValueChange={(value) =>
                      updateSchedule((current) => ({
                        ...current,
                        cadence: value as ScheduledTaskCadence,
                      }))
                    }
                  >
                    <SelectTrigger aria-label="Scheduled task frequency">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CADENCE_OPTIONS.map((option) => (
                        <SelectItem value={option.value} key={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                {scheduleDraft.cadence === "minutes" ? (
                  <Field label="Interval" description="From 2 to 59 minutes.">
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={2}
                        max={59}
                        value={scheduleDraft.minuteInterval}
                        onChange={(event) => {
                          const minuteInterval = event.target.valueAsNumber;
                          if (!Number.isFinite(minuteInterval)) return;
                          updateSchedule((current) => ({ ...current, minuteInterval }));
                        }}
                        aria-label="Minutes between runs"
                        className="w-24"
                      />
                      <Text variant="small" color="secondary">
                        minutes
                      </Text>
                    </div>
                  </Field>
                ) : null}
                {scheduleDraft.cadence === "hourly" ? (
                  <Field label="Minute">
                    <Select
                      value={scheduleDraft.time.slice(3)}
                      onValueChange={(minute) =>
                        updateSchedule((current) => ({ ...current, time: `00:${minute}` }))
                      }
                    >
                      <SelectTrigger aria-label="Minute past each hour">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["00", "15", "30", "45", scheduleDraft.time.slice(3)]
                          .filter((minute, index, minutes) => minutes.indexOf(minute) === index)
                          .sort()
                          .map((minute) => (
                            <SelectItem value={minute} key={minute}>
                              {minute === "00"
                                ? "At the start of the hour"
                                : `${minute} minutes past`}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                {scheduleDraft.cadence === "weekly" ? (
                  <Field label="Day">
                    <Select
                      value={String(scheduleDraft.weekday)}
                      onValueChange={(weekday) =>
                        updateSchedule((current) => ({ ...current, weekday: Number(weekday) }))
                      }
                    >
                      <SelectTrigger aria-label="Day of week">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((weekday, index) => (
                          <SelectItem value={String(index)} key={weekday}>
                            {weekday}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                {scheduleDraft.cadence === "monthly" ? (
                  <Field label="Day of month">
                    <Select
                      value={String(scheduleDraft.monthDay)}
                      onValueChange={(monthDay) =>
                        updateSchedule((current) => ({ ...current, monthDay: Number(monthDay) }))
                      }
                    >
                      <SelectTrigger aria-label="Day of month">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                          <SelectItem value={String(day)} key={day}>
                            {day}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
                {(["daily", "weekdays", "weekly", "monthly"] as ScheduledTaskCadence[]).includes(
                  scheduleDraft.cadence,
                ) ? (
                  <Field label="Time">
                    <Input
                      type="time"
                      value={scheduleDraft.time}
                      onChange={(event) => {
                        if (!event.target.value) return;
                        updateSchedule((current) => ({ ...current, time: event.target.value }));
                      }}
                      aria-label="Scheduled task time"
                    />
                  </Field>
                ) : null}
                <Field label="Time zone">
                  <Select
                    value={draft.timezone ?? localTimezone}
                    onValueChange={(timezone) => setDraft((current) => ({ ...current, timezone }))}
                  >
                    <SelectTrigger aria-label="Scheduled task time zone">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {timezoneOptions.map((timezone) => (
                        <SelectItem value={timezone} key={timezone}>
                          {timezone === localTimezone ? `Local time · ${timezone}` : timezone}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field
                  label="Schedule"
                  description={formatSchedule(draft.cron, draft.timezone ?? localTimezone)}
                  orientation="vertical"
                >
                  <div className="grid gap-2">
                    {previewError ? (
                      <Text role="alert" variant="small" color="red">
                        {previewError}
                      </Text>
                    ) : preview.length > 0 ? (
                      <ol className="grid gap-1 text-small text-secondary">
                        {preview.map((timestamp) => (
                          <li key={timestamp}>{upcomingLabel(timestamp)}</li>
                        ))}
                      </ol>
                    ) : (
                      <Text variant="small" color="tertiary">
                        Choose a schedule to preview its next runs.
                      </Text>
                    )}
                  </div>
                </Field>
                <details className="group px-4 py-3">
                  <summary className="flex cursor-default list-none items-center gap-2 rounded-control text-small-strong text-secondary outline-none hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">
                    <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
                    Advanced schedule
                  </summary>
                  <div className="mt-3 grid gap-3 pl-6">
                    <Text variant="small" color="secondary">
                      Keep a custom cron expression only when the repeat controls do not describe
                      the schedule you need. Existing custom schedules are preserved until you
                      change them.
                    </Text>
                    <Input
                      value={scheduleDraft.customCron}
                      onChange={(event) => {
                        const customCron = event.target.value;
                        updateSchedule((current) => ({
                          ...current,
                          cadence: "custom",
                          customCron,
                        }));
                      }}
                      placeholder="0 9 * * 1-5"
                      aria-label="Custom cron schedule"
                      aria-invalid={scheduleDraft.cadence === "custom" && Boolean(previewError)}
                    />
                  </div>
                </details>
              </>
            )}
          </FieldSet>
          <FieldSet title="Run context">
            {draft.mode === "llm" ? (
              <Field label="Provider">
                <Select
                  disabled={assistantOwned}
                  value={draft.providerId ?? APP_DEFAULT_PROVIDER_CHOICE}
                  onValueChange={chooseProvider}
                >
                  <SelectTrigger aria-label="Scheduled task provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={APP_DEFAULT_PROVIDER_CHOICE}>
                      App default (follows your selection)
                    </SelectItem>
                    {usableProviders.map((provider) => (
                      <SelectItem value={provider.id} key={provider.id}>
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <ProviderIcon
                            providerId={provider.id}
                            providerLabel={provider.label}
                            artwork={provider.artwork}
                            className="size-4 text-secondary"
                          />
                          <span className="truncate">{provider.label}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <ScheduledTaskProviderWarning message={providerGuardrail} />
              </Field>
            ) : null}
            {pinnedProvider && providerModelOptions ? (
              <Field label="Model">
                <Select
                  disabled={assistantOwned}
                  value={providerModelOptions.model ?? ""}
                  onValueChange={chooseModel}
                >
                  <SelectTrigger aria-label="Scheduled task model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providerModelOptions.models.map((model) => {
                      const display = resolveModelDisplay(model, pinnedModelInfo?.[model]);
                      return (
                        <SelectItem value={model} key={model}>
                          <span className="inline-flex min-w-0 items-center gap-2">
                            <ProviderIcon
                              providerId={pinnedProvider.id}
                              providerLabel={pinnedProvider.label}
                              modelId={model}
                              artwork={pinnedProvider.artwork}
                              className="size-4 text-secondary"
                            />
                            <span className="truncate">{display.label}</span>
                            {display.format ? (
                              <span className="text-tertiary">{display.format}</span>
                            ) : null}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </FieldSet>
          <FieldSet title="Access and notifications">
            {postsIn ? (
              <PostsInField chatTitle={postsIn.chatTitle} onUseOwnChat={postsIn.onUseOwnChat} />
            ) : null}
            <Field
              label="Workspace"
              description="Paths are always re-resolved by Aiden when the task runs."
            >
              <Select
                disabled={assistantOwned}
                value={draft.workspaceId ?? "__none__"}
                onValueChange={(workspaceId) =>
                  setDraft((current) => ({
                    ...current,
                    workspaceId: workspaceId === "__none__" ? undefined : workspaceId,
                    mcpServerIds: workspaceId === "__none__" ? current.mcpServerIds : [],
                  }))
                }
              >
                <SelectTrigger aria-label="Scheduled task workspace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No workspace</SelectItem>
                  {workspaces
                    .filter(
                      (workspace) =>
                        !isNoWorkspace(workspace) || workspace.id === draft.workspaceId,
                    )
                    .map((workspace) => (
                      <SelectItem value={workspace.id} key={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
            {draft.mode === "llm" ? (
              <Field
                label="Permission"
                description="Read-only can inspect context. Full can edit files and run commands without asking."
              >
                <Select
                  disabled={assistantOwned}
                  value={draft.permission ?? "read-only"}
                  onValueChange={(value) => setPermission(value === "full" ? "full" : "read-only")}
                >
                  <SelectTrigger aria-label="Scheduled task permission">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read-only">Read-only</SelectItem>
                    <SelectItem value="full">Full</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <Field
                label="Permission"
                description="Scripts can change files or the system, so scheduled scripts always require Full access."
              >
                <Text variant="small-strong">Full</Text>
              </Field>
            )}
            {draft.mode === "llm" ? (
              <Field
                label="Web Search"
                description="Allow this task to search the public web unattended. Search queries may include task context."
              >
                <div className="flex justify-end">
                  <Switch
                    checked={draft.webSearchEnabled ?? false}
                    onCheckedChange={(webSearchEnabled) =>
                      setDraft((current) => ({ ...current, webSearchEnabled }))
                    }
                    disabled={assistantOwned}
                    aria-label="Allow Web Search for this scheduled task"
                  />
                </div>
              </Field>
            ) : null}
            {draft.mode === "llm" ? (
              <Field
                label="Connectors"
                description="Choose the exact connectors this automation may call unattended. Connector access requires Full permission."
                orientation="vertical"
              >
                {mcpServersUnavailable ? (
                  <Callout color="red">
                    <Text variant="small" color="secondary">
                      Connectors could not be loaded. Retry from Settings before granting connector
                      access.
                    </Text>
                  </Callout>
                ) : visibleMcpServers.length === 0 ? (
                  <Text variant="small" color="tertiary">
                    No connectors are enabled. Connect one in Settings → Connectors.
                  </Text>
                ) : (
                  <ul className="max-h-48 divide-y divide-separator overflow-y-auto rounded-control bg-background">
                    {visibleMcpServers.map((server) => {
                      const selected = selectedMcpIds.includes(server.id);
                      return (
                        <li className="flex min-h-11 items-center gap-3 px-3 py-2" key={server.id}>
                          <span className="min-w-0 flex-1">
                            <Text variant="small-strong" truncate>
                              {server.name}
                            </Text>
                            {!server.enabled ? (
                              <Text variant="small" color="red" className="mt-0.5 block">
                                {server.unavailableReason ?? "Disabled or removed"}
                              </Text>
                            ) : null}
                          </span>
                          <Switch
                            checked={selected}
                            onCheckedChange={(checked) => toggleMcpServer(server.id, checked)}
                            disabled={assistantOwned || (!server.enabled && !selected)}
                            aria-label={`${selected ? "Remove" : "Allow"} ${server.name} for this scheduled task`}
                          />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Field>
            ) : null}
            {assistantOwned ? (
              <Callout>
                <Text variant="small" color="secondary">
                  Project, permission, and connector scope were approved with Aiden Assistant. Edit
                  those fields through Aiden so the complete final scope can be confirmed again.
                </Text>
              </Callout>
            ) : null}
            {!assistantOwned && draft.workspaceId && selectedMcpIds.length > 0 ? (
              <Callout color="red">
                <Text variant="small" color="secondary">
                  Choose either a workspace or connectors. Split combined work into separate tasks.
                </Text>
              </Callout>
            ) : null}
            {selectedMcpIds.length > 16 ? (
              <Callout color="red">
                <Text variant="small" color="secondary">
                  Choose at most 16 connectors for one scheduled task.
                </Text>
              </Callout>
            ) : null}
            {draft.permission === "full" ? (
              <div className="px-4 pb-4">
                <Callout className="flex-row gap-2" color="red">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                  <Text variant="small" color="secondary">
                    {draft.mode === "script"
                      ? "Scripts run unattended with Full access. Only select a script you trust."
                      : selectedMcpIds.length > 0
                        ? `This task may call ${selectedMcpIds.length} selected ${
                            selectedMcpIds.length === 1 ? "connector" : "connectors"
                          } unattended. Connector tools may read or change external data.`
                        : "Full tasks run edits and commands unattended. Use it only for a prompt you trust."}
                  </Text>
                </Callout>
              </div>
            ) : null}
            <Field
              label="Notify after runs"
              description="Silent scripts never create a notification."
            >
              <div className="flex justify-end">
                <Switch
                  checked={draft.notify ?? true}
                  onCheckedChange={(notify) => setDraft((current) => ({ ...current, notify }))}
                  aria-label="Notify after scheduled task runs"
                />
              </div>
            </Field>
          </FieldSet>
        </>
      )}
    </Dialog>
  );
}
