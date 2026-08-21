import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  ChevronDown,
  CircleGauge,
  FileClock,
  MessageSquare,
  MoreHorizontal,
  PencilLine,
  Play,
  Search,
  Trash2,
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
      (task.mode === "llm" && task.permission === "full" && task.executionProfile === undefined
        ? mcpServers.filter((server) => server.enabled).map((server) => server.id)
        : []),
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
    notify: settings?.defaultNotify ?? true,
  };
}

function statusPresentation(task: ScheduledTask) {
  const status = scheduledTaskStatus(task);
  if (status === "error") return { label: "Needs attention", dot: "bg-red", badge: "red" };
  if (status === "paused") return { label: "Paused", dot: "bg-tertiary", badge: "gray" };
  return { label: "Active", dot: "bg-green", badge: "green" };
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
  const [editing, setEditing] = React.useState<ScheduledTaskInput | null>(null);
  const [removing, setRemoving] = React.useState<ScheduledTask | null>(null);
  const [busyTaskId, setBusyTaskId] = React.useState<string | null>(null);
  const [enablingAll, setEnablingAll] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const assistantHandoffRef = React.useRef(false);
  const visible = React.useMemo(
    () => filterScheduledTasks(tasks.data ?? [], query, tab),
    [query, tab, tasks.data],
  );

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
      if (enabled) await scheduleApi.resume(task.id);
      else await scheduleApi.pause(task.id);
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
      const run = await scheduleApi.runNow(task.id);
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
  const creationUnavailable =
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="accent" disabled={creationUnavailable}>
                Create
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
                <MessageSquare className="size-4" />
                Create with Aiden Assistant
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={creationUnavailable}
                onSelect={() => setEditing(newTask(settings.data, activeId, mcpServers.data ?? []))}
              >
                <PencilLine className="size-4" />
                Create manually
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <main className="mx-auto w-full max-w-4xl px-5 pb-10 pt-4">
          <div className="mb-5">
            <Text as="p" color="secondary" className="max-w-2xl">
              Ask Aiden to schedule recurring work, run trusted local scripts, or monitor for
              updates while the app is open.
            </Text>
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
              {(["all", "active", "paused"] as const).map((value) => (
                <Button
                  role="tab"
                  aria-selected={tab === value}
                  key={value}
                  size="small"
                  radius="rounded"
                  variant={tab === value ? "filled" : "transparent"}
                  onClick={() => setTab(value)}
                >
                  {value === "all" ? "All" : value === "active" ? "Active" : "Paused"}
                </Button>
              ))}
            </div>
          </div>

          {tasks.isLoading ? (
            <div className="rounded-card border border-separator p-5">
              <Text variant="small" color="secondary">
                Loading scheduled tasks…
              </Text>
            </div>
          ) : tasks.isError ? null : visible.length === 0 ? (
            <div className="rounded-card border border-separator">
              <EmptyState
                title={query.trim() || tab !== "all" ? "No matching tasks" : "No scheduled tasks"}
                description={
                  query.trim() || tab !== "all"
                    ? "Try another search or status."
                    : "Create a recurring task or start from a suggestion below."
                }
              />
            </div>
          ) : (
            <div className="rounded-card border border-separator">
              {visible.map((task, index) => {
                const status = statusPresentation(task);
                const busy = busyTaskId === task.id;
                const legacyMcpInventoryUnavailable =
                  task.mode === "llm" &&
                  task.permission === "full" &&
                  task.executionProfile === undefined &&
                  task.mcpServerIds === undefined &&
                  (mcpServers.isLoading || mcpServers.isError);
                return (
                  <React.Fragment key={task.id}>
                    {index > 0 ? <Separator /> : null}
                    <div className="flex min-h-20 items-center gap-3 px-4 py-3">
                      <span
                        className={`size-2 shrink-0 rounded-full ${status.dot}`}
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        disabled={legacyMcpInventoryUnavailable}
                        className="min-w-0 flex-1 rounded-control text-left outline-none focus-visible:bg-list-selection focus-visible:outline-none"
                        onClick={() => setEditing(taskInput(task, mcpServers.data ?? []))}
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
                          {task.cron}
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
                            onSelect={() => setEditing(taskInput(task, mcpServers.data ?? []))}
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
              <div className="mt-3 rounded-card border border-separator">
                {TEMPLATES.map((template, index) => {
                  const Icon = template.icon;
                  return (
                    <React.Fragment key={template.name}>
                      {index > 0 ? <Separator /> : null}
                      <button
                        type="button"
                        disabled={creationUnavailable}
                        onClick={() =>
                          setEditing(
                            newTask(settings.data, activeId, mcpServers.data ?? [], template),
                          )
                        }
                        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-control bg-control text-secondary">
                          <Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <Text variant="strong">{template.name}</Text>
                            <Badge>{template.cron}</Badge>
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
          onOpenChange={(open) => !open && !saving && setEditing(null)}
          onSave={async (input) => {
            setSaving(true);
            try {
              await scheduleApi.save(input);
              await refresh(input.id);
              setEditing(null);
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
          await scheduleApi.remove(removing.id);
          await refresh(removing.id);
          setRemoving(null);
        }}
      />
    </>
  );
}
