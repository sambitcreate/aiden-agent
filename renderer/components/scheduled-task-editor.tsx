import * as React from "react";
import { ShieldAlert } from "lucide-react";
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

export function ScheduledTaskEditor({
  open,
  initial,
  workspaces,
  mcpServers,
  mcpServersUnavailable = false,
  busy,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  initial: ScheduledTaskInput;
  workspaces: Workspace[];
  mcpServers: McpServer[];
  mcpServersUnavailable?: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: ScheduledTaskInput) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState(initial);
  const [preview, setPreview] = React.useState<number[]>([]);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [scripts, setScripts] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setDraft({
        ...initial,
        permission: initial.mode === "script" ? "full" : initial.permission,
        mcpServerIds: initial.mode === "llm" ? (initial.mcpServerIds ?? []) : [],
      });
    }
  }, [initial, open]);

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
    (!selectedMcpIds.length || (!mcpServersUnavailable && unavailableMcpIds.length === 0));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={draft.id ? "Edit scheduled task" : "Create scheduled task"}
      description="Aiden runs this task on your Mac while the app is open."
      size="large"
      busy={busy}
      confirmLabel={draft.id ? "Save" : "Create"}
      confirmDisabled={!valid}
      onConfirm={() => onSave(draft)}
    >
      <FieldSet>
        <Field label="Name">
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
        <Field label="Schedule" description="Five-part cron, or six parts when seconds are needed.">
          <Input
            value={draft.cron}
            onChange={(event) => setDraft((current) => ({ ...current, cron: event.target.value }))}
            placeholder="0 9 * * 1-5"
            aria-invalid={Boolean(previewError)}
          />
        </Field>
        <Field label="Timezone">
          <Input
            value={draft.timezone ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, timezone: event.target.value }))
            }
            placeholder="America/New_York"
            aria-invalid={Boolean(previewError)}
          />
        </Field>
        <Field label="Upcoming runs" orientation="vertical">
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
              Enter a valid schedule to preview its next runs.
            </Text>
          )}
        </Field>
        <Field
          label="Workspace"
          description="Paths are always re-resolved by Aiden when the task runs."
        >
          <Select
            value={draft.workspaceId ?? "__none__"}
            onValueChange={(workspaceId) =>
              setDraft((current) => ({
                ...current,
                workspaceId: workspaceId === "__none__" ? undefined : workspaceId,
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
                No MCP servers are enabled. Connect one in Settings → MCP Servers.
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
                        disabled={!server.enabled && !selected}
                        aria-label={`${selected ? "Remove" : "Allow"} ${server.name} for this scheduled task`}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </Field>
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
    </Dialog>
  );
}
