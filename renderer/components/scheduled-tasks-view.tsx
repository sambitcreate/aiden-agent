import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CalendarClock,
  ChevronDown,
  CircleGauge,
  Clock3,
  FileClock,
  Folder,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  ScrollArea,
  Separator,
  Switch,
  Text,
  toast,
} from "./ui";
import { ScheduledTaskEditor } from "./scheduled-task-editor";
import { requestAssistantAutomationComposer } from "../lib/assistant-dock";
import { scheduleApi } from "../lib/ipc";
import {
  queryKeys,
  useMcpServers,
  useScheduledTasks,
  useScheduledTaskSettings,
} from "../lib/queries";
import {
  filterScheduledTasks,
  formatNextRun,
  formatSchedule,
  scheduledTaskStatus,
  type ScheduledTaskTab,
} from "../lib/scheduled-task-view";
import { useActiveWorkspace } from "../lib/workspace-context";
import type {
  McpServer,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSettings,
} from "../lib/types";

const TEMPLATES: Array<{
  name: string;
  description: string;
  cron: string;
  prompt: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    name: "Daily brief",
    description: "Summarize the workspace each weekday morning.",
    cron: "0 8 * * 1-5",
    prompt: "Summarize the important changes and open work in this workspace.",
    icon: CalendarClock,
  },
  {
    name: "Weekly review",
    description: "Review progress and risks every Friday afternoon.",
    cron: "0 16 * * 5",
    prompt: "Review this week's work, unresolved risks, and the best next actions.",
    icon: CircleGauge,
  },
  {
    name: "Follow-up monitor",
    description: "Check for noteworthy updates every weekday.",
    cron: "0 9 * * 1-5",
    prompt: "Check this workspace for noteworthy updates and alert me only when action is needed.",
    icon: FileClock,
  },
];

const TASK_TABS = ["all", "active", "paused"] as const;

function taskInput(task: ScheduledTask, mcpServers: McpServer[]): ScheduledTaskInput {
  return {
    id: task.id,
    name: task.name,
    enabled: task.enabled,
    mode: task.mode,
    cron: task.cron,
    timezone: task.timezone,
    workspaceId: task.workspaceId,
    providerId: task.providerId,
    model: task.model,
    prompt: task.prompt,
    script: task.script,
    permission: task.permission,
    mcpServerIds:
      task.mcpServerIds ??
      (task.mode === "llm" &&
      task.permission === "full" &&
      task.executionProfile === undefined &&
      !task.workspaceId
        ? mcpServers.filter((server) => server.enabled).map((server) => server.id)
        : []),
    webSearchEnabled: task.webSearchEnabled ?? false,
    notify: task.notify,
  };
}

function newTask(
  settings: ScheduledTaskSettings | undefined,
  workspaceId: string | undefined,
  mcpServers: McpServer[],
  template?: (typeof TEMPLATES)[number],
): ScheduledTaskInput {
  const mode = settings?.defaultMode ?? "llm";
  const permission = mode === "script" ? "full" : (settings?.defaultPermission ?? "read-only");
  return {
    name: template?.name ?? "",
    enabled: true,
    mode,
    cron: template?.cron ?? "0 9 * * 1-5",
    timezone:
      settings?.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    workspaceId,
    prompt: template?.prompt ?? "",
    script: "",
    permission,
    mcpServerIds:
      !workspaceId && mode === "llm" && permission === "full" && settings?.defaultMcpEnabled
        ? mcpServers.filter((server) => server.enabled).map((server) => server.id)
        : [],
    webSearchEnabled: false,
    notify: settings?.defaultNotify ?? true,
  };
}

function statusPresentation(task: ScheduledTask) {
  const status = scheduledTaskStatus(task);
  if (status === "error") return { label: "Needs attention", dot: "bg-red", badge: "red" };
  if (status === "paused") return { label: "Paused", dot: "bg-tertiary", badge: "gray" };
  return { label: "Active", dot: "bg-green", badge: "green" };
}

function usesLegacyInheritedMcp(task: ScheduledTask): boolean {
  return (
    task.mode === "llm" &&
    task.permission === "full" &&
    task.executionProfile === undefined &&
    task.mcpServerIds === undefined &&
    !task.workspaceId
  );
}

function ScheduledTaskDetail({
  task,
  workspaceName,
  busy,
  editDisabled,
  editDisabledReason,
  legacyMcpAccess,
  onClose,
  onEdit,
  onRun,
  onOpenChat,
  onToggle,
  onDelete,
}: {
  task: ScheduledTask;
  workspaceName: string;
  busy: boolean;
  editDisabled: boolean;
  editDisabledReason?: string;
  legacyMcpAccess: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRun: () => void;
  onOpenChat: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const status = statusPresentation(task);
  const cadence = formatSchedule(task.cron, task.timezone);
  return (
    <aside
      className="scheduled-task-detail sticky top-4 min-w-0 self-start overflow-hidden rounded-card bg-well"
      data-state="open"
      aria-label={`Details for ${task.name}`}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <Badge color={status.badge}>{status.label}</Badge>
        <span className="min-w-0 flex-1" />
        <Button variant="transparent" iconOnly aria-label="Close task details" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="px-4 pb-4">
        <Text as="h2" variant="heading1" className="break-words">
          {task.name}
        </Text>
        <Text as="p" variant="small" color="secondary" className="mt-1">
          {task.enabled ? `Next run ${formatNextRun(task.nextRunAt)}` : "Automatic runs are paused"}
        </Text>

        <div className="mt-4 rounded-control bg-background px-3 py-2.5">
          <Text variant="small" color="tertiary">
            {task.mode === "llm" ? "What Aiden will do" : "Script"}
          </Text>
          <Text as="p" variant="small" className="mt-1 whitespace-pre-wrap break-words">
            {task.mode === "llm" ? task.prompt : task.script}
          </Text>
        </div>

        <dl className="mt-4 divide-y divide-separator">
          <div className="flex items-start gap-3 py-3">
            <Clock3 className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-small text-tertiary">Schedule</dt>
              <dd className="mt-0.5 text-small text-primary">{cadence}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <Folder className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-small text-tertiary">Workspace</dt>
              <dd className="mt-0.5 truncate text-small text-primary">{workspaceName}</dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-small text-tertiary">Access</dt>
              <dd className="mt-0.5 text-small text-primary">
                {task.permission === "full" ? "Full access" : "Read-only"}
                {(task.mcpServerIds?.length ?? 0) > 0
                  ? ` · ${task.mcpServerIds?.length} MCP ${task.mcpServerIds?.length === 1 ? "server" : "servers"}`
                  : ""}
                {legacyMcpAccess ? " · All enabled MCP servers (legacy)" : ""}
                {task.webSearchEnabled ? " · Web Search" : ""}
              </dd>
            </div>
          </div>
          <div className="flex items-start gap-3 py-3">
            <Bell className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <dt className="text-small text-tertiary">Notifications</dt>
              <dd className="mt-0.5 text-small text-primary">
                {task.notify ? "After each completed run" : "Off"}
              </dd>
            </div>
          </div>
        </dl>

        {task.lastError ? (
          <Callout className="mb-3" color="red">
            <Text variant="small" color="secondary">
              {task.lastError}
            </Text>
          </Callout>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="accent"
            onClick={onEdit}
            disabled={busy || editDisabled}
            title={editDisabledReason}
          >
            Edit
          </Button>
          <Button onClick={onRun} disabled={busy}>
            <Play className="size-4" />
            Run now
          </Button>
          <Button onClick={onOpenChat} disabled={busy}>
            <MessageSquare className="size-4" />
            Open chat
          </Button>
          <Button onClick={onToggle} disabled={busy}>
            {task.enabled ? "Pause" : "Resume"}
          </Button>
        </div>
        {editDisabledReason ? (
          <Text as="p" variant="small" color="secondary" className="mt-2">
            {editDisabledReason}
          </Text>
        ) : null}
        <Button variant="destructive" className="mt-3 w-full" onClick={onDelete} disabled={busy}>
          <Trash2 className="size-4" />
          Delete task
        </Button>
      </div>
    </aside>
  );
}

export function ScheduledTasksView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeId, workspaces } = useActiveWorkspace();
  const tasks = useScheduledTasks();
  const settings = useScheduledTaskSettings();
  const mcpServers = useMcpServers();
  const [query, setQuery] = React.useState("");
  const [tab, setTab] = React.useState<ScheduledTaskTab>("all");
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState<ScheduledTaskInput | null>(null);
  const [editingUpdatedAt, setEditingUpdatedAt] = React.useState<number | undefined>();
  const [removing, setRemoving] = React.useState<ScheduledTask | null>(null);
  const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null);
  const [enablingAll, setEnablingAll] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const assistantHandoffRef = React.useRef(false);
  const visible = React.useMemo(
    () => filterScheduledTasks(tasks.data ?? [], query, tab),
    [query, tab, tasks.data],
  );
  const selectedTask = React.useMemo(
    () => tasks.data?.find((task) => task.id === selectedTaskId) ?? null,
    [selectedTaskId, tasks.data],
  );

  React.useEffect(() => {
    if (selectedTaskId && tasks.data && !tasks.data.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [selectedTaskId, tasks.data]);

  const refresh = async (taskId?: string) => {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks }),
      queryClient.invalidateQueries({ queryKey: queryKeys.chats }),
    ];
    if (taskId) {
      invalidations.push(
        queryClient.invalidateQueries({ queryKey: queryKeys.scheduledRuns(taskId) }),
      );
    }
    await Promise.all(invalidations);
  };

  const toggle = async (task: ScheduledTask, enabled: boolean) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      if (enabled) await scheduleApi.resume(task.id, task.updatedAt);
      else await scheduleApi.pause(task.id, task.updatedAt);
      await refresh(task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update this task.");
    } finally {
      setBusyTaskId(null);
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (busyTaskId) return;
    setBusyTaskId(task.id);
    try {
      const run = await scheduleApi.runNow(task.id, task.updatedAt);
      await refresh(task.id);
      if (run.result === "success") toast.success(`${task.name} finished.`);
      else if (run.result === "silent") toast.info(`${task.name} finished with no output.`);
      else toast.error(run.error ?? `${task.name} did not complete.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't run this task.");
    } finally {
      setBusyTaskId(null);
    }
  };

  const openChat = (task: ScheduledTask) => {
    if (!task.chatId) {
      toast.info("Run this task once to create its dedicated chat.");
      return;
    }
    void navigate({ to: "/chat/$chatId", params: { chatId: task.chatId } });
  };

  const globallyEnabled = settings.data?.enabled;
  const enableAll = async () => {
    if (enablingAll) return;
    setEnablingAll(true);
    try {
      const next = await scheduleApi.settings({ enabled: true });
      queryClient.setQueryData(queryKeys.scheduledSettings, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't enable scheduled tasks.");
    } finally {
      setEnablingAll(false);
    }
  };
  const manualCreationUnavailable =
    settings.isLoading ||
    settings.isError ||
    mcpServers.isLoading ||
    mcpServers.isError ||
    tasks.isError;
  return (
    <>
      <ScrollArea
        title="Scheduled tasks"
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="accent" onClick={() => requestAssistantAutomationComposer()}>
              <Sparkles className="size-4" />
              Create with Aiden
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="filled" iconOnly aria-label="More ways to create a scheduled task">
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-64"
                onCloseAutoFocus={(event) => {
                  if (!assistantHandoffRef.current) return;
                  assistantHandoffRef.current = false;
                  event.preventDefault();
                  requestAssistantAutomationComposer();
                }}
              >
                <DropdownMenuItem
                  onSelect={() => {
                    assistantHandoffRef.current = true;
                  }}
                >
                  <Sparkles className="size-4" />
                  Ask Aiden in chat
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={manualCreationUnavailable}
                  onSelect={() => {
                    setEditingUpdatedAt(undefined);
                    setEditing(newTask(settings.data, activeId, mcpServers.data ?? []));
                  }}
                >
                  <PencilLine className="size-4" />
                  Set up with controls
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      >
        <main className="mx-auto w-full max-w-6xl px-5 pb-10 pt-4">
          <div className="mb-5 flex items-start gap-3 rounded-card bg-well px-4 py-3.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-control text-secondary">
              <Sparkles className="size-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <Text variant="strong">Describe it in your own words</Text>
              <Text as="p" variant="small" color="secondary" className="mt-0.5 max-w-2xl">
                Ask Aiden in any chat to create, change, pause, or remove scheduled work. Aiden
                proposes the timing and access for you to review before anything is saved.
              </Text>
            </div>
            <Button
              size="small"
              onClick={() => requestAssistantAutomationComposer()}
              className="max-[720px]:hidden"
            >
              Ask Aiden
            </Button>
          </div>

          {tasks.isError || settings.isError ? (
            <Callout className="mb-4 flex-row items-center justify-between gap-4" color="red">
              <div>
                <Text variant="strong">Scheduled tasks are unavailable</Text>
                <Text as="p" variant="small" color="secondary" className="mt-0.5">
                  Aiden could not load the authoritative task state. Retry before making changes.
                </Text>
              </div>
              <Button
                size="small"
                onClick={() => void Promise.all([tasks.refetch(), settings.refetch()])}
              >
                Retry
              </Button>
            </Callout>
          ) : globallyEnabled === false ? (
            <Callout className="mb-4 flex-row items-center justify-between gap-4">
              <div>
                <Text variant="strong">Automatic runs are paused</Text>
                <Text as="p" variant="small" color="secondary" className="mt-0.5">
                  Your tasks are preserved. Turn them back on from Scheduled tasks settings.
                </Text>
              </div>
              <Button size="small" onClick={() => void enableAll()} disabled={enablingAll}>
                Turn on
              </Button>
            </Callout>
          ) : null}

          <div
            className={
              selectedTask
                ? "grid grid-cols-[minmax(0,1fr)_minmax(280px,340px)] items-start gap-5 max-[900px]:grid-cols-1"
                : "grid grid-cols-1"
            }
          >
            <div className="min-w-0">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <label className="relative min-w-[220px] flex-1">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tertiary"
                    aria-hidden="true"
                  />
                  <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search scheduled tasks"
                    aria-label="Search scheduled tasks"
                    className="pl-9"
                  />
                </label>
                <div
                  role="tablist"
                  aria-label="Scheduled task status"
                  className="flex rounded-control bg-control p-0.5"
                >
                  {TASK_TABS.map((value, index) => (
                    <Button
                      role="tab"
                      aria-selected={tab === value}
                      tabIndex={tab === value ? 0 : -1}
                      key={value}
                      size="small"
                      radius="rounded"
                      variant={tab === value ? "filled" : "transparent"}
                      onClick={() => setTab(value)}
                      onKeyDown={(event) => {
                        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                          return;
                        }
                        event.preventDefault();
                        const nextIndex =
                          event.key === "Home"
                            ? 0
                            : event.key === "End"
                              ? TASK_TABS.length - 1
                              : (index + (event.key === "ArrowRight" ? 1 : -1) + TASK_TABS.length) %
                                TASK_TABS.length;
                        setTab(TASK_TABS[nextIndex] ?? "all");
                        const tabs =
                          event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                            '[role="tab"]',
                          );
                        tabs?.[nextIndex]?.focus();
                      }}
                    >
                      {value === "all" ? "All" : value === "active" ? "Active" : "Paused"}
                    </Button>
                  ))}
                </div>
              </div>

              {tasks.isLoading ? (
                <div className="grid gap-px overflow-hidden rounded-card bg-separator">
                  {[0, 1, 2].map((row) => (
                    <div className="flex min-h-20 items-center gap-3 bg-well px-4 py-3" key={row}>
                      <span className="size-2 rounded-full bg-control" />
                      <span className="grid min-w-0 flex-1 gap-2">
                        <span className="h-3 w-40 rounded-full bg-control motion-safe:animate-pulse" />
                        <span className="h-2.5 w-56 max-w-full rounded-full bg-control motion-safe:animate-pulse" />
                      </span>
                    </div>
                  ))}
                </div>
              ) : tasks.isError ? null : visible.length === 0 ? (
                <div className="rounded-card bg-well">
                  <EmptyState
                    title={
                      query.trim() || tab !== "all" ? "No matching tasks" : "No scheduled tasks"
                    }
                    description={
                      query.trim() || tab !== "all"
                        ? "Try another search or status."
                        : "Ask Aiden in a chat, or start from a suggestion below."
                    }
                  />
                </div>
              ) : (
                <div className="overflow-hidden rounded-card bg-well">
                  {visible.map((task, index) => {
                    const status = statusPresentation(task);
                    const busy = busyTaskId === task.id;
                    const legacyMcpInventoryUnavailable =
                      usesLegacyInheritedMcp(task) && (mcpServers.isLoading || mcpServers.isError);
                    return (
                      <React.Fragment key={task.id}>
                        {index > 0 ? <Separator /> : null}
                        <div
                          className={`flex min-h-20 items-center gap-3 px-4 py-3 transition-colors duration-150 motion-reduce:transition-none ${
                            selectedTaskId === task.id ? "bg-list-selection" : "hover:bg-list-hover"
                          }`}
                        >
                          <span
                            className={`size-2 shrink-0 rounded-full ${status.dot}`}
                            aria-hidden="true"
                          />
                          <button
                            type="button"
                            aria-pressed={selectedTaskId === task.id}
                            className="min-w-0 flex-1 rounded-control text-left outline-none focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                            onClick={() => setSelectedTaskId(task.id)}
                          >
                            <span className="flex items-center gap-2">
                              <Text variant="strong" truncate>
                                {task.name}
                              </Text>
                              <Badge color={status.badge}>{status.label}</Badge>
                              {(task.mcpServerIds?.length ?? 0) > 0 ||
                              (task.mcpServerIds === undefined &&
                                task.permission === "full" &&
                                task.executionProfile === undefined &&
                                (mcpServers.data ?? []).some((server) => server.enabled)) ? (
                                <Badge>MCP</Badge>
                              ) : null}
                            </span>
                            <Text variant="small" color="secondary" truncate className="mt-1 block">
                              {formatSchedule(task.cron, task.timezone)}
                              {task.mode === "script" && task.script ? ` · ${task.script}` : ""}
                              {task.enabled
                                ? ` · Next run ${formatNextRun(task.nextRunAt)}`
                                : " · Automatic runs paused"}
                            </Text>
                            {task.lastError ? (
                              <Text variant="small" color="red" truncate className="mt-1 block">
                                {task.lastError}
                              </Text>
                            ) : null}
                          </button>
                          <Switch
                            checked={task.enabled}
                            onCheckedChange={(enabled) => void toggle(task, enabled)}
                            disabled={busy || Boolean(busyTaskId)}
                            aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.name}`}
                          />
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="transparent"
                                iconOnly
                                aria-label={`Actions for ${task.name}`}
                                disabled={busy}
                              >
                                <MoreHorizontal />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={legacyMcpInventoryUnavailable}
                                onSelect={() => {
                                  setEditingUpdatedAt(task.updatedAt);
                                  setEditing(taskInput(task, mcpServers.data ?? []));
                                }}
                              >
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void runNow(task)}>
                                <Play className="size-4" />
                                Run now
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => openChat(task)}>
                                <MessageSquare className="size-4" />
                                Open chat
                              </DropdownMenuItem>
                              <DropdownMenuItem onSelect={() => void toggle(task, !task.enabled)}>
                                {task.enabled ? "Pause" : "Resume"}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                color="red"
                                icon="trash"
                                onSelect={() => setRemoving(task)}
                              >
                                <Trash2 className="size-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}

              {tab === "all" && !query.trim() ? (
                <section className="mt-8" aria-labelledby="scheduled-suggestions">
                  <Text id="scheduled-suggestions" as="h2" variant="strong">
                    Suggestions
                  </Text>
                  <div className="mt-3 overflow-hidden rounded-card bg-well">
                    {TEMPLATES.map((template, index) => {
                      const Icon = template.icon;
                      return (
                        <React.Fragment key={template.name}>
                          {index > 0 ? <Separator /> : null}
                          <button
                            type="button"
                            disabled={manualCreationUnavailable}
                            onClick={() => {
                              setEditingUpdatedAt(undefined);
                              setEditing(
                                newTask(settings.data, activeId, mcpServers.data ?? [], template),
                              );
                            }}
                            className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none"
                          >
                            <span className="grid size-9 shrink-0 place-items-center rounded-control bg-control text-secondary">
                              <Icon className="size-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <Text variant="strong">{template.name}</Text>
                                <Badge>
                                  {formatSchedule(
                                    template.cron,
                                    settings.data?.defaultTimezone ??
                                      Intl.DateTimeFormat().resolvedOptions().timeZone ??
                                      "UTC",
                                  )}
                                </Badge>
                              </span>
                              <Text variant="small" color="secondary" className="mt-0.5 block">
                                {template.description}
                              </Text>
                            </span>
                          </button>
                        </React.Fragment>
                      );
                    })}
                  </div>
                </section>
              ) : null}
            </div>
            {selectedTask ? (
              <ScheduledTaskDetail
                task={selectedTask}
                workspaceName={
                  selectedTask.workspaceId
                    ? (workspaces.find((workspace) => workspace.id === selectedTask.workspaceId)
                        ?.name ?? "Unavailable workspace")
                    : "No workspace"
                }
                busy={Boolean(busyTaskId)}
                editDisabled={
                  usesLegacyInheritedMcp(selectedTask) &&
                  (mcpServers.isLoading || mcpServers.isError)
                }
                editDisabledReason={
                  usesLegacyInheritedMcp(selectedTask) &&
                  (mcpServers.isLoading || mcpServers.isError)
                    ? "MCP access could not be loaded. You can inspect and run this task, but editing is unavailable until access details load."
                    : undefined
                }
                legacyMcpAccess={usesLegacyInheritedMcp(selectedTask)}
                onClose={() => setSelectedTaskId(null)}
                onEdit={() => {
                  setEditingUpdatedAt(selectedTask.updatedAt);
                  setEditing(taskInput(selectedTask, mcpServers.data ?? []));
                }}
                onRun={() => void runNow(selectedTask)}
                onOpenChat={() => openChat(selectedTask)}
                onToggle={() => void toggle(selectedTask, !selectedTask.enabled)}
                onDelete={() => setRemoving(selectedTask)}
              />
            ) : null}
          </div>
        </main>
      </ScrollArea>

      {editing ? (
        <ScheduledTaskEditor
          open
          initial={editing}
          workspaces={workspaces}
          mcpServers={mcpServers.data ?? []}
          mcpServersUnavailable={mcpServers.isError}
          assistantOwned={Boolean(
            editing.id &&
            tasks.data?.some(
              (task) => task.id === editing.id && task.executionProfile === "assistant",
            ),
          )}
          busy={saving}
          onOpenChange={(open) => {
            if (!open && !saving) {
              setEditing(null);
              setEditingUpdatedAt(undefined);
            }
          }}
          onSave={async (input) => {
            setSaving(true);
            try {
              await scheduleApi.save(input, editingUpdatedAt);
              await refresh(input.id);
              setEditing(null);
              setEditingUpdatedAt(undefined);
              toast.success(input.id ? "Scheduled task updated." : "Scheduled task created.");
            } catch (error) {
              toast.error(error instanceof Error ? error.message : "Couldn't save this task.");
            } finally {
              setSaving(false);
            }
          }}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Delete this scheduled task?"
        description={
          removing ? `“${removing.name}” and its run history will be removed.` : undefined
        }
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await scheduleApi.remove(removing.id, removing.updatedAt);
            await refresh(removing.id);
            setSelectedTaskId((selected) => (selected === removing.id ? null : selected));
            setRemoving(null);
          } catch (error) {
            await refresh(removing.id);
            toast.error(error instanceof Error ? error.message : "Couldn't delete this task.");
          }
        }}
      />
    </>
  );
}
