// Settings → Connectors: Aiden's connector catalog plus custom MCP servers
// (a local command or a remote URL) whose tools become available to the
// assistant. Catalog connectors reuse the preset setup flow.

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
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
  Textarea,
  toast,
} from "../ui";
import { InfoHint } from "../ui-info-hint";
import { MoreHorizontal, Plus, Search, Trash2 } from "lucide-react";
import { mcpApi } from "../../lib/ipc";
import {
  mcpConnectionChanged,
  mcpDependentsSummary,
  mcpLiveStatusView,
  mcpPresetCardStatus,
  mcpServerDraftForEditor,
  mcpServerEditorKind,
  type McpLiveTone,
} from "../../lib/mcp-preset-state";
import {
  queryKeys,
  useMcpDependents,
  useMcpLaunchApprovals,
  useMcpLiveStatus,
  useMcpPresets,
  useMcpServers,
  useProviders,
} from "../../lib/queries";
import type { McpLiveStatus, McpPendingLaunchApproval, McpPresetState, McpServer, McpServerDependents, McpTransport } from "../../lib/types";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  filterConnectorCatalog,
  getConnectorCatalogEntry,
  isConnectorAvailable,
  type ConnectorCatalogEntry,
} from "../../shared/connector-catalog";
import { McpPresetIcon } from "./mcp-preset-icons";
import { PresetSetupDialog } from "./mcp-preset-setup";
import { McpSignInControls } from "./mcp-sign-in-controls";
import { McpExposureControls } from "./mcp-exposure-controls";
import { McpSecretFields, mcpSecretFieldDrafts, mcpSecretFieldRecord } from "./mcp-secret-fields";
import { McpProviderAuthFields, mcpShareableProviders } from "./mcp-provider-auth-fields";
import { McpOAuthMetadataField, mcpOAuthMetadataFieldError } from "./mcp-oauth-metadata-field";
import { McpOAuthClientFields, mcpOAuthClientSecretDraft, mcpOAuthClientSecretValue } from "./mcp-oauth-client-fields";

/** Secret values typed into a custom connector never stay in config.json. */
const STORED_SECRET_DESCRIPTION = "Stored encrypted on this device, never in config.json, and never shown again.";

/** DOM id of a directory card, so another card can move focus to it. */
const connectorCardId = (id: string) => `connector-card-${id}`;

function newServer(): McpServer {
  return { id: `mcp-${Date.now().toString(36)}`, name: "", transport: "stdio", enabled: true, args: [] };
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

/**
 * A local server added or changed outside Aiden never runs until approved
 * here. Shows exactly what would run; approval binds to that launch.
 */
function McpLaunchApproval({
  server,
  approval,
  onApproved,
}: {
  server: McpServer;
  approval: McpPendingLaunchApproval;
  onApproved: () => Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const label = server.name || "this connector";
  const approve = async () => {
    setBusy(true);
    try {
      await mcpApi.approveLaunch(approval.serverId, approval.fingerprint);
      toast.success(`${label} can run now.`);
    } catch (error) {
      toast.error(`Couldn’t approve ${label}: ${errorMessage(error)}`);
    } finally {
      await onApproved().catch(() => undefined);
      setBusy(false);
    }
  };
  return (
    <Callout color="warning" className="mt-2 flex-col items-start gap-2" role="group" aria-label={`${label} needs approval`}>
      <Text variant="small-strong">Added outside Aiden — Approve to run</Text>
      <Text variant="small" color="secondary" className="block">
        This command was added or changed outside Aiden and won’t run until you approve it.
      </Text>
      <code className="block max-w-full whitespace-pre-wrap break-all rounded-control bg-well px-2 py-1 font-mono text-small text-primary">
        {[approval.command, ...approval.args].join("\n")}
      </code>
      {approval.env.length ? (
        <div className="flex max-w-full flex-col gap-1">
          <Text variant="small" color="secondary">Environment</Text>
          {/* Values are shown in full: they change what the command does (for example NODE_OPTIONS). */}
          <code aria-label={`${label} environment`} className="block max-w-full whitespace-pre-wrap break-all rounded-control bg-well px-2 py-1 font-mono text-small text-primary">
            {approval.env
              .map(({ name, value, unavailable }) =>
                `${name}=${value ?? (unavailable ? "(not available — enter it again in Edit)" : "(saved value, not shown)")}`)
              .join("\n")}
          </code>
        </div>
      ) : null}
      <Button variant="filled" size="small" disabled={busy} aria-label={`Approve ${label} to run`} onClick={() => void approve()}>
        {busy ? "Approving…" : "Approve to run"}
      </Button>
    </Callout>
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
      {summary} {dependents!.schedules.length + dependents!.bots.length === 1 ? "uses" : "use"} this connector.{" "}
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
  // Same cache entry as useMcpLiveStatus; only its load state is read here.
  const liveLoaded = useQuery({ queryKey: queryKeys.mcpLiveStatus, queryFn: mcpApi.liveStatus, staleTime: Infinity }).isSuccess;
  const launchApprovals = useMcpLaunchApprovals();
  const removingDependents = useMcpDependents(removing?.id);
  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState<string | "all">("all");
  const [focusCard, setFocusCard] = React.useState<string | null>(null);
  const [toggling, setToggling] = React.useState<ReadonlySet<string>>(() => new Set());
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const [removeError, setRemoveError] = React.useState<string | null>(null);
  const [resetting, setResetting] = React.useState(false);

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.mcpServers }),
      qc.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
      qc.invalidateQueries({ queryKey: queryKeys.mcpLaunchApprovals }),
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
        `Couldn’t ${enabled ? "enable" : "disable"} ${server.name || "this connector"}: ${errorMessage(error)}`,
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
      toast.error(`Couldn’t change model access for ${server.name || "this connector"}: ${errorMessage(error)}`);
    } finally {
      await invalidate().catch(() => undefined);
    }
  };

  const resetConnections = async () => {
    setResetting(true);
    try {
      await mcpApi.reconnect();
      toast.success("Connections reset. Enabled connectors reconnect with your next message.");
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
      toast.info("Connector details are still loading.");
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

  /** Clear the filters so a card is shown, then move focus to its action. */
  const showCard = (id: string) => {
    setSearch("");
    setCategory("all");
    setFocusCard(id);
  };
  React.useEffect(() => {
    if (!focusCard) return;
    // The card itself takes focus: its Set Up button may still be disabled while the catalog loads.
    const card = document.getElementById(connectorCardId(focusCard));
    card?.scrollIntoView?.({ block: "nearest" });
    card?.focus();
    setFocusCard(null);
  }, [focusCard]);

  const list = servers.data ?? [];
  const catalogReady = servers.isSuccess && presets.isSuccess;
  const loadErrors = [
    servers.isError ? { label: "your connectors", query: servers } : null,
    presets.isError ? { label: "connector details", query: presets } : null,
  ].filter((entry) => entry !== null);
  const results = filterConnectorCatalog(CONNECTOR_CATALOG, search, category);

  return (
    <div className="flex flex-col gap-6">
      <div className="settings-page-heading flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <Text as="h1" variant="heading1">Connectors</Text>
            <InfoHint topic="connectors">
              <p>Enabled connectors give the assistant their tools. Tool inputs are sent to that service.</p>
              <p>Folder access in a workspace is a separate permission.</p>
            </InfoHint>
          </span>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Connect apps and tool servers the assistant can use.
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="filled" size="small" onClick={() => setEditing(newServer())}>
            <Plus className="size-4" />
            Add custom connector
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="transparent" size="small" iconOnly aria-label="More connector actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={resetting} onSelect={() => void resetConnections()}>
                {resetting ? "Resetting…" : "Reset connections"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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

      {list.length > 0 ? (
        <FieldSet title={`Your connectors · ${list.length}`} className="mb-0">
          {list.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 ? <Separator className="mx-4 w-auto" /> : null}
              {/* Top-aligned: the model-access controls below the name can expand. */}
              <div className="flex items-start gap-3 px-4 py-3">
                {s.presetId ? (
                  <div
                    aria-hidden
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-strong"
                  >
                    <McpPresetIcon presetId={s.presetId} name={s.name} className="size-4" />
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  <Text variant="strong" truncate className="block">
                    {s.name || "Untitled connector"}
                  </Text>
                  <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                    {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || "No command" : s.url || "No URL"}
                  </Text>
                  <div
                    className="mt-1 flex flex-wrap items-center gap-2"
                    aria-label={`${s.name || "Connector"} status`}
                    aria-live="polite"
                  >
                    <McpLiveIndicator server={s} status={live.get(s.id)} />
                  </div>
                  {s.enabled && !launchApprovals.has(s.id) && live.get(s.id)?.state === "failed" && live.get(s.id)?.error ? (
                    <Text variant="small" color="red" className="mt-0.5 block break-words">
                      {live.get(s.id)!.error}
                    </Text>
                  ) : null}
                  {launchApprovals.get(s.id) ? (
                    <McpLaunchApproval server={s} approval={launchApprovals.get(s.id)!} onApproved={invalidate} />
                  ) : (
                    <McpExposureControls server={s} toolsRevision={live.get(s.id)?.toolsRevision} onSave={saveExposure} />
                  )}
                </div>
                <Button
                  variant="filled"
                  size="small"
                  disabled={Boolean(s.presetId) && !catalogReady}
                  aria-label={`${s.presetId ? "Manage" : "Edit"} ${s.name || "untitled connector"}`}
                  onClick={() => openServer(s)}
                >
                  {s.presetId ? "Manage" : "Edit"}
                </Button>
                <Switch
                  aria-label={`Enable ${s.name || "connector"}`}
                  checked={s.enabled}
                  disabled={toggling.has(s.id)}
                  aria-busy={toggling.has(s.id) || undefined}
                  onCheckedChange={(v) => void toggle(s, v)}
                />
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  aria-label={`Remove ${s.name || "untitled connector"}`}
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
        </FieldSet>
      ) : null}

      <section className="settings-group flex flex-col gap-3" aria-labelledby="connector-directory-title">
        <div className="settings-group-title flex items-center gap-1.5 px-4">
          <h2 id="connector-directory-title" className="text-large-strong text-primary">Directory</h2>
          <InfoHint topic="the connector directory">
            <p>Hosted connectors sign in with your account or use an API key. Aiden stores it encrypted on this device and sends it only to that service.</p>
            <p>Need something else? Add a custom connector for any MCP server.</p>
          </InfoHint>
        </div>
        <label className="flex h-10 items-center gap-2 rounded-control border border-field bg-input px-3 transition-[background-color,box-shadow] duration-150 ease-out focus-within:bg-popover motion-reduce:transition-none">
          <Search aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              setSearch("");
            }}
            placeholder="Search connectors and apps…"
            aria-label="Search connectors"
            className="h-full min-w-0 flex-1 bg-transparent text-regular text-primary outline-none placeholder:text-secondary"
          />
        </label>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter connectors by category">
          {(["all", ...CONNECTOR_CATEGORIES] as const).map((option) => (
            <Button
              key={option}
              size="small"
              variant={category === option ? "muted" : "transparent"}
              aria-pressed={category === option}
              className={category === option ? "bg-list-selection text-primary" : "text-secondary"}
              onClick={() => setCategory(option)}
            >
              {option === "all" ? "All categories" : option}
            </Button>
          ))}
        </div>
        <Text variant="small" color="tertiary" aria-live="polite">
          {results.length} connector{results.length === 1 ? "" : "s"}
        </Text>
        <div className="settings-plugin-grid">
          {results.map(({ entry, matchedAlias }) => {
            const state = presets.data?.find((candidate) => candidate.preset.id === entry.id);
            return (
              <ConnectorCard
                key={entry.id}
                entry={entry}
                state={catalogReady ? state : undefined}
                live={state ? live.get(state.serverId) : undefined}
                liveLoaded={liveLoaded}
                matchedAlias={matchedAlias}
                catalogReady={catalogReady}
                onSetup={() => {
                  if (!state) {
                    toast.error("This connector’s details are unavailable. Reload Settings and try again.");
                    return;
                  }
                  setSetup({
                    state,
                    server: list.find(
                      (s) => s.id === state.serverId && s.presetId === state.preset.id,
                    ),
                  });
                }}
                onShowAlternative={showCard}
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

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Remove this connector?"
        description={
          removing ? (
            <>
              “{removing.name || "Untitled connector"}” will be disconnected and removed.
              <McpDependentsNote
                dependents={removingDependents.data}
                consequence="They will stop running with it until you choose another connector."
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
        title="Turn off this connector?"
        description={
          disabling ? (
            <>
              The assistant stops using “{disabling.server.name || "Untitled connector"}” until you turn it on again.
              <McpDependentsNote
                dependents={disabling.dependents}
                consequence="They cannot use it while it is off."
              />
            </>
          ) : null
        }
        confirmLabel="Turn off"
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

function ConnectorCard({
  entry,
  state,
  live,
  liveLoaded,
  matchedAlias,
  catalogReady,
  onSetup,
  onShowAlternative,
}: {
  entry: ConnectorCatalogEntry;
  state?: McpPresetState;
  live?: McpLiveStatus;
  liveLoaded: boolean;
  /** Set when a search found this card only through one of its aliases. */
  matchedAlias?: string;
  catalogReady: boolean;
  onSetup: () => void;
  onShowAlternative: (id: string) => void;
}) {
  const status = state ? mcpPresetCardStatus(state, live, liveLoaded) : null;
  const available = isConnectorAvailable(entry);
  const alternative = entry.availability?.alternativeId
    ? getConnectorCatalogEntry(entry.availability.alternativeId)
    : undefined;
  return (
    <div
      id={connectorCardId(entry.id)}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${connectorCardId(entry.id)}-name`}
      className="flex flex-col gap-2 settings-card rounded-card p-4 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      <div
        aria-hidden
        className="flex size-9 items-center justify-center rounded-lg bg-well text-strong"
      >
        <McpPresetIcon presetId={entry.id} name={entry.name} className="size-5" />
      </div>
      <Text variant="strong" id={`${connectorCardId(entry.id)}-name`}>{entry.name}</Text>
      <Text variant="small" color="secondary" className="block">
        {entry.tagline}
      </Text>
      {matchedAlias && entry.aliasHint ? (
        <Text variant="small" className="block text-accent-text">
          {entry.aliasHint}
        </Text>
      ) : null}
      {!available ? (
        <Text as="p" variant="small" color="secondary" role="note" className="block">
          {entry.availability!.reason}
        </Text>
      ) : null}
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <Text variant="small" color="tertiary">
          {entry.vendor}
        </Text>
        <div className="flex items-center gap-2">
          {status ? <Badge color={status.color}>{status.label}</Badge> : null}
          {available ? (
            <Button
              variant="filled"
              size="small"
              disabled={!catalogReady}
              aria-label={`${state?.configured ? "Manage" : "Set Up"} ${entry.name}`}
              onClick={onSetup}
            >
              {state?.configured ? "Manage" : "Set Up"}
            </Button>
          ) : alternative ? (
            <Button
              variant="filled"
              size="small"
              aria-label={`Use ${alternative.name} instead of ${entry.name}`}
              onClick={() => onShowAlternative(alternative.id)}
            >
              Use {alternative.name}
            </Button>
          ) : null}
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
  const [oauthClientId, setOauthClientId] = React.useState(server.oauthClientId ?? "");
  const [oauthClientSecret, setOauthClientSecret] = React.useState(() => mcpOAuthClientSecretDraft(server.oauthClientSecret));
  const [transport, setTransport] = React.useState<McpTransport>(server.transport);
  const [command, setCommand] = React.useState(server.command ?? "");
  const [args, setArgs] = React.useState(argsToLines(server.args));
  const [env, setEnv] = React.useState(() => mcpSecretFieldDrafts(server.env));
  const [url, setUrl] = React.useState(server.url ?? "");
  const [headers, setHeaders] = React.useState(() => mcpSecretFieldDrafts(server.headers));
  const providerConnection = JSON.stringify([authProvider, url.trim(), transport]);
  const providerApproved = approvedProviderConnection === providerConnection;
  const [oauth, setOauth] = React.useState(Boolean(server.oauth));
  const [authServerMetadataUrl, setAuthServerMetadataUrl] = React.useState(server.authServerMetadataUrl ?? "");
  const metadataError = transport !== "stdio" && oauth ? mcpOAuthMetadataFieldError(authServerMetadataUrl) : undefined;
  const [testing, setTesting] = React.useState(false);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [authorized, setAuthorized] = React.useState(false);
  const [needsSignIn, setNeedsSignIn] = React.useState(false);
  const [hasSession, setHasSession] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // A new server stored only so it could sign in; removed if the dialog is cancelled.
  const storedForSignIn = React.useRef(false);
  const savedByUser = React.useRef(false);
  const cancelledSignIn = React.useRef(false);
  // Closing while the sign-in save is still in flight must not authorize, and
  // the provisional record is removed once that save settles.
  const closed = React.useRef(false);
  const signInSavePending = React.useRef(false);
  const dependents = useMcpDependents(isNew ? undefined : server.id);

  React.useEffect(() => {
    if (open) {
      setSaveError(null);
      setName(server.name);
      setAuthProvider(server.authProvider ?? "");
      setApprovedProviderConnection(undefined);
      setDescription(server.description ?? "");
      setOauthClientId(server.oauthClientId ?? "");
      setOauthClientSecret(mcpOAuthClientSecretDraft(server.oauthClientSecret));
      setTransport(server.transport);
      setCommand(server.command ?? "");
      setArgs(argsToLines(server.args));
      setEnv(mcpSecretFieldDrafts(server.env));
      setUrl(server.url ?? "");
      setHeaders(mcpSecretFieldDrafts(server.headers));
      setOauth(Boolean(server.oauth));
      setAuthServerMetadataUrl(server.authServerMetadataUrl ?? "");
      setAuthorized(false);
      setNeedsSignIn(false);
      setHasSession(false);
      storedForSignIn.current = false;
      savedByUser.current = false;
      closed.current = false;
      if (server.authProvider) {
        void mcpApi.oauthStatus(server.id).then((status) => setApprovedProviderConnection(status.providerAuthorized ? JSON.stringify([server.authProvider ?? "", server.url?.trim() ?? "", server.transport]) : undefined)).catch(() => setApprovedProviderConnection(undefined));
      }
      if (server.oauth) {
        void mcpApi
          .oauthStatus(server.id)
          .then((status) => {
            setAuthorized(status.authorized && !status.needsSignIn);
            setNeedsSignIn(Boolean(status.needsSignIn));
            setHasSession(Boolean(status.hasSession));
          })
          .catch(() => setAuthorized(false));
      }
    }
  }, [open, server]);

  const build = (): McpServer => ({
    id: server.id,
    name: name.trim(),
    description: description.trim() || undefined,
    oauthClientId: transport !== "stdio" && oauth && !authProvider ? oauthClientId.trim() || undefined : undefined,
    oauthClientSecret: transport !== "stdio" && oauth && !authProvider ? mcpOAuthClientSecretValue(oauthClientId, oauthClientSecret) : undefined,
    transport,
    enabled: server.enabled,
    command: transport === "stdio" ? command.trim() || undefined : undefined,
    args: transport === "stdio" ? linesToArgs(args) : undefined,
    env: transport === "stdio" ? mcpSecretFieldRecord(env) : undefined,
    url: transport !== "stdio" ? url.trim() || undefined : undefined,
    headers: transport !== "stdio" ? mcpSecretFieldRecord(headers) : undefined,
    oauth: transport !== "stdio" && !authProvider ? oauth || undefined : undefined,
    authProvider: transport === "http" ? authProvider || undefined : undefined,
    authServerMetadataUrl: transport !== "stdio" && oauth ? authServerMetadataUrl.trim() || undefined : undefined,
  });

  const handleProviderConsent = async (allowed: boolean) => {
    setProviderAuthorizing(true);
    try {
      const record = await mcpApi.save(build(), { fromEditor: true });
      await mcpApi.providerAuth(record, allowed);
      setApprovedProviderConnection(allowed ? JSON.stringify([record.authProvider ?? "", record.url?.trim() ?? "", record.transport]) : undefined);
      onSaved();
      toast.success(allowed ? "Provider key approved for this connector on this device." : "Provider key sharing stopped.");
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
              oauthClientId: draft.oauthClientId,
              oauthClientSecret: draft.oauthClientSecret,
            };
      // Sign-in uses the stored record: its header values are markers once saved.
      let stored = record;
      // Header and env edits change the configured connection too
      // (mcpConnectionChanged covers them): sign-in is admitted only against the
      // saved record, so they must be saved first.
      if (isNew || storedForSignIn.current || mcpConnectionChanged(server, record)) {
        signInSavePending.current = isNew;
        try {
          stored = await mcpApi.save(record, { fromEditor: true });
        } finally {
          signInSavePending.current = false;
        }
        if (isNew) storedForSignIn.current = true;
      }
      if (closed.current || cancelledSignIn.current) return;
      const result = await mcpApi.authorize(stored);
      setOauth(true);
      setAuthorized(true);
      setNeedsSignIn(false);
      setHasSession(true);
      onSaved();
      if (result.connectionError) toast.error(`Signed in, but connecting failed: ${result.connectionError}`);
      else toast.success("Authorized — you're signed in.");
    } catch (error) {
      if (!cancelledSignIn.current && !closed.current)
        toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
      if (closed.current) discardSignInRecord();
    }
  };

  /** Removes a new server that was stored only so it could sign in. */
  const discardSignInRecord = () => {
    if (!storedForSignIn.current || savedByUser.current || signInSavePending.current) return;
    storedForSignIn.current = false;
    void mcpApi
      .remove(server.id)
      .catch(() => undefined)
      .then(() => onSaved());
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
      setHasSession(false);
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
      closed.current = true;
      if (authorizing) void cancelSignIn();
      // Cancelling a new server that was stored only to sign in removes it again.
      discardSignInRecord();
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
      if (status.hasSession) setHasSession(true);
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
      title={server.name ? `Edit ${server.name}` : "Add custom connector"}
      description="A local command or a remote MCP server whose tools the assistant can use."
      size="large"
      confirmLabel={saving ? "Saving…" : "Save"}
      busy={saving}
      confirmDisabled={Boolean(metadataError) || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
      onConfirm={async () => {
        setSaving(true);
        setSaveError(null);
        try {
          // Saving from the editor, which shows the command, approves a local server to run.
          await mcpApi.save(build(), { approveLaunch: true });
          savedByUser.current = true;
        } catch (error) {
          const message = errorMessage(error);
          setSaveError(message);
          toast.error(`Couldn’t save ${name.trim() || "this connector"}: ${message}`);
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My connector" autoFocus />
        </Field>
        <Field label="Description" description="Optional context to help Aiden find this connector’s tools." orientation="vertical">
          <Input aria-label="Connector description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1024} />
        </Field>
        <Field label="Connection">
          <Select value={transport} onValueChange={(v) => { setTransport(v as McpTransport); setAuthProvider(""); setApprovedProviderConnection(undefined); }}>
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local command (stdio)</SelectItem>
              <SelectItem value="http">Remote URL (Streamable HTTP)</SelectItem>
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
            <Field label="Environment" description={STORED_SECRET_DESCRIPTION} orientation="vertical">
              <McpSecretFields kind="env" fields={env} onChange={setEnv} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Server URL">
              <Input aria-label="Server URL" value={url} onChange={(e) => { setUrl(e.target.value); setApprovedProviderConnection(undefined); }} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" description={STORED_SECRET_DESCRIPTION} orientation="vertical">
              <McpSecretFields kind="headers" fields={headers} onChange={setHeaders} disabled={Boolean(authProvider)} />
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
              disabled={!name.trim() || !url.trim() || !authProvider || (!providerApproved && !mcpShareableProviders(providers.data ?? [], "").some((provider) => provider.id === authProvider))}
              providers={mcpShareableProviders(providers.data ?? [], authProvider)}
              onProviderChange={(id) => { setAuthProvider(id); setApprovedProviderConnection(undefined); if (id) { setOauth(false); setHeaders([]); setAuthServerMetadataUrl(""); setOauthClientId(""); setOauthClientSecret({ value: "", saved: false }); } }}
              onConsent={(allowed) => { void handleProviderConsent(allowed); }} /> : null}
            {oauth ? (
              <>
              <McpOAuthClientFields
                clientId={oauthClientId}
                secret={oauthClientSecret}
                onClientIdChange={(value) => {
                  setOauthClientId(value);
                  setAuthorized(false);
                  // A saved secret belongs to the previous client: it is never sent with another client ID.
                  setOauthClientSecret((secret) => (secret.saved ? { value: "", saved: false } : secret));
                }}
                onSecretChange={setOauthClientSecret}
              />
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
                  hasSession={hasSession}
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

