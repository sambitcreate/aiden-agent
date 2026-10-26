// Setup dialog for a connector served by a Mac app (iMCP). Aiden doesn't ship,
// install or update the app: this dialog finds the copy in an Applications
// folder, links to its download page or opens it, and saves a connection that
// runs only that app's own server. Saving here approves exactly that command,
// which Connection details shows.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Callout, Dialog, Field, FieldSet, Input, Switch, Text, toast } from "../ui";
import { mcpApi } from "../../lib/ipc";
import { queryKeys, useMcpMacAppStatus } from "../../lib/queries";
import type { McpServer } from "../../lib/types";
import type { MacAppMcpPreset } from "../../shared/connector-catalog";
import { McpPresetIcon } from "./mcp-preset-icons";
import type { PresetSetupDialogProps } from "./mcp-preset-setup";

/** After Open, the app takes a moment to show up as running. */
const OPEN_CHECKS = 5;
const OPEN_CHECK_INTERVAL_MS = 600;

const LINK_CLASS =
  "rounded-control underline decoration-separator underline-offset-2 hover:text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MacAppSetupDialog({
  state,
  preset,
  server,
  open,
  onOpenChange,
  onSaved,
}: PresetSetupDialogProps & { preset: MacAppMcpPreset }) {
  const app = preset.macApp;
  const queryClient = useQueryClient();
  const status = useMcpMacAppStatus(preset.id, open);
  const found = status.data;
  const [name, setName] = React.useState(server?.name ?? preset.name);
  const [enabled, setEnabled] = React.useState(server?.enabled ?? true);
  const [busy, setBusy] = React.useState<"open" | "test" | "save" | "toggle" | null>(null);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  // A failed test or connect adds the checks that usually fix it, next to Test.
  const [failed, setFailed] = React.useState(false);
  const closed = React.useRef(false);

  React.useEffect(() => {
    if (!open) return;
    closed.current = false;
    setName(server?.name ?? preset.name);
    setEnabled(server?.enabled ?? true);
    setConnectionError(null);
    setFailed(false);
    return () => {
      closed.current = true;
    };
  }, [open, server, preset]);

  // Every caller (Settings, Bot setup) must see the saved record and its state.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpPresets }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpLaunchApprovals }),
    ]);
    await onSaved?.();
  };

  const supported = found?.supported !== false;
  const installed = found?.installed === true;
  const appOpen = installed && found?.open === true;
  // The installed copy's server; a saved record keeps its own until the app is found again.
  const command = found?.command ?? server?.command;
  const build = (nextEnabled = enabled): McpServer => ({
    id: state.serverId,
    name: name.trim(),
    transport: "stdio",
    command: command ?? "",
    args: [],
    presetId: preset.id,
    enabled: nextEnabled,
  });
  // This dialog shows the command it saves, so saving approves it to run.
  const save = (record: McpServer) => mcpApi.save(record, { approveLaunch: true });

  const openApp = async () => {
    setBusy("open");
    try {
      await mcpApi.openMacApp(preset.id);
      for (let check = 0; check < OPEN_CHECKS && !closed.current; check += 1) {
        const next = await status.refetch();
        if (next.data?.open) break;
        await new Promise((resolve) => setTimeout(resolve, OPEN_CHECK_INTERVAL_MS));
      }
    } catch (error) {
      toast.error(`Couldn’t open ${preset.name}: ${errorMessage(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    setBusy("test");
    try {
      const result = await mcpApi.testDraft(build());
      setFailed(!result.connected);
      if (result.connected) {
        toast.success(`Connected — ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"} available.`);
      } else {
        toast.error(`Connection failed: ${result.error ?? "unknown error"}`);
      }
    } catch (error) {
      setFailed(true);
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
      void status.refetch();
    }
  };

  const toggleEnabled = async (nextEnabled: boolean) => {
    if (!server) return;
    const previous = enabled;
    setEnabled(nextEnabled);
    setBusy("toggle");
    try {
      await save(build(nextEnabled));
      await refresh();
    } catch (error) {
      setEnabled(previous);
      toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    setBusy("save");
    setConnectionError(null);
    try {
      const record = build();
      await save(record);
      await refresh();
      if (record.enabled) {
        const result = await mcpApi.status(record);
        if (!result.connected) throw new Error(result.error ?? "Saved, but the connection is not ready. Try connecting again.");
        toast.success(`Connected — ${result.toolCount} tools available.`);
      }
      onOpenChange(false);
    } catch (error) {
      const message = errorMessage(error);
      setConnectionError(message);
      setFailed(true);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  };

  const working = busy !== null;

  return (
    <Dialog
      submitOnEnter
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-2.5">
          <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-md bg-well text-strong">
            <McpPresetIcon presetId={preset.id} name={preset.name} className="size-3.5" />
          </span>
          {server ? `Manage ${preset.name}` : `Set up ${preset.name}`}
        </span>
      }
      description={preset.tagline}
      size="large"
      busy={busy === "save" || busy === "test" || busy === "toggle"}
      confirmLabel={busy === "save" ? "Connecting…" : server ? "Save" : "Connect"}
      confirmDisabled={working || !supported || !command || !name.trim()}
      onConfirm={connect}
    >
      {!supported ? (
        <Callout color="warning" role="note" className="mb-3">
          <Text variant="small-strong">{preset.name} works only on a Mac</Text>
          <Text variant="small">Remove it here, or set it up in Aiden on your Mac.</Text>
        </Callout>
      ) : state.error ? (
        <Callout color="red" role="alert" className="mb-3">
          <Text variant="small-strong">This saved connection needs repair</Text>
          <Text variant="small">{state.error} Saving here points it at the {preset.name} app on this Mac.</Text>
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
              disabled={working}
              onCheckedChange={(next) => void toggleEnabled(next)}
            />
          </Field>
        ) : null}

        <Field
          label={`Install ${preset.name}`}
          description={
            status.isError
              ? `Couldn’t check for ${preset.name}: ${errorMessage(status.error)}`
              : !found
                ? `Looking for ${preset.name}…`
                : installed
                  ? `Installed${found.version ? `, version ${found.version}` : ""}.`
                  : `A free Mac app for macOS ${app.minimumMacOS} or later. Download it, move it to your Applications folder, then check again.`
          }
        >
          {installed ? (
            <Badge color="green">Installed</Badge>
          ) : found || status.isError ? (
            <div className="flex flex-wrap items-center gap-2">
              {supported ? (
                <Button variant="filled" size="small" asChild>
                  <a href={app.downloadUrl} target="_blank" rel="noreferrer">
                    Download {preset.name}
                  </a>
                </Button>
              ) : null}
              <Button variant="transparent" size="small" disabled={status.isFetching} onClick={() => void status.refetch()}>
                {status.isFetching ? "Checking…" : "Check again"}
              </Button>
            </div>
          ) : null}
        </Field>

        <Field
          label={`Open ${preset.name}`}
          description={
            appOpen
              ? `Running. Keep it open while you use it with Aiden, or turn on Launch at Login in ${preset.name}’s settings.`
              : `${preset.name} must be open for Aiden to use it.`
          }
        >
          {appOpen ? (
            <Badge color="green">Open</Badge>
          ) : (
            <Button
              variant="filled"
              size="small"
              disabled={!installed || working}
              onClick={() => void openApp()}
            >
              {busy === "open" ? "Opening…" : `Open ${preset.name}`}
            </Button>
          )}
        </Field>

        {/* Said in the row, not a hint: the hint's button would be the first thing the dialog focuses. */}
        <Field
          orientation="vertical"
          label="Choose what Aiden can use"
          description={`${app.chooseAccess} What those services return, such as messages or events, goes to the AI model you chat with.`}
        />

        <details className="px-4 py-3">
          <summary className="cursor-pointer rounded-control text-small-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring">
            Connection details
          </summary>
          <Field label="Name">
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={preset.name} />
          </Field>
          <Field label="Runs" description={`The server inside ${app.bundleName}. Aiden runs nothing else for this connector.`}>
            <code className="block max-w-full whitespace-pre-wrap break-all rounded-control bg-well px-2 py-1 font-mono text-small text-primary">
              {command || `Found once ${preset.name} is installed`}
            </code>
          </Field>
        </details>

        <Field label="Test" description={failed ? `Still not connecting? ${app.troubleshooting}` : undefined}>
          <Button size="small" variant="filled" disabled={working || !supported || !command || !name.trim()} onClick={() => void test()}>
            {busy === "test" ? "Connecting…" : "Test connection"}
          </Button>
        </Field>
      </FieldSet>

      {connectionError ? (
        <Text as="p" variant="small" color="red" role="alert" className="mt-3">
          {connectionError}
        </Text>
      ) : null}
      <Text variant="small" color="tertiary" className="mt-2 block">
        Learn more in the{" "}
        <a href={preset.docsUrl} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          {preset.name} docs
        </a>
        {app.homebrewCask ? (
          <>
            , or install it with Homebrew: <code className="font-mono">brew install --cask {app.homebrewCask}</code>
          </>
        ) : null}
        .
      </Text>
    </Dialog>
  );
}
