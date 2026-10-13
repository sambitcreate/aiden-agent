import { McpProviderAuthFields } from "./mcp-provider-auth-fields";
import { McpOAuthMetadataField, mcpOAuthMetadataFieldError } from "./mcp-oauth-metadata-field";
// Plugins settings — Codex official directory plus custom MCP servers whose
// tools become available to the assistant. Connectable plugins reuse the
// hosted HTTP preset flow; other directory entries explain compatibility.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
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
  Separator,
  Switch,
  Text,
  Textarea,
  toast,
} from "../ui";
import { Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { mcpApi } from "../../lib/ipc";
import {
  mcpConnectionChanged,
  mcpDependentsSummary,
  mcpLiveStatusView,
  mcpPresetConnectionBadge,
  mcpServerDraftForEditor,
  mcpServerEditorKind,
  type McpLiveTone,
} from "../../lib/mcp-preset-state";
import {
  queryKeys,
  useMcpDependents,
  useMcpLiveStatus,
  useMcpPresets,
  useMcpServers,
  useProviders,
} from "../../lib/queries";
import type { McpLiveStatus, McpPresetState, McpServer, McpServerDependents, McpTransport } from "../../lib/types";
import {
  filterPluginCatalog,
  isConnectablePlugin,
  PLUGIN_CATALOG,
  PLUGIN_CATEGORIES,
  pluginCompatibilityLabel,
  type PluginCatalogEntry,
  type PluginCompatibilityFilter,
} from "../../shared/plugin-catalog";
import { McpPresetIcon } from "./mcp-preset-icons";
import { PresetSetupDialog } from "./mcp-preset-setup";
import { McpSignInControls } from "./mcp-sign-in-controls";
import { McpExposureControls } from "./mcp-exposure-controls";

const COMPATIBILITY_FILTERS: ReadonlyArray<{ id: PluginCompatibilityFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "connectable", label: "Connectable MCP" },
  { id: "skills", label: "Skills" },
  { id: "other", label: "Other" },
];

function newServer(): McpServer {
  return { id: `mcp-${Date.now().toString(36)}`, name: "", transport: "stdio", enabled: true, args: [] };
}

function linesToRecord(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function recordToLines(record: Record<string, string> | undefined): string {
  return Object.entries(record ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** One argument per line, so arguments that contain spaces survive editing unchanged. */
function argsToLines(args: readonly string[] | undefined): string {
  return (args ?? []).join("\n");
}

function linesToArgs(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.trim().length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LIVE_DOT: Record<McpLiveTone, string> = {
  green: "bg-status-green",
  red: "bg-status-red",
  warning: "bg-status-warning",
  neutral: "bg-tertiary",
};

/** Row status: a soft semantic dot and label, then the last discovery's inventory. */
function McpLiveIndicator({ server, status }: { server: McpServer; status: McpLiveStatus | undefined }) {
  const view = mcpLiveStatusView(status, server.enabled);
  if (!view) return null;
  return (
    <>
      <span className="flex items-center gap-1.5 text-small text-secondary">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${LIVE_DOT[view.tone]}`} />
        {view.label}
      </span>
      {status?.toolCount !== undefined ? <Badge>Tools {status.toolCount}</Badge> : null}
      {status?.resources ? <Badge>Resources</Badge> : null}
    </>
  );
}

/** “Scheduled task … and Bot … use this server.” plus what the action does to them. */
function McpDependentsNote({
  dependents,
  consequence,
}: {
  dependents: McpServerDependents | undefined;
  consequence: string;
}) {
  const summary = mcpDependentsSummary(dependents);
  if (!summary) return null;
  return (
    <Text as="p" variant="small" className="mt-2 block" role="note">
      {summary} {dependents!.schedules.length + dependents!.bots.length === 1 ? "uses" : "use"} this server.{" "}
      {consequence}
    </Text>
  );
}

export function McpSettings() {
  const qc = useQueryClient();
  const servers = useMcpServers();
  const presets = useMcpPresets();
  const [editing, setEditing] = React.useState<McpServer | null>(null);
  const [setup, setSetup] = React.useState<{ state: McpPresetState; server?: McpServer } | null>(null);
  const [removing, setRemoving] = React.useState<McpServer | null>(null);
  const [disabling, setDisabling] = React.useState<{ server: McpServer; dependents: McpServerDependents } | null>(null);
  const live = useMcpLiveStatus();
  const removingDependents = useMcpDependents(removing?.id);
  const [pluginSearch, setPluginSearch] = React.useState("");
  const [pluginCategory, setPluginCategory] = React.useState<string | "all">("all");
  const [pluginFilter, setPluginFilter] = React.useState<PluginCompatibilityFilter>("all");
  const [pluginDetails, setPluginDetails] = React.useState<PluginCatalogEntry | null>(null);
  const [toggling, setToggling] = React.useState<ReadonlySet<string>>(() => new Set());
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [resetting, setResetting] = React.useState(false);

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.mcpServers }),
      qc.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
    ]);
  };

  const toggle = async (server: McpServer, enabled: boolean, confirmed = false) => {
    if (toggling.has(server.id)) return;
    setToggling((current) => new Set(current).add(server.id));
    if (!enabled && !confirmed) {
      // Disabling breaks schedules and Bots that rely on this server: confirm first.
      const dependents = await qc
        .fetchQuery({ queryKey: queryKeys.mcpDependents(server.id), queryFn: () => mcpApi.dependents(server.id), staleTime: 0 })
        .catch(() => null);
      if (dependents && mcpDependentsSummary(dependents)) {
        setToggling((current) => {
          const next = new Set(current);
          next.delete(server.id);
          return next;
        });
        setDisabling({ server, dependents });
        return;
      }
    }
    try {
      await mcpApi.save({ ...server, enabled });
    } catch (error) {
      toast.error(
        `Couldn’t ${enabled ? "enable" : "disable"} ${server.name || "this server"}: ${errorMessage(error)}`,
      );
    } finally {
      await invalidate().catch(() => undefined);
      setToggling((current) => {
        const next = new Set(current);
        next.delete(server.id);
        return next;
      });
    }
  };

  // Model access changes go through the ordinary save path (which reconnects).
  const saveExposure = async (server: McpServer) => {
    try {
      await mcpApi.save(server);
    } catch (error) {
      toast.error(`Couldn’t change model access for ${server.name || "this server"}: ${errorMessage(error)}`);
    } finally {
      await invalidate().catch(() => undefined);
    }
  };

  const resetConnections = async () => {
    setResetting(true);
    try {
      await mcpApi.reconnect();
      toast.success("Connections reset. Enabled servers reconnect with your next message.");
    } catch (error) {
      toast.error(`Couldn’t reset connections: ${errorMessage(error)}`);
    } finally {
      setResetting(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await mcpApi.remove(removing.id);
      setRemoving(null);
      await invalidate().catch(() => undefined);
    } catch (error) {
      // The confirmation stays open and shows the reason inline.
      setRemoveError(errorMessage(error));
    } finally {
      setRemoveBusy(false);
    }
  };

  const openServer = (server: McpServer) => {
    const kind = mcpServerEditorKind(server, presets.isSuccess, presets.data ?? []);
    if (kind === "loading") {
      toast.info("MCP provider details are still loading.");
      return;
    }
    if (kind === "missing-preset") {
      setEditing(mcpServerDraftForEditor(server, kind));
      return;
    }
    if (kind === "preset") {
      const state = presets.data!.find((p) => p.serverId === server.id)!;
      setSetup({ state, server });
      return;
    }
    setEditing(server);
  };

  const list = servers.data ?? [];
  const catalogReady = servers.isSuccess && presets.isSuccess;
  const loadErrors = [
    servers.isError ? { label: "configured MCP servers", query: servers } : null,
    presets.isError ? { label: "plugin connection details", query: presets } : null,
  ].filter((entry) => entry !== null);
  const visiblePlugins = filterPluginCatalog(
    PLUGIN_CATALOG,
    pluginSearch,
    pluginCategory,
    pluginFilter,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="settings-page-heading flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Text as="h1" variant="heading1">Plugins</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Browse plugins, connect hosted MCP servers, or add your own. Listing a plugin does not
            add tools. Enabled MCP servers and Skills you add become assistant tools; workspace
            folder access is a separate permission. Tool inputs may be shared with a configured
            server.
          </Text>
        </div>
        <Button
          variant="transparent"
          size="small"
          className="shrink-0"
          disabled={resetting}
          onClick={() => void resetConnections()}
        >
          <RefreshCw className="size-4" />
          {resetting ? "Resetting…" : "Reset connections"}
        </Button>
      </div>

      {loadErrors.map(({ label, query }) => (
        <Callout key={label} color="red" role="alert" className="flex-row items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Text variant="small-strong">Couldn’t load {label}</Text>
            <Text variant="small" className="mt-0.5 block">
              {errorMessage(query.error)}
            </Text>
          </div>
          <Button
            variant="filled"
            size="small"
            className="shrink-0"
            disabled={query.isFetching}
            aria-label={`Retry loading ${label}`}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </Callout>
      ))}

      <div className="flex items-center justify-between gap-4 settings-card rounded-card px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <Text variant="small-strong">Manual MCP server setup</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Add a local command or remote MCP server. Enabled custom servers become assistant tools
            the same way connectable plugins do.
          </Text>
        </div>
        <Button variant="filled" size="small" className="shrink-0" onClick={() => setEditing(newServer())}>
          <Plus className="size-4" />
          Add custom MCP
        </Button>
      </div>

      {list.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Text variant="small-strong" color="secondary">
            Configured MCP servers · {list.length}
          </Text>
          <div className="settings-card rounded-card">
            {list.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 ? <Separator /> : null}
                {/* Top-aligned: the model-access controls below the name can expand. */}
                <div className="flex items-start gap-3 px-3.5 py-3">
                  {s.presetId ? (
                    <div
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-well text-strong"
                    >
                      <McpPresetIcon presetId={s.presetId} name={s.name} className="size-4" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Text variant="strong" truncate>
                        {s.name || "Untitled server"}
                      </Text>
                      <Badge>{s.transport}</Badge>
                      {mcpServerEditorKind(s, catalogReady, presets.data ?? []) === "preset" ? (
                        <Badge color="blue">built-in</Badge>
                      ) : null}
                    </div>
                    <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                      {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || "No command" : s.url || "No URL"}
                    </Text>
                    <div
                      className="mt-1 flex flex-wrap items-center gap-2"
                      aria-label={`${s.name || "MCP server"} status`}
                      aria-live="polite"
                    >
                      <McpLiveIndicator server={s} status={live.get(s.id)} />
                    </div>
                    {s.enabled && live.get(s.id)?.state === "failed" && live.get(s.id)?.error ? (
                      <Text variant="small" color="red" className="mt-0.5 block break-words">
                        {live.get(s.id)!.error}
                      </Text>
                    ) : null}
                    <McpExposureControls server={s} toolCount={live.get(s.id)?.toolCount} onSave={saveExposure} />
                  </div>
                  <Button
                    variant="filled"
                    size="small"
                    disabled={Boolean(s.presetId) && !catalogReady}
                    aria-label={`${s.presetId ? "Manage" : "Edit"} ${s.name || "untitled server"}`}
                    onClick={() => openServer(s)}
                  >
                    {s.presetId ? "Manage" : "Edit"}
                  </Button>
                  <Switch
                    aria-label={`Enable ${s.name || "MCP server"}`}
                    checked={s.enabled}
                    disabled={toggling.has(s.id)}
                    aria-busy={toggling.has(s.id) || undefined}
                    onCheckedChange={(v) => void toggle(s, v)}
                  />
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    aria-label={`Remove ${s.name || "untitled server"}`}
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(s);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <div>
          <Text variant="small-strong" color="secondary">
            Plugin directory
          </Text>
          <Text variant="small" color="tertiary" className="mt-0.5 block">
            Official Codex plugins plus Aiden’s Composio connector. Connectable entries use hosted
            MCP setup. Skills and ChatGPT-only apps stay listed so you can see what they do; they
            do not install Codex skill files or grant workspace access.
          </Text>
        </div>
        <label className="flex h-10 items-center gap-2 rounded-control border border-field bg-input px-3 transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-popover motion-reduce:transition-none">
          <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          <input
            type="search"
            value={pluginSearch}
            onChange={(event) => setPluginSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setPluginSearch("");
            }}
            placeholder="Search plugins…"
            aria-label="Search plugins"
            className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-secondary"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter plugins by connection type">
          {COMPATIBILITY_FILTERS.map((option) => (
            <Button
              key={option.id}
              size="small"
              variant={pluginFilter === option.id ? "muted" : "transparent"}
              aria-pressed={pluginFilter === option.id}
              className={pluginFilter === option.id ? "bg-list-selection text-primary" : "text-secondary"}
              onClick={() => setPluginFilter(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter plugins by category">
          <Button
            size="small"
            variant={pluginCategory === "all" ? "muted" : "transparent"}
            aria-pressed={pluginCategory === "all"}
            className={pluginCategory === "all" ? "bg-list-selection text-primary" : "text-secondary"}
            onClick={() => setPluginCategory("all")}
          >
            All categories
          </Button>
          {PLUGIN_CATEGORIES.map((category) => (
            <Button
              key={category}
              size="small"
              variant={pluginCategory === category ? "muted" : "transparent"}
              aria-pressed={pluginCategory === category}
              className={pluginCategory === category ? "bg-list-selection text-primary" : "text-secondary"}
              onClick={() => setPluginCategory(category)}
            >
              {category}
            </Button>
          ))}
        </div>
        <Text variant="small" color="tertiary" aria-live="polite">
          {visiblePlugins.length} plugin{visiblePlugins.length === 1 ? "" : "s"}
        </Text>
        <div className="settings-plugin-grid">
          {visiblePlugins.map((plugin) => {
            const state = presets.data?.find((entry) => entry.preset.id === plugin.id);
            return (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                state={catalogReady ? state : undefined}
                catalogReady={catalogReady}
                onSetup={() => {
                  if (!state) {
                    toast.error("This built-in MCP definition is unavailable. Reload Settings and try again.");
                    return;
                  }
                  setSetup({
                    state,
                    server: list.find(
                      (s) => s.id === state.serverId && s.presetId === state.preset.id,
                    ),
                  });
                }}
                onDetails={() => setPluginDetails(plugin)}
              />
            );
          })}
        </div>
      </section>

      {editing ? (
        <McpEditor
          server={editing}
          isNew={!list.some((s) => s.id === editing.id)}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
        />
      ) : null}

      {setup ? (
        <PresetSetupDialog
          state={setup.state}
          server={setup.server}
          open={setup !== null}
          onOpenChange={(open) => !open && setSetup(null)}
          onSaved={invalidate}
        />
      ) : null}

      {pluginDetails ? (
        <Dialog
          open={pluginDetails !== null}
          onOpenChange={(open) => !open && setPluginDetails(null)}
          title={pluginDetails.name}
          description={pluginDetails.tagline}
          confirmLabel="Close"
          onConfirm={() => setPluginDetails(null)}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{pluginCompatibilityLabel(pluginDetails.compatibility)}</Badge>
              <Badge>{pluginDetails.category}</Badge>
            </div>
            <Text variant="small" color="secondary" className="block">
              {pluginDetails.vendor}
              {pluginDetails.source === "openai-curated" ? " · Codex official" : " · Aiden catalog"}
            </Text>
            {pluginDetails.compatibilityNote ? (
              <Text variant="small" color="secondary" className="block">
                {pluginDetails.compatibilityNote}
              </Text>
            ) : (
              <Text variant="small" color="secondary" className="block">
                Connects over HTTPS MCP. Aiden stores credentials on this device and only sends resource
                tokens to the official MCP origin. Browser sign-in may also talk to that vendor’s
                declared OAuth provider. Connecting adds tools only after the server is enabled;
                it does not install Codex skill files or change workspace folder permission.
              </Text>
            )}
            {pluginDetails.url ? (
              <Text variant="small" color="tertiary" className="block">
                {pluginDetails.url}
              </Text>
            ) : null}
            <a
              href={pluginDetails.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-small text-secondary underline-offset-2 hover:underline"
            >
              Documentation
            </a>
          </div>
        </Dialog>
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this MCP server?"
        description={
          removing ? (
            <>
              “{removing.name || "Untitled server"}” will be disconnected and removed.
              <McpDependentsNote
                dependents={removingDependents.data}
                consequence="They will stop running with it until you choose another server."
              />
              {removeError ? (
                <Text as="p" variant="small" color="red" role="alert" className="mt-2">
                  Couldn’t remove it: {removeError}
                </Text>
              ) : null}
            </>
          ) : null
        }
        confirmLabel={removeBusy ? "Removing…" : removeError ? "Try again" : "Remove"}
        confirmVariant="destructive"
        busy={removeBusy}
        keepOpenOnConfirm
        onConfirm={confirmRemove}
      />

      <AlertDialog
        open={disabling !== null}
        onOpenChange={(open) => !open && setDisabling(null)}
        title="Disable this MCP server?"
        description={
          disabling ? (
            <>
              The assistant stops using “{disabling.server.name || "Untitled server"}” until you enable it again.
              <McpDependentsNote
                dependents={disabling.dependents}
                consequence="They cannot use it while it is disabled."
              />
            </>
          ) : null
        }
        confirmLabel="Disable"
        confirmVariant="destructive"
        onConfirm={() => {
          if (!disabling) return;
          const { server } = disabling;
          setDisabling(null);
          void toggle(server, false, true);
        }}
      />
    </div>
  );
}

function PluginCard({
  plugin,
  state,
  catalogReady,
  onSetup,
  onDetails,
}: {
  plugin: PluginCatalogEntry;
  state?: McpPresetState;
  catalogReady: boolean;
  onSetup: () => void;
  onDetails: () => void;
}) {
  const connectable = isConnectablePlugin(plugin);
  const badge = state ? mcpPresetConnectionBadge(state) : null;
  return (
    <div className="flex flex-col gap-2 settings-card rounded-card p-4">
      <div
        aria-hidden
        className="flex size-9 items-center justify-center rounded-lg bg-well text-strong"
      >
        <McpPresetIcon presetId={plugin.id} name={plugin.name} className="size-5" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="strong">{plugin.name}</Text>
        <Badge>{pluginCompatibilityLabel(plugin.compatibility)}</Badge>
      </div>
      <Text variant="small" color="secondary" className="block">
        {plugin.tagline}
      </Text>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <Text variant="small" color="tertiary">
          {plugin.vendor}
        </Text>
        <div className="flex items-center gap-2">
          {badge ? <Badge color={badge.color}>{badge.label}</Badge> : null}
          {connectable ? (
            <Button
              variant="filled"
              size="small"
              disabled={!catalogReady}
              aria-label={`${state?.configured ? "Manage" : "Set Up"} ${plugin.name}`}
              onClick={onSetup}
            >
              {state?.configured ? "Manage" : "Set Up"}
            </Button>
          ) : (
            <Button variant="filled" size="small" aria-label={`Details for ${plugin.name}`} onClick={onDetails}>
              Details
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function McpEditor({
  server,
  isNew,
  open,
  onOpenChange,
  onSaved,
}: {
  server: McpServer;
  /** Not saved yet: a sign-in may store it, and cancelling removes it again. */
  isNew: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const providers = useProviders();
  const [authProvider, setAuthProvider] = React.useState(server.authProvider ?? "");
  const [approvedProviderConnection, setApprovedProviderConnection] = React.useState<string>();
  const [providerAuthorizing, setProviderAuthorizing] = React.useState(false);
  const [name, setName] = React.useState(server.name);
  const [description, setDescription] = React.useState(server.description ?? "");
  const [oauthClientName, setOauthClientName] = React.useState(server.oauthClientName ?? "");
  const [transport, setTransport] = React.useState<McpTransport>(server.transport);
  const [command, setCommand] = React.useState(server.command ?? "");
  const [args, setArgs] = React.useState(argsToLines(server.args));
  const [env, setEnv] = React.useState(recordToLines(server.env));
  const [url, setUrl] = React.useState(server.url ?? "");
  const [headers, setHeaders] = React.useState(recordToLines(server.headers));
  const providerConnection = JSON.stringify([authProvider, url.trim(), transport]);
  const providerApproved = approvedProviderConnection === providerConnection;
  const [oauth, setOauth] = React.useState(Boolean(server.oauth));
  const [authServerMetadataUrl, setAuthServerMetadataUrl] = React.useState(server.authServerMetadataUrl ?? "");
  const metadataError = transport !== "stdio" && oauth ? mcpOAuthMetadataFieldError(authServerMetadataUrl) : undefined;
  const [testing, setTesting] = React.useState(false);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [authorized, setAuthorized] = React.useState(false);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // A new server stored only so it could sign in; removed if the dialog is cancelled.
  const storedForSignIn = React.useRef(false);
  const savedByUser = React.useRef(false);
  const cancelledSignIn = React.useRef(false);
  const dependents = useMcpDependents(isNew ? undefined : server.id);

  React.useEffect(() => {
    if (open) {
      setSaveError(null);
      setName(server.name);
      setAuthProvider(server.authProvider ?? "");
      setApprovedProviderConnection(undefined);
      setDescription(server.description ?? "");
      setOauthClientName(server.oauthClientName ?? "");
      setTransport(server.transport);
      setCommand(server.command ?? "");
      setArgs(argsToLines(server.args));
      setEnv(recordToLines(server.env));
      setUrl(server.url ?? "");
      setHeaders(recordToLines(server.headers));
      setOauth(Boolean(server.oauth));
      setAuthServerMetadataUrl(server.authServerMetadataUrl ?? "");
      setAuthorized(false);
      setNeedsSignIn(false);
      storedForSignIn.current = false;
      savedByUser.current = false;
      if (server.authProvider) {
        void mcpApi.oauthStatus(server.id).then((status) => setApprovedProviderConnection(status.providerAuthorized ? JSON.stringify([server.authProvider ?? "", server.url?.trim() ?? "", server.transport]) : undefined)).catch(() => setApprovedProviderConnection(undefined));
      }
      if (server.oauth) {
        void mcpApi
          .oauthStatus(server.id)
          .then((status) => {
            setAuthorized(status.authorized && !status.needsSignIn);
            setNeedsSignIn(Boolean(status.needsSignIn));
          })
          .catch(() => setAuthorized(false));
      }
    }
  }, [open, server]);

  const build = (): McpServer => ({
    id: server.id,
    name: name.trim(),
    description: description.trim() || undefined,
    oauthClientName: transport !== "stdio" && oauth ? oauthClientName.trim() || undefined : undefined,
    transport,
    enabled: server.enabled,
    command: transport === "stdio" ? command.trim() || undefined : undefined,
    args: transport === "stdio" ? linesToArgs(args) : undefined,
    env: transport === "stdio" ? linesToRecord(env) : undefined,
    url: transport !== "stdio" ? url.trim() || undefined : undefined,
    headers: transport !== "stdio" ? linesToRecord(headers) : undefined,
    oauth: transport !== "stdio" && !authProvider ? oauth || undefined : undefined,
    authProvider: transport === "http" ? authProvider || undefined : undefined,
    authServerMetadataUrl: transport !== "stdio" && oauth ? authServerMetadataUrl.trim() || undefined : undefined,
  });

  const handleProviderConsent = async (allowed: boolean) => {
    setProviderAuthorizing(true);
    try {
      const record = build();
      await mcpApi.save(record);
      await mcpApi.providerAuth(record, allowed);
      setApprovedProviderConnection(allowed ? JSON.stringify([record.authProvider ?? "", record.url?.trim() ?? "", record.transport]) : undefined);
      onSaved();
      toast.success(allowed ? "Provider credential approved for this server on this device." : "Provider credential sharing stopped.");
    } catch (error) { setApprovedProviderConnection(undefined); toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setProviderAuthorizing(false); }
  };

  const handleAuthorize = async () => {
    if (!url.trim()) {
      toast.error("Add the server URL before authorizing.");
      return;
    }
    setAuthorizing(true);
    cancelledSignIn.current = false;
    try {
      const draft = { ...build(), oauth: true };
      // Tokens are stored against a saved endpoint. A new server is saved so it
      // can sign in (and removed again if the dialog is cancelled); an existing
      // one only takes the connection edits sign-in needs, never its other edits.
      const record: McpServer =
        isNew || storedForSignIn.current
          ? draft
          : {
              ...server,
              transport: draft.transport,
              url: draft.url,
              headers: draft.headers,
              oauth: true,
              authProvider: undefined,
              authServerMetadataUrl: draft.authServerMetadataUrl,
              oauthClientName: draft.oauthClientName,
            };
      if (isNew || storedForSignIn.current || mcpConnectionChanged(server, record)) {
        await mcpApi.save(record);
        if (isNew) storedForSignIn.current = true;
      }
      await mcpApi.authorize(record);
      setOauth(true);
      setAuthorized(true);
      setNeedsSignIn(false);
      onSaved();
      toast.success("Authorized — you're signed in.");
    } catch (error) {
      if (!cancelledSignIn.current) toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
    }
  };

  const cancelSignIn = async () => {
    cancelledSignIn.current = true;
    await mcpApi.cancelAuthorize(server.id).catch(() => undefined);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await mcpApi.signOut(server.id);
      setAuthorized(false);
      setNeedsSignIn(false);
      onSaved();
      toast.success("Signed out.");
    } catch (error) {
      toast.error(`Couldn’t sign out: ${errorMessage(error)}`);
    } finally {
      setSigningOut(false);
    }
  };

  const closeEditor = (next: boolean) => {
    if (!next) {
      if (authorizing) void cancelSignIn();
      // Cancelling a new server that was stored only to sign in removes it again.
      if (storedForSignIn.current && !savedByUser.current) {
        storedForSignIn.current = false;
        void mcpApi
          .remove(server.id)
          .catch(() => undefined)
          .then(() => onSaved());
      }
    }
    onOpenChange(next);
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      // Tests the draft as typed; nothing is saved until Save.
      const status = await mcpApi.testDraft(build());
      if (oauth && status.authorized !== undefined) setAuthorized(status.authorized && !status.needsSignIn);
      if (status.needsSignIn) setNeedsSignIn(true);
      if (status.connected) toast.success(`Connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} available.`);
      else toast.error(`Connection failed: ${status.error ?? "unknown error"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={closeEditor}
      title={server.name ? `Edit ${server.name}` : "Add MCP server"}
      description="Configure how Aiden connects to this tool server."
      size="large"
      confirmLabel={saving ? "Saving…" : "Save"}
      busy={saving}
      confirmDisabled={Boolean(metadataError) || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
      onConfirm={async () => {
        setSaving(true);
        setSaveError(null);
        try {
          await mcpApi.save(build());
          savedByUser.current = true;
        } catch (error) {
          const message = errorMessage(error);
          setSaveError(message);
          toast.error(`Couldn’t save ${name.trim() || "this server"}: ${message}`);
          return;
        } finally {
          setSaving(false);
        }
        await Promise.resolve(onSaved()).catch(() => undefined);
        onOpenChange(false);
      }}
    >
      {!isNew && mcpConnectionChanged(server, build()) && mcpDependentsSummary(dependents.data) ? (
        <Callout color="warning" className="mb-3">
          <Text variant="small">
            {mcpDependentsSummary(dependents.data)} {dependents.data!.schedules.length + dependents.data!.bots.length === 1 ? "uses" : "use"} this
            server. Changing how Aiden connects to it asks for their approval again after you save.
          </Text>
        </Callout>
      ) : null}
      <FieldSet>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My MCP server" autoFocus />
        </Field>
        <Field label="Description" description="Optional context to help Aiden find this server’s tools." orientation="vertical">
          <Input aria-label="MCP server description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1024} />
        </Field>
        <Field label="Connection">
          <Select value={transport} onValueChange={(v) => { setTransport(v as McpTransport); setAuthProvider(""); setApprovedProviderConnection(undefined); }}>
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local command (stdio)</SelectItem>
              <SelectItem value="http">Remote URL (Streamable HTTP)</SelectItem>
              <SelectItem value="sse">Remote URL (SSE, legacy)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {transport === "stdio" ? (
          <>
            <Field label="Command">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field
              label="Arguments"
              description="One argument per line, passed to the command exactly as written. Spaces inside a line stay part of that argument."
              orientation="vertical"
            >
              <Textarea
                aria-label="Arguments"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/My Documents"}
                className="max-h-40 font-mono"
                spellCheck={false}
              />
            </Field>
            <Field label="Environment" description="One KEY=VALUE per line. Values are stored in the app configuration on this device." orientation="vertical">
              <Textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=..." className="max-h-40" />
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Server URL"
              description={
                transport === "sse"
                  ? "SSE is the older MCP transport and is deprecated. Prefer Streamable HTTP unless this server only supports SSE."
                  : undefined
              }
            >
              <Input aria-label="Server URL" value={url} onChange={(e) => { setUrl(e.target.value); setApprovedProviderConnection(undefined); }} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" description="One KEY=VALUE per line. Values are stored in the app configuration on this device." orientation="vertical">
              <Textarea disabled={Boolean(authProvider)} value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization=Bearer ..." className="max-h-40" />
            </Field>
            <Field
              label="OAuth sign-in"
              description="For hosted servers that require browser authorization instead of (or with) a key."
            >
              <Switch
                checked={oauth}
                disabled={Boolean(authProvider)}
                onCheckedChange={(value) => {
                  setOauth(value);
                  if (!value) setAuthorized(false);
                }}
              />
            </Field>
            {transport === "http" ? <McpProviderAuthFields providerId={authProvider} endpoint={url.trim()} approved={providerApproved} busy={providerAuthorizing}
              disabled={!name.trim() || !url.trim() || !authProvider || (!providerApproved && !providers.data?.some((provider) => provider.id === authProvider && provider.isBuiltin && provider.hasKey))}
              providers={(providers.data ?? []).filter((provider) => provider.isBuiltin && (provider.hasKey || provider.id === authProvider))}
              onProviderChange={(id) => { setAuthProvider(id); setApprovedProviderConnection(undefined); if (id) { setOauth(false); setHeaders(""); setAuthServerMetadataUrl(""); setOauthClientName(""); } }}
              onConsent={(allowed) => { void handleProviderConsent(allowed); }} /> : null}
            {oauth ? (
              <>
              <Field label="OAuth client name" description="Optional name required by the server’s registration policy. Defaults to Aiden Agent.">
                <Input aria-label="OAuth client name" maxLength={128} value={oauthClientName} onChange={(event) => { setOauthClientName(event.target.value); setAuthorized(false); }} placeholder="Aiden Agent" />
              </Field>
              <McpOAuthMetadataField value={authServerMetadataUrl} onChange={(value) => { setAuthServerMetadataUrl(value); setAuthorized(false); }} />
              <Field
                label="Authorize"
                description={
                  authorizing
                    ? "Finish signing in in your browser, or cancel."
                    : needsSignIn
                      ? "Your sign-in expired or was revoked. Sign in again to reconnect."
                      : authorized
                        ? "Signed in. Re-run to refresh access."
                        : "Opens your browser to sign in."
                }
              >
                <McpSignInControls
                  authorizing={authorizing}
                  authorized={authorized}
                  needsSignIn={needsSignIn}
                  signingOut={signingOut}
                  disabled={!url.trim() || Boolean(metadataError)}
                  onAuthorize={() => void handleAuthorize()}
                  onCancel={() => void cancelSignIn()}
                  onSignOut={() => void handleSignOut()}
                />
              </Field>
              </>
            ) : null}
          </>
        )}

        <Field label="Test">
          <Button size="small" variant="filled" onClick={handleTest} disabled={testing || !name.trim() || Boolean(metadataError)}>
            {testing ? "Connecting…" : "Test connection"}
          </Button>
        </Field>
      </FieldSet>
      {saveError ? (
        <Text as="p" variant="small" color="red" role="alert" className="mt-3">
          Couldn’t save: {saveError}
        </Text>
      ) : null}
    </Dialog>
  );
}

