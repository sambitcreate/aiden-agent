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
import {
  cronFromScheduleDraft,
  formatSchedule,
  scheduleDraftFromCron,
  type ScheduledTaskCadence,
  type ScheduledTaskScheduleDraft,
} from "../lib/scheduled-task-view";
import type {
  McpServer,
  ScheduledTaskInput,
  ScheduledTaskMode,
  ScheduledTaskPermission,
  Workspace,
} from "../lib/types";

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

export function ScheduledTaskEditor({
  open,
  initial,
  workspaces,
  mcpServers,
  mcpServersUnavailable = false,
  assistantOwned = false,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initial: ScheduledTaskInput;
  workspaces: Workspace[];
  mcpServers: McpServer[];
  mcpServersUnavailable?: boolean;
  assistantOwned?: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: ScheduledTaskInput) => Promise<void>;
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
    if (!open || draft.mode !== "script") return;
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
  }, [draft.mode, draft.workspaceId, open]);

  const setMode = (mode: ScheduledTaskMode) => {
    setDraft((current) => ({
      ...current,
      mode,
      permission: mode === "script" ? "full" : current.permission,
      mcpServerIds: mode === "script" ? [] : current.mcpServerIds,
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
  const enabledMcpIds = new Set(
    mcpServers.filter((server) => server.enabled).map((server) => server.id),
  );
  const unavailableMcpIds = selectedMcpIds.filter((id) => !enabledMcpIds.has(id));
  const visibleMcpServers = [
    ...mcpServers.filter((server) => server.enabled || selectedMcpIds.includes(server.id)),
    ...unavailableMcpIds
      .filter((id) => !mcpServers.some((server) => server.id === id))
      .map((id) => ({ id, name: "Unavailable MCP server", enabled: false })),
  ];
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
  const valid =
    draft.name.trim() &&
    draft.cron.trim() &&
    draft.timezone?.trim() &&
    (draft.mode === "llm" ? draft.prompt?.trim() : draft.script?.trim()) &&
    !previewError &&
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

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft.id ? "Edit scheduled task" : "Create scheduled task"}
      description="Aiden runs this task on your Mac while the app is open."
      size="large"
      busy={busy}
      confirmLabel={reviewing ? (draft.id ? "Save task" : "Create task") : "Review task"}
      confirmDisabled={!valid}
      onConfirm={async () => {
        if (!reviewing) { setReviewing(true); return; }
        try { setSaveError(null); await onSave(draft); }
        catch (error) { setSaveError(error instanceof Error ? error.message : "Couldn’t save this task. Your choices are still here."); }
      }}
    >
      {reviewing ? (
        <FieldSet title="Review your task">
          <Field label={draft.name} description={formatSchedule(draft.cron, draft.timezone ?? localTimezone)}>
            <Button variant="transparent" size="small" onClick={() => setReviewing(false)}>Edit choices</Button>
          </Field>
          <Field label="What Aiden will do" orientation="vertical"><Text as="p">{draft.mode === "script" ? draft.script : draft.prompt}</Text></Field>
          <Field label="Access" orientation="vertical">
            <Text as="p">{draft.permission === "full" ? "Full access · Runs without asking you each time." : "Read-only · Can inspect information without making changes."}</Text>
            <Text as="p" color="secondary">{workspaces.find((workspace) => workspace.id === draft.workspaceId)?.name ?? "No selected workspace"} · {selectedMcpIds.length ? selectedMcpIds.map((id) => visibleMcpServers.find((server) => server.id === id)?.name ?? "Unavailable connection").join(", ") : "No connections"} · Web search {draft.webSearchEnabled ? "on" : "off"}</Text>
          </Field>
          <Field label="Keep this Mac awake" orientation="vertical"><Text as="p" color="secondary">Aiden must be open on this Mac for the task to run. Results appear in the task’s chat.</Text></Field>
          {saveError ? <Callout color="red" role="alert">{saveError}</Callout> : null}
        </FieldSet>
      ) : <>
      <FieldSet title="What should Aiden do?">
        <Field label="Name" description="A short label for the task and its dedicated chat.">
          <Input
            autoFocus
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
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
                radius="rounded"
                aria-pressed={draft.mode === "llm"}
                onClick={() => setMode("llm")}
              >
                Ask Aiden
              </Button>
              <Button
                size="small"
                variant={draft.mode === "script" ? "filled" : "transparent"}
                radius="rounded"
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
                      {minute === "00" ? "At the start of the hour" : `${minute} minutes past`}
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
              Keep a custom cron expression only when the repeat controls do not describe the
              schedule you need. Existing custom schedules are preserved until you change them.
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
      </FieldSet>
      <FieldSet title="Access and notifications">
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
              {workspaces.map((workspace) => (
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
            label="MCP tools"
            description="Choose the exact connected servers this automation may call unattended. MCP access requires Full permission."
            orientation="vertical"
          >
            {mcpServersUnavailable ? (
              <Callout color="red">
                <Text variant="small" color="secondary">
                  MCP servers could not be loaded. Retry from Settings before granting connector
                  access.
                </Text>
              </Callout>
            ) : visibleMcpServers.length === 0 ? (
              <Text variant="small" color="tertiary">
                No MCP servers are enabled. Connect one in Settings → Plugins.
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
                            Disabled or removed
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
              Choose either a workspace or MCP servers. Split combined work into separate tasks.
            </Text>
          </Callout>
        ) : null}
        {selectedMcpIds.length > 16 ? (
          <Callout color="red">
            <Text variant="small" color="secondary">
              Choose at most 16 MCP servers for one scheduled task.
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
                    ? `This task may call ${selectedMcpIds.length} selected MCP ${
                        selectedMcpIds.length === 1 ? "server" : "servers"
                      } unattended. MCP tools may read or change external data.`
                    : "Full tasks run edits and commands unattended. Use it only for a prompt you trust."}
              </Text>
            </Callout>
          </div>
        ) : null}
        <Field label="Notify after runs" description="Silent scripts never create a notification.">
          <div className="flex justify-end">
            <Switch
              checked={draft.notify ?? true}
              onCheckedChange={(notify) => setDraft((current) => ({ ...current, notify }))}
              aria-label="Notify after scheduled task runs"
            />
          </div>
        </Field>
      </FieldSet>
      </>}
    </Dialog>
  );
}
