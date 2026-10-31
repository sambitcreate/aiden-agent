// Workspace settings (⌘⇧, or a workspace's ⋯ menu): rename the workspace and
// choose which skills and connectors its chats can use. Everything that is on
// in Settings starts on here; switching something off applies from the next
// message and never stops a reply that is already running.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Folder, MoreHorizontal, Plug, Search, SlidersHorizontal, Wand2 } from "lucide-react";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
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
} from "./ui";
import { McpPresetIcon } from "./settings/mcp-preset-icons";
import { MemoryCardIcon } from "./memory-card-icon";
import { cn } from "../lib/ui-utils";
import { workspacesApi } from "../lib/ipc";
import {
  queryKeys,
  useMcpLiveStatus,
  useMcpServers,
  useSettings,
  useWorkspaceSkillChoices,
  useWorkspaces,
} from "../lib/queries";
import { useCommandHandler } from "../lib/command-system";
import { useActiveWorkspace } from "../lib/workspace-context";
import { mcpLiveStatusView } from "../lib/mcp-preset-state";
import {
  connectorRowView,
  groupWorkspaceSkills,
  onCountLabel,
  skillRowNote,
  withOffListEntry,
  workspaceHasOwnSettings,
  type WorkspaceSettingsTab,
} from "../lib/workspace-settings-view";
import type { Workspace, WorkspacePermission } from "../lib/types";

const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);
const SEARCH_THRESHOLD = 8;

interface OpenRequest {
  workspaceId: string;
  tab: WorkspaceSettingsTab;
}

const openListeners = new Set<(request: OpenRequest) => void>();

/** Opens Workspace settings for one workspace, on the given tab. */
export function openWorkspaceSettings(workspaceId: string, tab: WorkspaceSettingsTab = "general"): void {
  for (const listener of openListeners) listener({ workspaceId, tab });
}

const TABS: ReadonlyArray<{ id: WorkspaceSettingsTab; title: string; icon: React.ReactNode }> = [
  { id: "general", title: "General", icon: <SlidersHorizontal className="size-4" /> },
  { id: "skills", title: "Skills", icon: <Wand2 className="size-4" /> },
  { id: "connectors", title: "Connectors", icon: <Plug className="size-4" /> },
];

const PERMISSION_OPTIONS: ReadonlyArray<{ value: WorkspacePermission; label: string; description: string }> = [
  { value: "full", label: "Full access", description: "Edits files and runs commands without asking." },
  { value: "ask", label: "Ask first", description: "Asks before changing files or running commands." },
  { value: "none", label: "No access", description: "Can't read or change this folder." },
];

type WorkspacePatch = Parameters<typeof workspacesApi.update>[1];

/** Saves a change at once on screen, then rolls it back if saving fails. */
function useWorkspacePatch(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return React.useCallback(
    async (patch: WorkspacePatch, failure: string) => {
      if (!workspaceId) return;
      const previous = qc.getQueryData<Workspace[]>(queryKeys.workspaces);
      qc.setQueryData<Workspace[]>(queryKeys.workspaces, (list) =>
        list?.map((workspace) => (workspace.id === workspaceId ? { ...workspace, ...patch } : workspace)),
      );
      try {
        await workspacesApi.update(workspaceId, patch);
      } catch (error) {
        qc.setQueryData(queryKeys.workspaces, previous);
        toast.error(error instanceof Error && error.message ? `${failure} ${error.message}` : failure);
      } finally {
        void qc.invalidateQueries({ queryKey: queryKeys.workspaces });
        if ("disabledSkills" in patch || "permission" in patch) {
          void qc.invalidateQueries({ queryKey: queryKeys.workspaceSkillChoices(workspaceId) });
          void qc.invalidateQueries({ queryKey: queryKeys.skillCatalog(workspaceId) });
        }
      }
    },
    [qc, workspaceId],
  );
}

export function WorkspaceSettingsDialog() {
  const [request, setRequest] = React.useState<OpenRequest | null>(null);
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<WorkspaceSettingsTab>("general");
  const returnTo = React.useRef<HTMLElement | null>(null);
  const { active } = useActiveWorkspace();
  const workspaces = useWorkspaces();
  const found = workspaces.data?.find((candidate) => candidate.id === request?.workspaceId);
  // No workspace chats use the global settings, so they never get this pop-up.
  const workspace = workspaceHasOwnSettings(found) ? found : undefined;

  const show = React.useCallback((next: OpenRequest) => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRequest(next);
    setTab(next.tab);
    setOpen(true);
  }, []);

  React.useEffect(() => {
    openListeners.add(show);
    return () => {
      openListeners.delete(show);
    };
  }, [show]);

  const activeHasSettings = workspaceHasOwnSettings(active);
  useCommandHandler(
    "workspace.settings",
    () => {
      if (active && activeHasSettings) show({ workspaceId: active.id, tab: "general" });
    },
    activeHasSettings,
  );

  // The workspace was removed while its settings were open, or never had its own.
  React.useEffect(() => {
    if (open && workspaces.isSuccess && !workspace) setOpen(false);
  }, [open, workspace, workspaces.isSuccess]);

  return (
    <Dialog
      open={open && Boolean(workspace)}
      onOpenChange={setOpen}
      size="wide"
      title="Workspace settings"
      description={
        workspace ? (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-primary">{workspace.name}</span>
            {workspace.folderPath ? (
              <span className="min-w-0 truncate text-tertiary" title={workspace.folderPath}>
                · {workspace.folderPath}
              </span>
            ) : null}
          </span>
        ) : null
      }
      confirmHidden
      cancelLabel="Done"
      returnFocus={() => returnTo.current}
      onEscapeKeyDown={(event) => {
        // Escape in an edited name field undoes the edit instead of closing.
        if (event.target instanceof HTMLElement && event.target.dataset.escapeReverts === "true") {
          event.preventDefault();
        }
      }}
    >
      {workspace ? (
        <WorkspaceSettingsBody workspace={workspace} tab={tab} onTabChange={setTab} onClose={() => setOpen(false)} />
      ) : null}
    </Dialog>
  );
}

function WorkspaceSettingsBody({
  workspace,
  tab,
  onTabChange,
  onClose,
}: {
  workspace: Workspace;
  tab: WorkspaceSettingsTab;
  onTabChange: (tab: WorkspaceSettingsTab) => void;
  onClose: () => void;
}) {
  const tabIds = React.useId();
  const tabRefs = React.useRef(new Map<WorkspaceSettingsTab, HTMLButtonElement>());
  const moveTab = (event: React.KeyboardEvent, current: WorkspaceSettingsTab) => {
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
    if (!forward && !backward && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = TABS.findIndex((candidate) => candidate.id === current);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? TABS.length - 1
          : (index + (forward ? 1 : -1) + TABS.length) % TABS.length;
    const next = TABS[nextIndex]!.id;
    onTabChange(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div className="workspace-settings flex h-[min(60vh,560px)] min-h-0 gap-5 max-[640px]:h-[min(70vh,560px)] max-[640px]:flex-col max-[640px]:gap-3">
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Workspace settings sections"
        className="flex w-44 shrink-0 flex-col gap-0.5 max-[640px]:w-auto max-[640px]:flex-row"
      >
        {TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <button
              key={item.id}
              ref={(node) => {
                if (node) tabRefs.current.set(item.id, node);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${tabIds}-${item.id}-tab`}
              aria-selected={selected}
              aria-controls={`${tabIds}-${item.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(item.id)}
              onKeyDown={(event) => moveTab(event, item.id)}
              className={cn(
                "flex min-h-9 items-center gap-2.5 rounded-[11px] px-3 py-1.5 text-left text-regular text-primary outline-none transition-[background-color,box-shadow] duration-150 ease-out hover:bg-list-hover focus-visible:ring-2 focus-visible:ring-focus-ring max-[640px]:flex-1 max-[640px]:justify-center",
                selected && "bg-list-selection hover:bg-list-selection",
              )}
            >
              <span aria-hidden="true" className="shrink-0 text-secondary">
                {item.icon}
              </span>
              <span className="min-w-0 truncate">{item.title}</span>
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${tabIds}-${tab}-panel`}
        aria-labelledby={`${tabIds}-${tab}-tab`}
        className="settings-responsive min-h-0 min-w-0 flex-1 overflow-y-auto pr-1"
      >
        {tab === "general" ? <GeneralTab workspace={workspace} /> : null}
        {tab === "skills" ? <SkillsTab workspace={workspace} onClose={onClose} /> : null}
        {tab === "connectors" ? <ConnectorsTab workspace={workspace} onClose={onClose} /> : null}
      </div>
    </div>
  );
}

function GeneralTab({ workspace }: { workspace: Workspace }) {
  const patch = useWorkspacePatch(workspace.id);
  const [name, setName] = React.useState(workspace.name);
  React.useEffect(() => setName(workspace.name), [workspace.name]);
  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(workspace.name);
      return;
    }
    if (trimmed !== workspace.name) void patch({ name: trimmed }, "Couldn't rename this workspace.");
  };

  return (
    <FieldSet className="mb-0">
      <Field label="Name">
        <Input
          aria-label="Workspace name"
          data-escape-reverts={name !== workspace.name ? "true" : undefined}
          value={name}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitName();
            } else if (event.key === "Escape" && name !== workspace.name) {
              // The dialog stays open for this Escape (see onEscapeKeyDown); the next one closes it.
              setName(workspace.name);
            }
          }}
        />
      </Field>
      {workspace.folderPath ? (
        <Field
          label="Folder"
          description={
            <span className="block truncate" title={workspace.folderPath}>
              {workspace.folderPath}
            </span>
          }
        >
          <div className="flex justify-end">
            <Button
              variant="filled"
              size="small"
              onClick={() => {
                void workspacesApi.openFolder(workspace.id).catch((error: unknown) => {
                  toast.error(error instanceof Error ? error.message : "Couldn't open this folder.");
                });
              }}
            >
              <Folder aria-hidden="true" className="size-4" />
              {IS_MAC ? "Show in Finder" : "Open folder"}
            </Button>
          </div>
        </Field>
      ) : null}
      <Field
        label="Access"
        description={PERMISSION_OPTIONS.find((option) => option.value === workspace.permission)?.description}
      >
        <Select
          value={workspace.permission}
          onValueChange={(value) =>
            void patch({ permission: value as WorkspacePermission }, "Couldn't change access.")
          }
        >
          <SelectTrigger aria-label="Folder access">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERMISSION_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={
          <span className="inline-flex items-center gap-1.5">
            <MemoryCardIcon aria-hidden="true" className="size-4 text-secondary" />
            Memory
          </span>
        }
        description="Remember useful facts from this workspace's chats."
      >
        <Switch
          aria-label="Use memory in this workspace"
          checked={workspace.memoryEnabled !== false}
          onCheckedChange={(enabled) =>
            void patch({ memoryEnabled: enabled }, "Couldn't change memory for this workspace.")
          }
        />
      </Field>
    </FieldSet>
  );
}

function ListHeader({
  title,
  count,
  query,
  onQuery,
  showSearch,
  onAll,
  allDisabled,
  noun,
}: {
  title: string;
  count: string;
  query: string;
  onQuery: (value: string) => void;
  showSearch: boolean;
  onAll: (off: boolean) => void;
  allDisabled: boolean;
  noun: string;
}) {
  return (
    <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2 px-1">
      <div className="min-w-0 flex-1">
        <h3 className="text-large-strong text-primary">
          {title} <span className="font-normal text-secondary">· {count}</span>
        </h3>
      </div>
      {showSearch ? (
        <label className="flex h-8 w-48 items-center gap-2 rounded-control border border-field bg-background px-2.5 focus-within:bg-input max-[640px]:w-full max-[640px]:order-last">
          <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          <input
            aria-label={`Search ${noun}`}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search"
            className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-tertiary"
          />
        </label>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="transparent" size="small" iconOnly aria-label={`More ${noun} actions`} disabled={allDisabled}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem onSelect={() => onAll(true)}>Turn all off here</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAll(false)}>Turn all on here</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function NextMessageNote() {
  return (
    <Text variant="small" color="tertiary" className="mt-3 block px-1">
      Changes apply from the next message. A reply that's already running keeps going.
    </Text>
  );
}

function SkillsTab({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const settings = useSettings();
  const choices = useWorkspaceSkillChoices(workspace.id);
  const patch = useWorkspacePatch(workspace.id);
  const [query, setQuery] = React.useState("");
  const globallyOff = settings.data?.skillsEnabled === false;
  const off = React.useMemo(() => new Set(workspace.disabledSkills ?? []), [workspace.disabledSkills]);
  const all = choices.data ?? [];
  const switchable = all.filter((skill) => skill.available && !skill.userOnly);
  const onCount = switchable.filter((skill) => !off.has(skill.key)).length;
  const groups = groupWorkspaceSkills(all, query);

  const setOff = (keys: readonly string[], turnOff: boolean) => {
    let next = workspace.disabledSkills ?? [];
    for (const key of keys) next = withOffListEntry(next, key, turnOff);
    void patch({ disabledSkills: next }, "Couldn't save this skill choice.");
  };

  const openSkillsSettings = () => {
    onClose();
    void navigate({ to: "/settings", search: { section: "skills" } });
  };

  if (globallyOff) {
    return (
      <Callout>
        <Text variant="strong">Skills are off in Settings.</Text>
        <Text variant="small" color="secondary">
          Choices here are kept for when they're back on.
        </Text>
        <div>
          <Button variant="filled" size="small" className="mt-2" onClick={openSkillsSettings}>
            Open Skills settings
          </Button>
        </div>
      </Callout>
    );
  }

  return (
    <div>
      <ListHeader
        title="Skills"
        count={onCountLabel(onCount, switchable.length)}
        query={query}
        onQuery={setQuery}
        showSearch={all.length > SEARCH_THRESHOLD}
        onAll={(turnOff) => setOff(switchable.map((skill) => skill.key), turnOff)}
        allDisabled={switchable.length === 0}
        noun="skills"
      />
      <Text variant="small" color="secondary" className="mb-4 block px-1">
        Chats here can use only the skills that are on. You can still run any skill by typing{" "}
        <span className="font-mono">$</span> and its name.
      </Text>
      {choices.isError ? (
        <Callout color="red">
          <Text variant="small">Couldn't load skills.</Text>
          <div>
            <Button variant="filled" size="small" onClick={() => void choices.refetch()}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : choices.isLoading ? (
        <Text variant="small" color="tertiary" className="block px-1">
          Loading skills…
        </Text>
      ) : all.length === 0 ? (
        <Callout>
          <Text variant="small">No skills yet.</Text>
          <div>
            <Button variant="filled" size="small" onClick={openSkillsSettings}>
              Open Skills settings
            </Button>
          </div>
        </Callout>
      ) : groups.length === 0 ? (
        <Text variant="small" color="tertiary" className="block px-1">
          No skills match “{query.trim()}”.
        </Text>
      ) : (
        groups.map((group) => (
          <FieldSet key={group.id} title={group.title} className="mb-5">
            {group.skills.map((skill, index) => {
              const offHere = skill.available && !skill.userOnly && off.has(skill.key);
              const locked = !skill.available || skill.userOnly;
              return (
                <React.Fragment key={skill.key}>
                  {index > 0 ? <Separator className="mx-4 w-auto" /> : null}
                  <div className="flex items-center gap-3 px-4 py-3" data-workspace-skill={skill.key}>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <Text variant="strong" truncate className="block">
                          {skill.name}
                        </Text>
                        {offHere ? <Badge>Off here</Badge> : null}
                      </div>
                      <Text variant="small" color="tertiary" className="mt-0.5 line-clamp-2">
                        {skillRowNote({ ...skill, offHere })}
                      </Text>
                    </div>
                    <Switch
                      aria-label={`Use ${skill.name} in this workspace`}
                      checked={skill.available && !skill.userOnly && !offHere}
                      disabled={locked}
                      onCheckedChange={(on) => setOff([skill.key], !on)}
                    />
                  </div>
                </React.Fragment>
              );
            })}
          </FieldSet>
        ))
      )}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button variant="transparent" size="small" onClick={openSkillsSettings}>
          New skill…
        </Button>
      </div>
      <NextMessageNote />
    </div>
  );
}

function ConnectorsTab({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const navigate = useNavigate();
  const servers = useMcpServers();
  const live = useMcpLiveStatus();
  const patch = useWorkspacePatch(workspace.id);
  const [query, setQuery] = React.useState("");
  const off = React.useMemo(
    () => new Set(workspace.disabledMcpServerIds ?? []),
    [workspace.disabledMcpServerIds],
  );
  const all = servers.data ?? [];
  const rows = all.map((server) => ({ server, view: connectorRowView(server, off.has(server.id)) }));
  const switchable = rows.filter(({ view }) => !view.lockedBySettings);
  const onCount = switchable.filter(({ view }) => view.on).length;
  const needle = query.trim().toLocaleLowerCase();
  const shown = needle
    ? rows.filter(({ server }) => (server.name || "").toLocaleLowerCase().includes(needle))
    : rows;

  const setOff = (ids: readonly string[], turnOff: boolean) => {
    let next = workspace.disabledMcpServerIds ?? [];
    for (const id of ids) next = withOffListEntry(next, id, turnOff);
    void patch({ disabledMcpServerIds: next }, "Couldn't save this connector choice.");
  };

  const openConnectorSettings = () => {
    onClose();
    void navigate({ to: "/settings", search: { section: "mcp" } });
  };

  return (
    <div>
      <ListHeader
        title="Connectors"
        count={onCountLabel(onCount, switchable.length)}
        query={query}
        onQuery={setQuery}
        showSearch={all.length > SEARCH_THRESHOLD}
        onAll={(turnOff) => setOff(switchable.map(({ server }) => server.id), turnOff)}
        allDisabled={switchable.length === 0}
        noun="connectors"
      />
      <Text variant="small" color="secondary" className="mb-4 block px-1">
        Chats here can use only the connectors that are on. Bots and scheduled tasks keep their own choices.
      </Text>
      {servers.isError ? (
        <Callout color="red">
          <Text variant="small">Couldn't load connectors.</Text>
          <div>
            <Button variant="filled" size="small" onClick={() => void servers.refetch()}>
              Retry
            </Button>
          </div>
        </Callout>
      ) : servers.isLoading ? (
        <Text variant="small" color="tertiary" className="block px-1">
          Loading connectors…
        </Text>
      ) : all.length === 0 ? (
        <Callout>
          <Text variant="small">No connectors yet. Add one in Settings → Connectors.</Text>
          <div>
            <Button variant="filled" size="small" onClick={openConnectorSettings}>
              Open Connectors
            </Button>
          </div>
        </Callout>
      ) : shown.length === 0 ? (
        <Text variant="small" color="tertiary" className="block px-1">
          No connectors match “{query.trim()}”.
        </Text>
      ) : (
        <FieldSet className="mb-5">
          {shown.map(({ server, view }, index) => {
            const status = server.enabled && view.on ? mcpLiveStatusView(live.get(server.id), true) : null;
            const failing = status?.tone === "red";
            const name = server.name || "Untitled connector";
            return (
              <React.Fragment key={server.id}>
                {index > 0 ? <Separator className="mx-4 w-auto" /> : null}
                <div className="flex items-center gap-3 px-4 py-3" data-workspace-connector={server.id}>
                  <div
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-strong"
                  >
                    {server.presetId ? (
                      <McpPresetIcon presetId={server.presetId} name={name} className="size-4" />
                    ) : (
                      <Plug className="size-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <Text variant="strong" truncate className="block">
                        {name}
                      </Text>
                      {view.lockedBySettings ? null : !view.on ? (
                        <Badge>Off here</Badge>
                      ) : failing ? (
                        <Badge color="red">{status.label}</Badge>
                      ) : null}
                    </div>
                    <Text variant="small" color="tertiary" className="mt-0.5 block">
                      {view.lockedBySettings ? (
                        <>
                          {view.note} ·{" "}
                          <button
                            type="button"
                            className="rounded-sm text-secondary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
                            onClick={openConnectorSettings}
                          >
                            Change in Settings
                          </button>
                        </>
                      ) : failing ? (
                        <>
                          {status.error ?? "Couldn't connect"} ·{" "}
                          <button
                            type="button"
                            className="rounded-sm text-secondary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
                            onClick={openConnectorSettings}
                          >
                            Fix in Settings
                          </button>
                        </>
                      ) : view.on ? (
                        (status?.label ?? "On")
                      ) : (
                        "Chats here can't use it"
                      )}
                    </Text>
                  </div>
                  <Switch
                    aria-label={`Use ${name} in this workspace`}
                    checked={view.on}
                    disabled={view.lockedBySettings}
                    onCheckedChange={(on) => setOff([server.id], !on)}
                  />
                </div>
              </React.Fragment>
            );
          })}
        </FieldSet>
      )}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Button variant="transparent" size="small" onClick={openConnectorSettings}>
          Add a connector…
        </Button>
      </div>
      <NextMessageNote />
    </div>
  );
}
