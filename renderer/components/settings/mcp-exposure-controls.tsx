// Per-server model access for Settings → Connectors: how the model reaches a
// server's tools (on demand, always listed, or not at all) and which
// individual tools it may use. Changes save through `mcp:save`, which
// reconnects the server.

import * as React from "react";
import { Button, Switch, Text } from "../ui";
import { Disclosure, Segmented, type ChoiceOption } from "../ui-primitives";
import { mcpApi } from "../../lib/ipc";
import { useMcpToolList } from "../../lib/queries";
import type { McpServer, McpToolSummary } from "../../lib/types";
import { mcpServerExposure, type McpExposure } from "../../shared/mcp-exposure";

const EXPOSURE_OPTIONS: readonly ChoiceOption<McpExposure>[] = [
  { value: "auto", label: "On demand" },
  { value: "direct", label: "Always visible" },
  { value: "hidden", label: "Off for the model" },
];

const EXPOSURE_HELP: Record<McpExposure, string> = {
  auto: "The model looks these tools up when it needs them, so they don’t take up room in every message.",
  direct: "Every message lists these tools to the model up front. Handy for tools you use constantly; uses more context.",
  hidden: "Chats, Bots, schedules and the Assistant can’t use this server. You can still test it and sign in here.",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Inventory tools first, then hidden names the server no longer lists (so they can be shown again). */
function toolRows(inventory: readonly McpToolSummary[], hidden: readonly string[]): McpToolSummary[] {
  const names = new Set(inventory.map(({ name }) => name));
  return [...inventory, ...hidden.filter((name) => !names.has(name)).map((name) => ({ name }))];
}

export function McpExposureControls({
  server,
  toolsRevision,
  onSave,
}: {
  server: McpServer;
  /** Inventory revision from live status; a change refreshes the tool list. */
  toolsRevision: string | undefined;
  /** Persist the edited server (the caller refreshes queries and reports errors). */
  onSave: (server: McpServer) => Promise<void>;
}) {
  const [saving, setSaving] = React.useState(false);
  const label = server.name || "MCP server";
  const exposure = mcpServerExposure(server);
  const helpId = React.useId();

  const save = async (patch: Pick<McpServer, "exposure" | "hiddenTools">) => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave({ ...server, ...patch });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Text variant="small" color="secondary">Model access</Text>
        <Segmented
          aria-label={`Model access for ${label}`}
          aria-describedby={helpId}
          value={exposure}
          options={EXPOSURE_OPTIONS}
          disabled={saving}
          onValueChange={(next) => void save({ exposure: next === "auto" ? undefined : next, hiddenTools: server.hiddenTools })}
        />
      </div>
      <Text id={helpId} variant="small" color="tertiary" className="block">
        {EXPOSURE_HELP[exposure]}
      </Text>
      {exposure === "hidden" ? null : (
        <Disclosure
          title={server.hiddenTools?.length ? `Tools · ${server.hiddenTools.length} hidden` : "Tools"}
        >
          <McpToolSwitches
            server={server}
            toolsRevision={toolsRevision}
            disabled={saving}
            onHiddenChange={(hiddenTools) => void save({ exposure: server.exposure, hiddenTools: hiddenTools.length ? hiddenTools : undefined })}
          />
        </Disclosure>
      )}
    </div>
  );
}

/** Mounted only while the Tools disclosure is open, so closed rows never read the list. */
function McpToolSwitches({
  server,
  toolsRevision,
  disabled,
  onHiddenChange,
}: {
  server: McpServer;
  toolsRevision: string | undefined;
  disabled: boolean;
  onHiddenChange: (hiddenTools: string[]) => void;
}) {
  const list = useMcpToolList(server.id, toolsRevision);
  const [loaded, setLoaded] = React.useState<McpToolSummary[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const hidden = server.hiddenTools ?? [];
  const inventory = list.data ?? loaded;

  // Nothing discovered in this session yet: list the tools through the same
  // connection test Settings already offers (it never changes saved state).
  const loadTools = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const status = await mcpApi.testDraft(server);
      if (!status.connected) throw new Error(status.error ?? "Couldn’t connect to this server.");
      setLoaded(status.tools.map((name) => ({ name })));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  if (list.isPending) {
    return <Text variant="small" color="tertiary" className="block py-1">Loading tools…</Text>;
  }
  if (!inventory) {
    return (
      <div className="flex min-w-0 flex-col items-start gap-1.5 py-1">
        <Text variant="small" color="tertiary" className="block">
          Tools appear here once Aiden connects to this server.
        </Text>
        <Button variant="filled" size="small" disabled={loading} onClick={() => void loadTools()}>
          {loading ? "Loading…" : "Load tools"}
        </Button>
        {loadError ? (
          <Text variant="small" color="red" role="alert" className="block break-words">
            Couldn’t load tools: {loadError}
          </Text>
        ) : null}
      </div>
    );
  }
  const rows = toolRows(inventory, hidden);
  if (rows.length === 0) {
    return <Text variant="small" color="tertiary" className="block py-1">This server has no tools.</Text>;
  }
  return (
    <ul className="flex min-w-0 flex-col" aria-label={`${server.name || "MCP server"} tools`}>
      {rows.map((tool) => {
        const shown = !hidden.includes(tool.name);
        const title = tool.title || tool.name;
        return (
          <li key={tool.name} className="flex min-w-0 items-center gap-3 py-1">
            <div className="min-w-0 flex-1">
              <Text variant="small" truncate className="block">{title}</Text>
              {tool.title && tool.title !== tool.name ? (
                <Text variant="small" color="tertiary" truncate className="block">{tool.name}</Text>
              ) : null}
            </div>
            <Switch
              aria-label={`Let the model use ${title}`}
              checked={shown}
              disabled={disabled}
              onCheckedChange={(next) =>
                onHiddenChange(next ? hidden.filter((name) => name !== tool.name) : [...hidden, tool.name])
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
