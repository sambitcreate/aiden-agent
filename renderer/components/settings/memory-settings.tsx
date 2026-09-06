import { compactionEngineFrom, type CompactionEngine } from "../../shared/compaction";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, RadioGroup, RadioGroupItem, Switch, Text, toast } from "../ui";
import { settingsApi, workspacesApi } from "../../lib/ipc";
import { queryKeys, useSettings, useWorkspaces } from "../../lib/queries";
import type { AppSettings, Workspace } from "../../lib/types";

export function MemorySettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const [compactionSaving, setCompactionSaving] = React.useState(false);
  const [globalSaving, setGlobalSaving] = React.useState(false);
  const [workspaceSaving, setWorkspaceSaving] = React.useState<Set<string>>(() => new Set());
  const globallyEnabled = settings.data?.memoryEnabled !== false;

  const setCompactionEngine = async (engine: CompactionEngine) => {
    if (compactionSaving) return;
    setCompactionSaving(true);
    try {
      const saved = await settingsApi.set({ compactionEngine: engine });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch {
      toast.error("Couldn't update automatic compaction.");
    } finally {
      setCompactionSaving(false);
    }
  };

  const setGlobalEnabled = async (enabled: boolean) => {
    if (globalSaving) return;
    setGlobalSaving(true);
    try {
      const saved = await settingsApi.set({ memoryEnabled: enabled });
      queryClient.setQueryData<AppSettings>(queryKeys.settings, saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update memory settings.");
    } finally {
      setGlobalSaving(false);
    }
  };

  const setWorkspaceEnabled = async (workspace: Workspace, enabled: boolean) => {
    if (workspaceSaving.has(workspace.id)) return;
    setWorkspaceSaving((current) => new Set(current).add(workspace.id));
    try {
      const saved = await workspacesApi.update(workspace.id, { memoryEnabled: enabled });
      queryClient.setQueryData<Workspace[]>(queryKeys.workspaces, (current) =>
        current?.map((candidate) => (candidate.id === saved.id ? saved : candidate)),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update workspace memory.");
    } finally {
      setWorkspaceSaving((current) => {
        const next = new Set(current);
        next.delete(workspace.id);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <FieldSet title="Automatic compaction">
        <RadioGroup
          orientation="vertical"
          aria-label="Automatic compaction engine"
          value={compactionEngineFrom(settings.data?.compactionEngine)}
          onValueChange={(value) => void setCompactionEngine(compactionEngineFrom(value))}
          disabled={settings.isLoading}
          aria-busy={compactionSaving}
          className="gap-1 p-2"
        >
          {(
            [
              [
                "llm",
                "LLM Compaction",
                "Uses your chat model to summarize older context. Takes time and uses model tokens.",
              ],
              [
                "vcc",
                "pi-vcc Compaction — Experimental",
                "Compacts locally without a summarization call. Preserves selected excerpts and retrieves earlier details when needed.",
              ],
            ] as const
          ).map(([value, label, description]) => (
            <label
              key={value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors hover:bg-control-hover ${compactionEngineFrom(settings.data?.compactionEngine) === value ? "bg-control" : ""}`}
            >
              <RadioGroupItem
                value={value}
                aria-label={label}
                className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
              />
              <span className="flex flex-col gap-1">
                <Text>{label}</Text>
                <Text as="span" variant="small" color="secondary">
                  {description}
                </Text>
              </span>
            </label>
          ))}
        </RadioGroup>
        <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
          Applies to new runs. Try /compact-LLM or /compact-VCC in an idle chat for a one-time
          override; /compact uses this preference. Local compaction can omit details, which Aiden
          can retrieve from the current chat. That context may be sent to your chat model when the
          conversation continues. Current-chat recall works independently of memory below.
        </Text>
      </FieldSet>

      <FieldSet title="Memory controls">
        <Field
          label="Use memory"
          description="Lets Aiden recall approved facts, suggest new facts during chats, and index conversation metadata for retrieval."
        >
          <Switch
            checked={globallyEnabled}
            onCheckedChange={(checked) => void setGlobalEnabled(checked)}
            disabled={settings.isLoading || globalSaving}
            aria-label="Use memory globally"
          />
        </Field>
        <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
          Turning memory off stops memory tools, prompt context, and new indexing. Existing approved
          facts stay on this Mac and become available again if you turn it back on.
        </Text>
      </FieldSet>

      <FieldSet title="Workspaces">
        {workspaces.isLoading ? (
          <Text as="p" variant="small" color="secondary" className="p-4" role="status">
            Loading workspaces…
          </Text>
        ) : workspaces.data?.length ? (
          workspaces.data.map((workspace) => (
            <Field
              key={workspace.id}
              label={workspace.name}
              description={
                globallyEnabled
                  ? "Use memory in this workspace's chats."
                  : "Global memory is off; this preference will apply when it is turned back on."
              }
            >
              <Switch
                checked={workspace.memoryEnabled !== false}
                onCheckedChange={(checked) => void setWorkspaceEnabled(workspace, checked)}
                disabled={!globallyEnabled || workspaceSaving.has(workspace.id)}
                aria-label={`Use memory in ${workspace.name}`}
              />
            </Field>
          ))
        ) : (
          <Text as="p" variant="small" color="secondary" className="p-4">
            No workspaces yet.
          </Text>
        )}
        <Text as="p" variant="small" color="secondary" className="px-4 pb-4 text-pretty">
          Workspace switches affect regular workspace chats. Bot memory has its own scope and
          follows the global switch.
        </Text>
      </FieldSet>
    </div>
  );
}
