// Plugins settings — Codex official directory plus custom MCP servers whose
// tools become available to the assistant. Connectable plugins reuse the
// hosted HTTP preset flow; other directory entries explain compatibility.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  Badge,
  Button,
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
import { Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { mcpApi } from "../../lib/ipc";
import {
  mcpPresetConnectionBadge,
  mcpServerDraftForEditor,
  mcpServerEditorKind,
} from "../../lib/mcp-preset-state";
import { queryKeys, useMcpPresets, useMcpServers } from "../../lib/queries";
import type { McpPresetState, McpServer, McpTransport } from "../../lib/types";
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

export function McpSettings() {
  const qc = useQueryClient();
  const servers = useMcpServers();
  const presets = useMcpPresets();
  const [editing, setEditing] = React.useState<McpServer | null>(null);
  const [setup, setSetup] = React.useState<{ state: McpPresetState; server?: McpServer } | null>(null);
  const [removing, setRemoving] = React.useState<McpServer | null>(null);
  const [pluginSearch, setPluginSearch] = React.useState("");
  const [pluginCategory, setPluginCategory] = React.useState<string | "all">("all");
  const [pluginFilter, setPluginFilter] = React.useState<PluginCompatibilityFilter>("all");
  const [pluginDetails, setPluginDetails] = React.useState<PluginCatalogEntry | null>(null);

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.mcpServers }),
      qc.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
    ]);
  };

  const toggle = async (server: McpServer, enabled: boolean) => {
    await mcpApi.save({ ...server, enabled });
    await invalidate();
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
          onClick={async () => {
            await mcpApi.reconnect();
            toast.success("Connections reset. Enabled servers reconnect with your next message.");
          }}
        >
          <RefreshCw className="size-4" />
          Reset connections
        </Button>
      </div>

      <div className="flex items-center justify-between gap-4 settings-card rounded-card border border-separator px-3.5 py-3">
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
          <div className="settings-card rounded-card border border-separator">
            {list.map((s, i) => (
              <React.Fragment key={s.id}>
                {i > 0 ? <Separator /> : null}
                <div className="flex items-center gap-3 px-3.5 py-3">
                  {s.presetId ? (
                    <div
                      aria-hidden
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-separator bg-well text-strong"
                    >
                      <McpPresetIcon presetId={s.presetId} name={s.name} className="size-4" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Text variant="strong" truncate>
                        {s.name || "Untitled server"}
                      </Text>
                      <Badge color="secondary">{s.transport}</Badge>
                      {mcpServerEditorKind(s, catalogReady, presets.data ?? []) === "preset" ? (
                        <Badge color="blue">built-in</Badge>
                      ) : null}
                    </div>
                    <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                      {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || "No command" : s.url || "No URL"}
                    </Text>
                  </div>
                  <Button
                    variant="filled"
                    size="small"
                    disabled={Boolean(s.presetId) && !catalogReady}
                    onClick={() => openServer(s)}
                  >
                    {s.presetId ? "Manage" : "Edit"}
                  </Button>
                  <Switch aria-label={`Enable ${s.name || "MCP server"}`} checked={s.enabled} onCheckedChange={(v) => toggle(s, v)} />
                  <Button variant="transparent" size="small" iconOnly aria-label="Remove server" onClick={() => setRemoving(s)}>
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
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
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
              <Badge color="secondary">{pluginCompatibilityLabel(pluginDetails.compatibility)}</Badge>
              <Badge color="secondary">{pluginDetails.category}</Badge>
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
        description={removing ? `“${removing.name || "Untitled server"}” will be disconnected and removed.` : null}
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (removing) {
            await mcpApi.remove(removing.id);
            await invalidate();
          }
          setRemoving(null);
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
    <div className="flex flex-col gap-2 settings-card rounded-card border border-separator p-4">
      <div
        aria-hidden
        className="flex size-9 items-center justify-center rounded-lg border border-separator bg-well text-strong"
      >
        <McpPresetIcon presetId={plugin.id} name={plugin.name} className="size-5" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Text variant="strong">{plugin.name}</Text>
        <Badge color="secondary">{pluginCompatibilityLabel(plugin.compatibility)}</Badge>
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
            <Button variant="filled" size="small" disabled={!catalogReady} onClick={onSetup}>
              {state?.configured ? "Manage" : "Set Up"}
            </Button>
          ) : (
            <Button variant="filled" size="small" onClick={onDetails}>
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
  open,
  onOpenChange,
  onSaved,
}: {
  server: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(server.name);
  const [transport, setTransport] = React.useState<McpTransport>(server.transport);
  const [command, setCommand] = React.useState(server.command ?? "");
  const [args, setArgs] = React.useState((server.args ?? []).join(" "));
  const [env, setEnv] = React.useState(recordToLines(server.env));
  const [url, setUrl] = React.useState(server.url ?? "");
  const [headers, setHeaders] = React.useState(recordToLines(server.headers));
  const [oauth, setOauth] = React.useState(Boolean(server.oauth));
  const [testing, setTesting] = React.useState(false);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [authorized, setAuthorized] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(server.name);
      setTransport(server.transport);
      setCommand(server.command ?? "");
      setArgs((server.args ?? []).join(" "));
      setEnv(recordToLines(server.env));
      setUrl(server.url ?? "");
      setHeaders(recordToLines(server.headers));
      setOauth(Boolean(server.oauth));
      setAuthorized(false);
      if (server.oauth) {
        void mcpApi.oauthStatus(server.id).then((status) => setAuthorized(status.authorized)).catch(() => setAuthorized(false));
      }
    }
  }, [open, server]);

  const build = (): McpServer => ({
    id: server.id,
    name: name.trim(),
    transport,
    enabled: server.enabled,
    command: transport === "stdio" ? command.trim() || undefined : undefined,
    args: transport === "stdio" ? args.trim().split(/\s+/).filter(Boolean) : undefined,
    env: transport === "stdio" ? linesToRecord(env) : undefined,
    url: transport !== "stdio" ? url.trim() || undefined : undefined,
    headers: transport !== "stdio" ? linesToRecord(headers) : undefined,
    oauth: transport !== "stdio" ? oauth || undefined : undefined,
  });

  const handleAuthorize = async () => {
    if (!url.trim()) {
      toast.error("Add the server URL before authorizing.");
      return;
    }
    setAuthorizing(true);
    try {
      const server = { ...build(), oauth: true };
      await mcpApi.save(server); // authorization may only target the durable endpoint
      await mcpApi.authorize(server);
      setOauth(true);
      setAuthorized(true);
      onSaved();
      toast.success("Authorized — you're signed in.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const record = build();
      await mcpApi.save(record);
      const status = await mcpApi.status(record);
      if (oauth) setAuthorized(Boolean(status.authorized));
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
      onOpenChange={onOpenChange}
      title={server.name ? `Edit ${server.name}` : "Add MCP server"}
      description="Configure how Aiden connects to this tool server."
      size="large"
      confirmLabel="Save"
      confirmDisabled={!name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}
      onConfirm={async () => {
        await mcpApi.save(build());
        onSaved();
        onOpenChange(false);
      }}
    >
      <FieldSet>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My MCP server" autoFocus />
        </Field>
        <Field label="Connection">
          <Select value={transport} onValueChange={(v) => setTransport(v as McpTransport)}>
            <SelectTrigger size="small">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="stdio">Local command (stdio)</SelectItem>
              <SelectItem value="http">Remote URL (HTTP)</SelectItem>
              <SelectItem value="sse">Remote URL (SSE)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {transport === "stdio" ? (
          <>
            <Field label="Command">
              <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field label="Arguments" description="Space-separated arguments passed to the command.">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
            </Field>
            <Field label="Environment" description="One KEY=VALUE per line. Values are stored in the app configuration on this Mac." orientation="vertical">
              <Textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=..." className="max-h-40" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Server URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" description="One KEY=VALUE per line. Values are stored in the app configuration on this Mac." orientation="vertical">
              <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization=Bearer ..." className="max-h-40" />
            </Field>
            <Field
              label="OAuth sign-in"
              description="For hosted servers that require browser authorization instead of (or with) a key."
            >
              <Switch
                checked={oauth}
                onCheckedChange={(value) => {
                  setOauth(value);
                  if (!value) setAuthorized(false);
                }}
              />
            </Field>
            {oauth ? (
              <Field label="Authorize" description={authorized ? "Signed in. Re-run to refresh access." : "Opens your browser to sign in."}>
                <div className="flex items-center gap-2">
                  <Button size="small" variant="filled" onClick={handleAuthorize} disabled={authorizing || !url.trim()}>
                    {authorizing ? "Waiting for browser…" : authorized ? "Re-authorize" : "Authorize"}
                  </Button>
                  {authorized ? (
                    <span className="flex items-center gap-1 text-small text-support-green">
                      <ShieldCheck className="size-4" />
                      Authorized
                    </span>
                  ) : null}
                </div>
              </Field>
            ) : null}
          </>
        )}

        <Field label="Test">
          <Button size="small" variant="filled" onClick={handleTest} disabled={testing || !name.trim()}>
            {testing ? "Connecting…" : "Test connection"}
          </Button>
        </Field>
      </FieldSet>
    </Dialog>
  );
}
