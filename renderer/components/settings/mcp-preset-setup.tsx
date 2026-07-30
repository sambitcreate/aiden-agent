// Setup dialog for a built-in MCP provider preset (Composio, Notion, Linear, …).
// Mirrors the manual McpEditor but everything is prefilled from the catalog:
// API-key presets collect a key that is stored encrypted in the macOS keychain
// (never in config.json); OAuth presets reuse the browser sign-in flow.

import * as React from "react";
import { Badge, Button, Dialog, Field, FieldSet, Input, Switch, Text, toast } from "../ui";
import { ShieldCheck } from "lucide-react";
import { mcpApi } from "../../lib/ipc";
import { mcpPresetCredentialReady } from "../../lib/mcp-preset-state";
import type { McpPresetState, McpServer } from "../../lib/types";
import { McpPresetIcon } from "./mcp-preset-icons";

export function PresetSetupDialog({
  state,
  server,
  open,
  onOpenChange,
  onSaved,
}: {
  state: McpPresetState;
  /** Existing server record when the preset is already configured. */
  server?: McpServer;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void> | void;
}) {
  const { preset } = state;
  const [name, setName] = React.useState(server?.name ?? preset.name);
  const [url, setUrl] = React.useState(server?.url ?? preset.url);
  const [key, setKey] = React.useState("");
  const [hasKey, setHasKey] = React.useState(state.ready);
  const [authorized, setAuthorized] = React.useState(state.ready);
  const [testing, setTesting] = React.useState(false);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [enabled, setEnabled] = React.useState(server?.enabled ?? state.enabled);

  React.useEffect(() => {
    if (open) {
      setName(server?.name ?? preset.name);
      setUrl(server?.url ?? preset.url);
      setKey("");
      setHasKey(state.ready);
      setAuthorized(state.ready);
      setEnabled(server?.enabled ?? state.enabled);
    }
  }, [open, server, preset, state.enabled, state.ready]);

  const build = (): McpServer => ({
    id: state.serverId,
    name: name.trim(),
    transport: "http",
    url: url.trim() || preset.url,
    oauth: preset.auth.kind === "oauth" ? true : undefined,
    presetId: preset.id,
    enabled,
  });

  const credentialReady = mcpPresetCredentialReady({
    auth: preset.auth,
    hasStoredKey: hasKey,
    draftKey: key,
    authorized,
  });

  const persistKey = async (): Promise<boolean> => {
    if (preset.auth.kind === "apiKey" && key.trim()) {
      const result = await mcpApi.setPresetKey(state.serverId, key.trim());
      setHasKey(result.hasKey);
      setKey("");
      return true;
    }
    return false;
  };

  const handleAuthorize = async () => {
    setAuthorizing(true);
    try {
      const record = build();
      await mcpApi.save(record);
      await mcpApi.authorize(record);
      setAuthorized(true);
      await onSaved();
      toast.success(`Authorized — you're signed in to ${preset.name}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await mcpApi.save(build());
      await persistKey(); // store a freshly pasted key before connecting
      await onSaved();
      const status = await mcpApi.status(build());
      if (status.connected)
        toast.success(
          `Connected — ${status.toolCount} tool${status.toolCount === 1 ? "" : "s"} available.`,
        );
      else toast.error(`Connection failed: ${status.error ?? "unknown error"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    try {
      await mcpApi.setPresetKey(state.serverId, "");
      setHasKey(false);
      setKey("");
      await onSaved();
      toast.success(`Removed the saved ${preset.name} key.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleEnabled = async (nextEnabled: boolean) => {
    if (!server) return;
    const previous = enabled;
    setEnabled(nextEnabled);
    setToggling(true);
    try {
      await mcpApi.save({ ...build(), enabled: nextEnabled });
      await onSaved();
    } catch (error) {
      setEnabled(previous);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md border border-separator bg-well text-strong"
          >
            <McpPresetIcon presetId={preset.id} name={preset.name} className="size-3.5" />
          </span>
          {server ? `Manage ${preset.name}` : `Set up ${preset.name}`}
        </span>
      }
      description={preset.tagline}
      size="large"
      confirmLabel={saving ? "Saving…" : server ? "Save" : "Connect"}
      confirmDisabled={
        saving ||
        testing ||
        authorizing ||
        toggling ||
        !name.trim() ||
        !url.trim() ||
        !credentialReady
      }
      onConfirm={async () => {
        setSaving(true);
        try {
          await mcpApi.save(build());
          await persistKey();
          await onSaved();
          onOpenChange(false);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setSaving(false);
        }
      }}
    >
      <FieldSet>
        {server ? (
          <Field
            label="Status"
            description={
              enabled
                ? "Tools from this server are available to the assistant."
                : "Disabled — the assistant cannot use this server."
            }
          >
            <Switch
              aria-label={`Enable ${preset.name}`}
              checked={enabled}
              disabled={saving || testing || authorizing || toggling}
              onCheckedChange={toggleEnabled}
            />
          </Field>
        ) : null}

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={preset.name}
            autoFocus
          />
        </Field>
        <Field label="Server address" description="The URL where this MCP server is available.">
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (preset.auth.kind === "oauth") setAuthorized(false);
            }}
            placeholder={preset.url}
          />
        </Field>

        {preset.auth.kind === "apiKey" ? (
          <Field
            label={preset.auth.keyLabel}
            description={
              hasKey
                ? "Saved encrypted in the macOS keychain. Paste a new key to replace it."
                : "Stored encrypted in the macOS keychain — never written to the app configuration."
            }
          >
            <div className="flex flex-col gap-1.5">
              <Input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={hasKey ? "••••••••  (saved — paste to replace)" : "Paste your API key"}
                autoComplete="off"
              />
              <a
                href={preset.auth.keyHelpUrl}
                target="_blank"
                rel="noreferrer"
                className="w-fit text-small text-tertiary underline decoration-separator underline-offset-2 hover:text-secondary"
              >
                Get a key from {preset.name}
              </a>
              {hasKey ? (
                <Button
                  size="small"
                  variant="transparent"
                  className="w-fit"
                  disabled={saving || testing}
                  onClick={() => void clearKey()}
                >
                  Remove saved key
                </Button>
              ) : null}
            </div>
          </Field>
        ) : (
          <Field
            label="Authentication"
            description={
              authorized ? "Signed in. Re-run to refresh access." : "Opens your browser to sign in."
            }
          >
            <div className="flex items-center gap-2">
              <Button
                size="small"
                variant="filled"
                onClick={handleAuthorize}
                disabled={saving || testing || authorizing || toggling || !url.trim()}
              >
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
        )}

        <Field label="Test">
          <div className="flex items-center gap-2">
            <Button
              size="small"
              variant="filled"
              onClick={handleTest}
              disabled={
                saving || testing || authorizing || toggling || !name.trim() || !credentialReady
              }
            >
              {testing ? "Connecting…" : "Test connection"}
            </Button>
            {credentialReady ? <Badge color="green">Ready</Badge> : null}
          </div>
        </Field>
      </FieldSet>

      <Text variant="small" color="tertiary" className="mt-2 block">
        Learn more in the{" "}
        <a
          href={preset.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-separator underline-offset-2 hover:text-secondary"
        >
          {preset.name} docs
        </a>
        .
      </Text>
    </Dialog>
  );
}
