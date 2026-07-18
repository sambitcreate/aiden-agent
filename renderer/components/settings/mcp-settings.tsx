// MCP Servers settings — connect local (stdio) or remote (HTTP/SSE) MCP servers
// whose tools become available to the assistant. Add, edit, test, enable, remove.

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
} from "@glaze/core/components";
import { Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { mcpApi } from "../../lib/ipc";
import { queryKeys, useMcpServers } from "../../lib/queries";
import type { McpServer, McpTransport } from "../../lib/types";

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
  const [editing, setEditing] = React.useState<McpServer | null>(null);
  const [removing, setRemoving] = React.useState<McpServer | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.mcpServers });

  const toggle = async (server: McpServer, enabled: boolean) => {
    await mcpApi.save({ ...server, enabled });
    await invalidate();
  };

  const list = servers.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <Text variant="strong">MCP Servers</Text>
          <Text variant="small" color="secondary" className="mt-0.5 block">
            Connect Model Context Protocol servers to give the assistant extra tools.
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="transparent"
            size="small"
            onClick={async () => {
              await mcpApi.reconnect();
              toast.success("Reconnecting — new tools apply on your next message.");
            }}
          >
            <RefreshCw className="size-4" />
            Reload
          </Button>
          <Button variant="filled" size="small" onClick={() => setEditing(newServer())}>
            <Plus className="size-4" />
            Add server
          </Button>
        </div>
      </div>

      {list.length === 0 ? (
        <Text variant="small" color="tertiary">
          No MCP servers yet. Add a local command (e.g. an npx-based server) or a remote URL.
        </Text>
      ) : (
        <div className="rounded-card border border-separator">
          {list.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 ? <Separator /> : null}
              <div className="flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Text variant="strong" truncate>
                      {s.name || "Untitled server"}
                    </Text>
                    <Badge color="secondary">{s.transport}</Badge>
                  </div>
                  <Text variant="small" color="tertiary" truncate className="mt-0.5 block">
                    {s.transport === "stdio" ? [s.command, ...(s.args ?? [])].filter(Boolean).join(" ") || "No command" : s.url || "No URL"}
                  </Text>
                </div>
                <Button variant="filled" size="small" onClick={() => setEditing(s)}>
                  Edit
                </Button>
                <Switch checked={s.enabled} onCheckedChange={(v) => toggle(s, v)} />
                <Button variant="transparent" size="small" iconOnly aria-label="Remove server" onClick={() => setRemoving(s)}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </React.Fragment>
          ))}
        </div>
      )}

      {editing ? (
        <McpEditor
          server={editing}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={invalidate}
        />
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
  const [authorized, setAuthorized] = React.useState(Boolean(server.oauth));

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
      setAuthorized(Boolean(server.oauth));
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
      await mcpApi.authorize(server);
      await mcpApi.save(server); // persist the OAuth flag + keep the sign-in
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
      const status = await mcpApi.status(build());
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
      size="large"
      confirmLabel="Save"
      confirmDisabled={!name.trim()}
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
            <Field label="Arguments" description="Space-separated.">
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
            </Field>
            <Field label="Environment" description="One KEY=VALUE per line." orientation="vertical">
              <Textarea value={env} onChange={(e) => setEnv(e.target.value)} placeholder="API_KEY=..." className="max-h-40" />
            </Field>
          </>
        ) : (
          <>
            <Field label="Server URL">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" />
            </Field>
            <Field label="Headers" description="One Key: Value as Key=Value per line." orientation="vertical">
              <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} placeholder="Authorization=Bearer ..." className="max-h-40" />
            </Field>
            <Field
              label="OAuth sign-in"
              description="For hosted servers that require browser authorization instead of (or with) a key."
            >
              <Switch checked={oauth} onCheckedChange={setOauth} />
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
