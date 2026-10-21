// Setup dialog for a built-in MCP provider preset (Composio, Notion, Linear, …).
// Mirrors the manual McpEditor but everything is prefilled from the catalog:
// API-key presets collect a key that is stored encrypted in the system credential store
// (never in config.json); OAuth presets reuse the browser sign-in flow.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Callout, Dialog, Field, FieldSet, Input, Switch, Text, toast } from "../ui";
import { McpSignInControls } from "./mcp-sign-in-controls";
import { mcpApi } from "../../lib/ipc";
import { queryKeys } from "../../lib/queries";
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
  /** Extra refresh after a save; server and preset caches are always refreshed. */
  onSaved?: () => Promise<void> | void;
}) {
  const { preset } = state;
  const queryClient = useQueryClient();
  // Every caller (Settings, Bot setup) must see the saved record and its new
  // credential state, so the dialog owns the shared cache refresh.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
    ]);
    await onSaved?.();
  };
  // A saved record that failed validation (e.g. a tampered origin) is repaired
  // by starting from the official address; valid custom paths are kept.
  const initialUrl = state.invalidRecord ? preset.url : (server?.url ?? preset.url);
  const [name, setName] = React.useState(server?.name ?? preset.name);
  const [url, setUrl] = React.useState(initialUrl);
  const [key, setKey] = React.useState("");
  const [hasKey, setHasKey] = React.useState(state.ready);
  const [authorized, setAuthorized] = React.useState(state.ready);
  const [needsSignIn, setNeedsSignIn] = React.useState(Boolean(state.needsSignIn));
  const [hasSession, setHasSession] = React.useState(Boolean(state.hasSession));
  const [signingOut, setSigningOut] = React.useState(false);
  // Set up for sign-in only: removed again if the dialog closes without Connect.
  const storedForSignIn = React.useRef(false);
  const confirmed = React.useRef(false);
  const cancelledSignIn = React.useRef(false);
  // Closing while the sign-in save is still in flight must not authorize, and
  // the provisional record is removed once that save settles.
  const closed = React.useRef(false);
  const signInSavePending = React.useRef(false);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [toggling, setToggling] = React.useState(false);
  const [enabled, setEnabled] = React.useState(server?.enabled ?? true);

  React.useEffect(() => {
    if (open) {
      setConnectionError(null);
      setName(server?.name ?? preset.name);
      setUrl(initialUrl);
      setKey("");
      setHasKey(state.ready);
      setAuthorized(state.ready);
      setNeedsSignIn(Boolean(state.needsSignIn));
      setHasSession(Boolean(state.hasSession));
      setEnabled(server?.enabled ?? true);
      storedForSignIn.current = false;
      confirmed.current = false;
      closed.current = false;
    }
  }, [open, server, preset, initialUrl, state.enabled, state.ready, state.needsSignIn, state.hasSession]);

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
    cancelledSignIn.current = false;
    try {
      // Tokens need a saved endpoint. A new preset is stored for sign-in and
      // removed again if the dialog is cancelled; a configured one only takes
      // an address change, never its other unsaved edits.
      const address = url.trim() || preset.url;
      const record: McpServer = server && !storedForSignIn.current ? { ...server, url: address } : build();
      if (!server || storedForSignIn.current) {
        signInSavePending.current = true;
        try {
          await mcpApi.save(record);
        } finally {
          signInSavePending.current = false;
        }
        storedForSignIn.current = true;
      } else if (server.url !== address) {
        await mcpApi.save(record);
      }
      if (closed.current || cancelledSignIn.current) return;
      const result = await mcpApi.authorize(record);
      setAuthorized(true);
      setNeedsSignIn(false);
      setHasSession(true);
      await refresh();
      if (result.connectionError) toast.error(`Signed in to ${preset.name}, but connecting failed: ${result.connectionError}`);
      else toast.success(`Authorized — you're signed in to ${preset.name}.`);
    } catch (error) {
      if (!cancelledSignIn.current && !closed.current)
        toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthorizing(false);
      if (closed.current) discardSignInRecord();
    }
  };

  /** Removes a record stored only so a new preset could sign in. */
  const discardSignInRecord = () => {
    if (!storedForSignIn.current || confirmed.current || signInSavePending.current) return;
    storedForSignIn.current = false;
    void mcpApi
      .remove(state.serverId)
      .catch(() => undefined)
      .then(refresh);
  };

  const cancelSignIn = async () => {
    cancelledSignIn.current = true;
    await mcpApi.cancelAuthorize(state.serverId).catch(() => undefined);
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await mcpApi.signOut(state.serverId);
      setAuthorized(false);
      setNeedsSignIn(false);
      setHasSession(false);
      await refresh();
      toast.success(`Signed out of ${preset.name}.`);
    } catch (error) {
      toast.error(`Couldn’t sign out: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSigningOut(false);
    }
  };

  const closeDialog = (next: boolean) => {
    if (!next) {
      closed.current = true;
      if (authorizing) void cancelSignIn();
      discardSignInRecord();
    }
    onOpenChange(next);
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      // Tests the draft (and any pasted key) without saving either.
      const status = await mcpApi.testDraft(
        build(),
        preset.auth.kind === "apiKey" && key.trim() ? key.trim() : undefined,
      );
      if (status.needsSignIn) {
        setNeedsSignIn(true);
        setAuthorized(false);
      }
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
      await refresh();
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
      await refresh();
    } catch (error) {
      setEnabled(previous);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setToggling(false);
    }
  };

  return (
    <Dialog
      submitOnEnter
      open={open}
      onOpenChange={closeDialog}
      title={
        <span className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-well text-strong"
          >
            <McpPresetIcon presetId={preset.id} name={preset.name} className="size-3.5" />
          </span>
          {server ? `Manage ${preset.name}` : `Set up ${preset.name}`}
        </span>
      }
      description={preset.tagline}
      size="large"
      busy={saving || testing || toggling}
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
        setSaving(true); setConnectionError(null);
        try {
          await mcpApi.save(build());
          confirmed.current = true;
          await persistKey();
          await refresh();
          if (enabled) {
            const status = await mcpApi.status(build());
            if (!status.connected) throw new Error(status.error ?? "Saved, but the connection is not ready. Try connecting again.");
            toast.success(`Connected — ${status.toolCount} tools available.`);
          }
          onOpenChange(false);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setConnectionError(message); toast.error(message);
        } finally {
          setSaving(false);
        }
      }}
    >
      {state.error ? (
        <Callout color="red" role="alert" className="mb-3">
          <Text variant="small-strong">This saved connection needs repair</Text>
          <Text variant="small">
            {state.error}{" "}
            {state.invalidRecord
              ? `Saving here restores ${preset.name}’s official settings.`
              : "Try again, or re-enter your credentials below."}
          </Text>
        </Callout>
      ) : null}
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

        <Text as="p" variant="small" color="secondary" className="p-4">Sign in or add your key to connect {preset.name}. This service receives the requests made with its tools. Review its account permissions during sign-in.</Text>
        <details className="px-4 py-3">
          <summary className="cursor-pointer rounded-control text-small-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">Connection details</summary>
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

        </details>
        {preset.auth.kind === "apiKey" ? (
          <Field
            label={preset.auth.keyLabel}
            description={
              hasKey
                ? "Saved encrypted in the system credential store. Paste a new key to replace it."
                : "Stored encrypted in the system credential store — never written to the app configuration."
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
              authorizing
                ? "Finish signing in in your browser, or cancel."
                : needsSignIn
                  ? `Your ${preset.name} sign-in expired or was revoked. Sign in again to reconnect.`
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
              disabled={saving || testing || toggling || !url.trim()}
              onAuthorize={() => void handleAuthorize()}
              onCancel={() => void cancelSignIn()}
              onSignOut={() => void handleSignOut()}
            />
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
            {credentialReady ? <Badge>Credentials saved</Badge> : null}
          </div>
        </Field>
      </FieldSet>

      {connectionError ? <Text as="p" variant="small" color="red" role="alert" className="mt-3">{connectionError}</Text> : null}
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
