import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Field, FieldSet, Switch, Text, toast } from "../ui";
import { settingsApi, workspacesApi } from "../../lib/ipc";
import { queryKeys, useSettings, useWorkspaces } from "../../lib/queries";
import type { AppSettings, Workspace } from "../../lib/types";

export function MemorySettings() {
  const queryClient = useQueryClient();
  const settings = useSettings();
  const workspaces = useWorkspaces();
  const [globalSaving, setGlobalSaving] = React.useState(false);
  const [workspaceSaving, setWorkspaceSaving] = React.useState<Set<string>>(() => new Set());
  const globallyEnabled = settings.data?.memoryEnabled !== false;

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
      <FieldSet title="Memory">
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
