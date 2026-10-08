/**
 * Adapted from t3code apps/web/src/components/settings/DeviceHostsSettings.tsx,
 * DeviceHostEditor.tsx, and useHostConnectionChecks.ts @ a6ec88f7 (MIT)
 *
 * Settings → Simulator → SSH hosts. Each host is a Mac the user reaches with
 * the system `ssh`. Aiden contacts a host only from a button here or in the
 * Simulator tab: Connect, Retry, Test connection, Install, or Check versions.
 */
import * as React from "react";
import { LoaderCircle, MoreHorizontal, Plus, Server } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldSet,
  Input,
  Text,
  type BadgeColor,
} from "../ui";
import { devicesApi } from "../../lib/ipc";
import type { DeviceHostInfo, DeviceServiceState } from "../../shared/devices";
import {
  describeDeviceHostCheck,
  sshDeviceHostDraft,
  toolMissing,
  validateSshDeviceHostDraft,
  type DeviceHostCheck,
  type SshDeviceHostConfig,
  type SshDeviceHostDraft,
} from "../../shared/device-ssh-hosts";
import { DEVICE_TOOL_LABELS, hostStatusText, toolVersionSummary } from "../device-host-diagnostics";

export type SshHostAction = "connect" | "test" | "install-hub" | "install-agent" | "remove" | "save";

export interface SimulatorSshHostsViewProps {
  state: DeviceServiceState;
  /** `<action>:<hostId>` while a host action runs. */
  pending: string | null;
  checks: Readonly<Record<string, DeviceHostCheck>>;
  error: string | null;
  onAdd(): void;
  onEdit(host: SshDeviceHostConfig): void;
  onConnect(host: SshDeviceHostConfig): void;
  onTest(host: SshDeviceHostConfig): void;
  onInstall(host: SshDeviceHostConfig, tool: "hub" | "agent"): void;
  onRemove(host: SshDeviceHostConfig): void;
}

function statusBadge(host: DeviceHostInfo | undefined): { label: string; color: BadgeColor } {
  switch (host?.status) {
    case "ready":
      return { label: "Connected", color: "green" };
    case "installing":
      return { label: "Installing", color: "blue" };
    case "starting":
      return { label: "Connecting", color: "blue" };
    case "needs-consent":
      return { label: "Needs install", color: "warning" };
    case "error":
      return { label: "Failed", color: "red" };
    case "unavailable":
      return { label: "Unavailable", color: "gray" };
    default:
      return { label: "Not connected", color: "gray" };
  }
}

function destination(host: SshDeviceHostConfig): string {
  return host.port === undefined ? host.target : `${host.target}, port ${host.port}`;
}

export function SimulatorSshHostsView({
  state,
  pending,
  checks,
  error,
  onAdd,
  onEdit,
  onConnect,
  onTest,
  onInstall,
  onRemove,
}: SimulatorSshHostsViewProps) {
  const hosts = state.sshHosts ?? [];
  const streaming = state.consent.streaming;
  const busy = pending !== null;
  return (
    <FieldSet title="SSH hosts">
      <Field
        label="Simulators on other Macs"
        description="Reach a Mac you can already SSH into. It needs Xcode, Node.js 22 or newer, and npm. Aiden uses your SSH keys and config, never stores passwords, and connects only when you ask."
      >
        <div className="flex justify-end">
          <Button size="small" variant="muted" disabled={busy || state.hostStatus === "disabled"} onClick={onAdd}>
            <Plus aria-hidden />
            Add SSH host
          </Button>
        </div>
      </Field>
      {hosts.map((host) => {
        const info = state.hosts.find((candidate) => candidate.id === host.id);
        const badge = statusBadge(info);
        const check = checks[host.id];
        const working = pending?.endsWith(`:${host.id}`) ?? false;
        const progress = info?.status === "installing" || info?.status === "starting";
        const agentMissing =
          state.consent.agentAccess && info?.status === "ready" && toolMissing(info.tools?.agent);
        return (
          <div
            key={host.id}
            data-ssh-host-id={host.id}
            className="relative flex items-start gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden max-[540px]:flex-wrap"
          >
            <Server className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden />
            <div className="min-w-0 flex-1">
              <Text variant="small-strong" truncate className="block">
                {host.label}
              </Text>
              <Text variant="small" color="secondary" className="block break-all font-mono">
                {destination(host)}
              </Text>
              <Text
                variant="small"
                color={info?.status === "error" ? "status-red" : "secondary"}
                className="block break-words"
                role="status"
              >
                {info ? hostStatusText(info) : "Not connected."}
                {!streaming ? " Turn on simulator streaming to connect." : ""}
              </Text>
              {(["hub", "agent"] as const).map((tool) => (
                <Text key={tool} variant="small" color="secondary" className="block">
                  {DEVICE_TOOL_LABELS[tool]}: <span className="font-mono">{toolVersionSummary(info?.tools?.[tool])}</span>
                </Text>
              ))}
              {info?.toolInspectionError ? (
                <Text variant="small" color="status-red" className="block break-words">
                  {info.toolInspectionError}
                </Text>
              ) : null}
              {check ? (
                <Text
                  variant="small"
                  color={check.status === "failed" ? "status-red" : "secondary"}
                  className="block break-words"
                  role={check.status === "failed" ? "alert" : "status"}
                >
                  {describeDeviceHostCheck(check)}
                </Text>
              ) : null}
            </div>
            <Badge color={badge.color} className="whitespace-nowrap">
              {badge.label}
            </Badge>
            {info?.status === "needs-consent" ? (
              <Button size="small" variant="filled" disabled={busy || !streaming} onClick={() => onInstall(host, "hub")}>
                Install…
              </Button>
            ) : agentMissing ? (
              <Button size="small" variant="filled" disabled={busy} onClick={() => onInstall(host, "agent")}>
                Install agent tools…
              </Button>
            ) : (
              <Button
                size="small"
                variant="transparent"
                disabled={busy || progress || !streaming}
                aria-label={`${info?.status === "error" ? "Retry" : info?.status === "ready" ? "Refresh" : "Connect"} ${host.label}`}
                onClick={() => onConnect(host)}
              >
                {working || progress ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
                {info?.status === "error" ? "Retry" : info?.status === "ready" ? "Refresh" : "Connect"}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button iconOnly size="small" variant="transparent" disabled={busy} aria-label={`More for ${host.label}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onTest(host)}>Test connection</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onEdit(host)}>Edit…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onRemove(host)}>Remove…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      {error ? (
        <Field>
          <Text variant="small" color="status-red" role="alert" className="block">
            {error}
          </Text>
        </Field>
      ) : null}
    </FieldSet>
  );
}

export interface SshHostEditorProps {
  open: boolean;
  isNew: boolean;
  initial: SshDeviceHostDraft;
  check: DeviceHostCheck | null;
  saving: boolean;
  error: string | null;
  onTest(config: SshDeviceHostConfig): void;
  onSave(config: SshDeviceHostConfig): void;
  onClose(): void;
}

const FIELDS = [
  { key: "label", label: "Name", placeholder: "Mac mini", hint: "Shown in the Simulator tab." },
  { key: "target", label: "SSH target", placeholder: "user@host or an SSH config alias", hint: undefined },
  { key: "identityFile", label: "Identity file", placeholder: "Optional, e.g. ~/.ssh/id_ed25519", hint: "Leave empty to use your SSH config." },
  { key: "port", label: "Port", placeholder: "22", hint: undefined },
] as const;

export interface SshHostEditorFormProps {
  draft: SshDeviceHostDraft;
  /** Show every field's problem, not only those of fields the user has filled. */
  attempted: boolean;
  check: DeviceHostCheck | null;
  saving: boolean;
  error: string | null;
  onChange(draft: SshDeviceHostDraft): void;
  onTest(config: SshDeviceHostConfig): void;
}

/** The editor's fields, each problem beside its input, and Test connection. */
export function SshHostEditorForm({ draft, attempted, check, saving, error, onChange, onTest }: SshHostEditorFormProps) {
  const formId = React.useId();
  const result = validateSshDeviceHostDraft(draft);
  const problems: Partial<Record<keyof SshDeviceHostDraft, string>> = {};
  for (const [key, message] of Object.entries(result.errors ?? {})) {
    if (attempted || draft[key as keyof SshDeviceHostDraft].trim()) problems[key as keyof SshDeviceHostDraft] = message;
  }
  const checking = check?.status === "pending";
  return (
    <div className="flex flex-col gap-3">
      {FIELDS.map((field) => {
        const id = `${formId}-${field.key}`;
        const problem = problems[field.key];
        const describedBy = problem ? `${id}-error` : field.hint ? `${id}-hint` : undefined;
        return (
          <div key={field.key} className="flex flex-col gap-1">
            <label htmlFor={id} className="text-small-strong text-primary">
              {field.label}
            </label>
            <Input
              id={id}
              value={draft[field.key]}
              placeholder={field.placeholder}
              inputMode={field.key === "port" ? "numeric" : undefined}
              autoFocus={field.key === "label"}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              disabled={saving}
              aria-invalid={problem ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => onChange({ ...draft, [field.key]: event.target.value })}
            />
            {problem ? (
              <Text id={`${id}-error`} variant="small" color="status-red">
                {problem}
              </Text>
            ) : field.hint ? (
              <Text id={`${id}-hint`} variant="small" color="secondary">
                {field.hint}
              </Text>
            ) : null}
          </div>
        );
      })}
      <div className="flex items-center justify-between gap-3 rounded-control bg-control/50 px-3 py-2">
        <Text
          variant="small"
          color={check?.status === "failed" ? "status-red" : "secondary"}
          role="status"
          className="min-w-0 break-words"
        >
          {check ? describeDeviceHostCheck(check) : "Check access before saving. Nothing is installed."}
        </Text>
        <Button
          size="small"
          variant="muted"
          disabled={saving || checking || !result.config}
          onClick={() => {
            if (result.config) onTest(result.config);
          }}
        >
          {checking ? <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden /> : null}
          Test connection
        </Button>
      </div>
      {error ? (
        <Text variant="small" color="status-red" role="alert">
          {error}
        </Text>
      ) : null}
    </div>
  );
}

/** Adds or edits a host. Test connection checks the draft without saving it. */
export function SshHostEditor({ open, isNew, initial, check, saving, error, onTest, onSave, onClose }: SshHostEditorProps) {
  const [draft, setDraft] = React.useState(initial);
  const [attempted, setAttempted] = React.useState(false);
  React.useEffect(() => {
    if (open) {
      setDraft(initial);
      setAttempted(false);
    }
  }, [open, initial]);
  const save = () => {
    setAttempted(true);
    const result = validateSshDeviceHostDraft(draft);
    if (result.config) onSave(result.config);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={isNew ? "Add SSH host" : "Edit SSH host"}
      description="Aiden runs your system ssh with BatchMode, so the key must be in ssh-agent or your SSH config. A target that is this Mac is skipped."
      confirmLabel="Save host"
      confirmDisabled={check?.status === "pending"}
      busy={saving}
      submitOnEnter
      onConfirm={save}
    >
      <SshHostEditorForm
        draft={draft}
        attempted={attempted}
        check={check}
        saving={saving}
        error={error}
        onChange={setDraft}
        onTest={onTest}
      />
    </Dialog>
  );
}

function newSshHostId(): string {
  const random = globalThis.crypto.randomUUID().replace(/-/gu, "").slice(0, 12).toLowerCase();
  return `ssh-${random}`;
}

const EMPTY_DRAFT = (): SshDeviceHostDraft => ({ id: newSshHostId(), label: "", target: "", identityFile: "", port: "" });

/** Install copy names exactly what runs on the host and what it needs there. */
export function sshInstallDescription(host: SshDeviceHostConfig, tool: "hub" | "agent", agentAccess: boolean): string {
  const tools =
    tool === "agent" ? "agent-device" : agentAccess ? "expo-device-hub and agent-device" : "expo-device-hub";
  return (
    `Aiden connects to ${host.target} over SSH and runs npm there to install the pinned ${tools} into ~/.aiden/devices. ` +
    "The host needs Node.js 22 or newer and npm. Later Aiden releases update these helpers when you connect, " +
    "never in the background. Nothing about your chats is sent."
  );
}

/** Settings → Simulator → SSH hosts, wired to the device service. */
export function SimulatorSshHosts({ state }: { state: DeviceServiceState }) {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [checks, setChecks] = React.useState<Record<string, DeviceHostCheck>>({});
  const [editor, setEditor] = React.useState<{ isNew: boolean; draft: SshDeviceHostDraft } | null>(null);
  const [editorError, setEditorError] = React.useState<string | null>(null);
  const [installing, setInstalling] = React.useState<{ host: SshDeviceHostConfig; tool: "hub" | "agent" } | null>(null);
  const [removing, setRemoving] = React.useState<SshDeviceHostConfig | null>(null);

  const run = async (key: string, task: () => Promise<unknown>): Promise<boolean> => {
    if (pending) return false;
    setPending(key);
    setError(null);
    try {
      await task();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
      return false;
    } finally {
      setPending(null);
    }
  };

  const test = (config: SshDeviceHostConfig) => {
    setChecks((current) => ({ ...current, [config.id]: { status: "pending" } }));
    devicesApi
      .testSshHost(config)
      .catch((reason: unknown): DeviceHostCheck => ({
        status: "failed",
        error: reason instanceof Error ? reason.message : "The connection check failed.",
      }))
      .then((result) => setChecks((current) => ({ ...current, [config.id]: result })));
  };

  return (
    <>
      <SimulatorSshHostsView
        state={state}
        pending={pending}
        checks={checks}
        error={error}
        onAdd={() => {
          setEditorError(null);
          setEditor({ isNew: true, draft: EMPTY_DRAFT() });
        }}
        onEdit={(host) => {
          setEditorError(null);
          setEditor({ isNew: false, draft: sshDeviceHostDraft(host) });
        }}
        onConnect={(host) => void run(`connect:${host.id}`, () => devicesApi.startHost(host.id))}
        onTest={test}
        onInstall={(host, tool) => setInstalling({ host, tool })}
        onRemove={(host) => setRemoving(host)}
      />
      <SshHostEditor
        open={editor !== null}
        isNew={editor?.isNew ?? true}
        initial={editor?.draft ?? EMPTY_DRAFT()}
        check={editor ? (checks[editor.draft.id] ?? null) : null}
        saving={pending?.startsWith("save:") ?? false}
        error={editorError}
        onTest={test}
        onSave={(config) => {
          setEditorError(null);
          setPending(`save:${config.id}`);
          devicesApi
            .saveSshHost(config)
            .then(() => setEditor(null))
            .catch((reason: unknown) =>
              setEditorError(reason instanceof Error ? reason.message : "The host could not be saved."),
            )
            .finally(() => setPending(null));
        }}
        onClose={() => {
          if (!pending?.startsWith("save:")) setEditor(null);
        }}
      />
      <AlertDialog
        open={installing !== null}
        onOpenChange={(open) => (open || pending ? undefined : setInstalling(null))}
        title={
          installing?.tool === "agent"
            ? `Install agent tools on ${installing.host.label}?`
            : `Install simulator helpers on ${installing?.host.label ?? "this host"}?`
        }
        description={installing ? sshInstallDescription(installing.host, installing.tool, state.consent.agentAccess) : ""}
        confirmLabel="Install"
        busy={pending !== null}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!installing) return;
          const { host, tool } = installing;
          await run(`install-${tool}:${host.id}`, async () => {
            await devicesApi.updateTool({ hostId: host.id, tool });
            if (tool === "hub" && state.consent.agentAccess) {
              await devicesApi.updateTool({ hostId: host.id, tool: "agent" });
            }
          });
          setInstalling(null);
        }}
      />
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open || pending ? undefined : setRemoving(null))}
        title={`Remove ${removing?.label ?? "this host"}?`}
        description="Aiden disconnects, stops the helpers it started on the host, and forgets it. Helpers installed on the host stay there."
        confirmLabel="Remove host"
        confirmVariant="destructive"
        busy={pending !== null}
        keepOpenOnConfirm
        onConfirm={async () => {
          if (!removing) return;
          const host = removing;
          await run(`remove:${host.id}`, () => devicesApi.removeSshHost(host.id));
          setRemoving(null);
        }}
      />
    </>
  );
}
