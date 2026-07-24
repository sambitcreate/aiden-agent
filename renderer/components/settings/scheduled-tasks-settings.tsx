import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Clock3, ExternalLink, Trash2 } from "lucide-react";
import {
  AlertDialog,
  Button,
  Callout,
  Field,
  FieldSet,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Text,
  toast,
} from "../ui";
import { scheduleApi } from "../../lib/ipc";
import { queryKeys, useScheduledTasks, useScheduledTaskSettings } from "../../lib/queries";
import type { ScheduledTask, ScheduledTaskSettings } from "../../lib/types";

export function ScheduledTasksSettings() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useScheduledTaskSettings();
  const tasks = useScheduledTasks();
  const [saving, setSaving] = React.useState(false);
  const [removing, setRemoving] = React.useState<ScheduledTask | null>(null);
  const [timezone, setTimezone] = React.useState("");

  React.useEffect(() => {
    if (settings.data?.defaultTimezone) setTimezone(settings.data.defaultTimezone);
  }, [settings.data?.defaultTimezone]);

  const save = async (patch: Partial<ScheduledTaskSettings>) => {
    if (saving) return;
    setSaving(true);
    try {
      const next = await scheduleApi.settings(patch);
      queryClient.setQueryData(queryKeys.scheduledSettings, next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update scheduled tasks.");
    } finally {
      setSaving(false);
    }
  };

  const value = settings.data;
  const authoritativeError = settings.isError || tasks.isError;
  return (
    <>
      {authoritativeError ? (
        <Callout className="mb-4 flex-row items-center justify-between gap-4" color="red">
          <div>
            <Text variant="strong">Scheduled task settings are unavailable</Text>
            <Text as="p" variant="small" color="secondary" className="mt-0.5">
              Aiden could not load the authoritative state. Retry before changing settings.
            </Text>
          </div>
          <Button
            size="small"
            onClick={() => void Promise.all([settings.refetch(), tasks.refetch()])}
          >
            Retry
          </Button>
        </Callout>
      ) : null}
      <FieldSet title="Scheduled tasks">
        <Field
          label="Enable scheduled tasks"
          description="Pause or resume every automatic task without deleting its schedule."
        >
          <div className="flex justify-end">
            <Switch
              checked={value?.enabled ?? false}
              onCheckedChange={(enabled) => void save({ enabled })}
              disabled={settings.isLoading || saving || authoritativeError}
              aria-label="Enable scheduled tasks"
            />
          </div>
        </Field>
        <Field label="Default task mode" description="Used when Aiden creates a new task.">
          <Select
            value={value?.defaultMode ?? "llm"}
            onValueChange={(defaultMode) =>
              void save({ defaultMode: defaultMode === "script" ? "script" : "llm" })
            }
            disabled={settings.isLoading || saving || authoritativeError}
          >
            <SelectTrigger aria-label="Default scheduled task mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="llm">Ask Aiden</SelectItem>
              <SelectItem value="script">Run script</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Default permission"
          description="Read-only can inspect context. Full can edit files and run commands without asking."
        >
          <Select
            value={value?.defaultPermission ?? "read-only"}
            onValueChange={(defaultPermission) =>
              void save({ defaultPermission: defaultPermission === "full" ? "full" : "read-only" })
            }
            disabled={settings.isLoading || saving || authoritativeError}
          >
            <SelectTrigger aria-label="Default scheduled task permission">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read-only">Read-only</SelectItem>
              <SelectItem value="full">Full</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Notifications" description="Notify after non-silent task runs.">
          <div className="flex justify-end">
            <Switch
              checked={value?.defaultNotify ?? true}
              onCheckedChange={(defaultNotify) => void save({ defaultNotify })}
              disabled={settings.isLoading || saving || authoritativeError}
              aria-label="Notify for new scheduled tasks"
            />
          </div>
        </Field>
        <Field label="Default timezone" description="An IANA timezone such as America/New_York.">
          <Input
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            onBlur={() => {
              const next = timezone.trim();
              if (next && next !== value?.defaultTimezone) void save({ defaultTimezone: next });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            disabled={settings.isLoading || saving || authoritativeError}
            placeholder="America/New_York"
          />
        </Field>
        <Field
          label="Script folders"
          description="Workspace scripts take precedence over global scripts with the same file name."
          orientation="vertical"
        >
          <div className="rounded-control bg-background px-3 py-2 font-mono text-small text-secondary">
            &lt;workspace&gt;/.aiden/scripts/
            <br />
            ~/.aiden/scripts/
          </div>
        </Field>
      </FieldSet>

      <FieldSet title="Current tasks">
        {tasks.isError ? (
          <div className="p-4">
            <Text variant="small" color="secondary">
              Current tasks could not be loaded.
            </Text>
          </div>
        ) : (tasks.data ?? []).length === 0 ? (
          <div className="flex items-center gap-3 p-4">
            <Clock3 className="size-4 shrink-0 text-tertiary" />
            <Text variant="small" color="secondary">
              No scheduled tasks yet.
            </Text>
          </div>
        ) : (
          (tasks.data ?? []).slice(0, 6).map((task, index) => (
            <React.Fragment key={task.id}>
              {index > 0 ? <Separator /> : null}
              <div className="flex items-center gap-3 px-4 py-3">
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    task.lastResult === "error" || task.lastResult === "blocked"
                      ? "bg-red"
                      : task.enabled
                        ? "bg-green"
                        : "bg-tertiary"
                  }`}
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <Text variant="strong" truncate>
                    {task.name}
                  </Text>
                  <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                    {task.enabled ? task.cron : "Paused"}
                  </Text>
                </div>
                <Button
                  size="small"
                  variant="transparent"
                  iconOnly
                  aria-label={`Manage ${task.name}`}
                  onClick={() => void navigate({ to: "/scheduled" })}
                >
                  <ExternalLink />
                </Button>
                <Button
                  size="small"
                  variant="transparent"
                  iconOnly
                  aria-label={`Delete ${task.name}`}
                  onClick={() => setRemoving(task)}
                  disabled={authoritativeError}
                >
                  <Trash2 />
                </Button>
              </div>
            </React.Fragment>
          ))
        )}
      </FieldSet>

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
          setRemoving(null);
          await queryClient.invalidateQueries({ queryKey: queryKeys.scheduledTasks });
        }}
      />
    </>
  );
}
