import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Plus, RotateCw } from "lucide-react";
import {
  AlertDialog,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Text,
  toast,
  type BadgeColor,
} from "../ui";
import { CopyButton } from "../copy-button";
import { BotPageSkeleton } from "../../main/bots/bot-page-shell";
import { useAppCapabilities } from "../../lib/app-capabilities";
import { aidenMcpApi } from "../../lib/ipc";
import { aidenMcpQueryKeys } from "../../lib/aiden-mcp";
import {
  AIDEN_MCP_ACCESS_LABELS,
  aidenMcpClientSnippets,
  type AidenMcpAccess,
  type AidenMcpAppView,
  type AidenMcpServerStatusView,
} from "../../shared/aiden-mcp";

const MAX_APP_NAME_LENGTH = 80;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export interface AidenMcpStatusPresentation {
  label: string;
  tone: BadgeColor;
  /** The server is on but not listening, so a retry may help. */
  canRetry: boolean;
  detail: string;
}

/** What the enable row says about the server. */
export function aidenMcpStatusPresentation(status: AidenMcpServerStatusView): AidenMcpStatusPresentation {
  if (!status.enabled) {
    return {
      label: "Off",
      tone: "gray",
      canRetry: false,
      detail: "Apps you've added can't reach Aiden while this is off.",
    };
  }
  if (status.running && status.port !== undefined) {
    return {
      label: `Listening on port ${status.port}`,
      tone: "green",
      canRetry: false,
      detail: "Only apps on this computer can connect, and each one needs its own token.",
    };
  }
  if (status.problem === "port_in_use") {
    const port = status.port === undefined ? "Aiden's port" : `port ${status.port}`;
    return {
      label: status.port === undefined ? "Port in use" : `Port ${status.port} is in use`,
      tone: "warning",
      canRetry: true,
      detail: `Another program is using ${port}, so apps can't reach Aiden. Quit that program, then try again. Aiden keeps the same port so the apps you've set up keep working.`,
    };
  }
  if (status.problem === "start_failed") {
    return {
      label: "Couldn't start",
      tone: "red",
      canRetry: true,
      detail: "Aiden couldn't start its MCP server. Try again, or turn it off and on.",
    };
  }
  return { label: "Starting…", tone: "gray", canRetry: false, detail: "Aiden is starting its MCP server." };
}

const ACCESS_CHOICES: ReadonlyArray<readonly [AidenMcpAccess, string]> = [
  ["read", "Can list and read your chats and workspaces. It can't send messages."],
  [
    "supervised",
    "Can also start chats and send messages, which run with each workspace's permissions. Approvals and questions wait for you here.",
  ],
];

function AddAppDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (issued: { credential: string; app: AidenMcpAppView }) => void;
}) {
  const [name, setName] = React.useState("");
  const [access, setAccess] = React.useState<AidenMcpAccess>("read");
  const [saving, setSaving] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    setName("");
    setAccess("read");
    setFailure(null);
  }, [open]);
  const trimmed = name.trim();
  const add = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const issued = await aidenMcpApi.issueApp({ name: trimmed, access });
      onAdded(issued);
    } catch (error) {
      setFailure(errorMessage(error, "Couldn't add this app."));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add an app"
      description="Aiden makes a token for this app. You'll copy it into the app next."
      confirmLabel="Add app"
      confirmDisabled={!trimmed}
      busy={saving}
      submitOnEnter
      onConfirm={add}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <Text variant="small-strong">Name</Text>
          <Input
            value={name}
            autoFocus
            maxLength={MAX_APP_NAME_LENGTH}
            placeholder="Claude Code"
            aria-invalid={failure !== null || undefined}
            onChange={(event) => {
              setName(event.target.value);
              setFailure(null);
            }}
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <Text variant="small-strong" id="aiden-mcp-access-label">Access</Text>
          <RadioGroup
            orientation="vertical"
            aria-labelledby="aiden-mcp-access-label"
            value={access}
            onValueChange={(value) => setAccess(value === "supervised" ? "supervised" : "read")}
            className="gap-1"
          >
            {ACCESS_CHOICES.map(([value, description]) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors hover:bg-control-hover ${access === value ? "bg-control" : ""}`}
              >
                <RadioGroupItem
                  value={value}
                  aria-label={AIDEN_MCP_ACCESS_LABELS[value]}
                  className="mt-0.5 shrink-0 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover"
                />
                <span className="flex flex-col gap-1">
                  <Text>{AIDEN_MCP_ACCESS_LABELS[value]}</Text>
                  <Text as="span" variant="small" color="secondary">{description}</Text>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
        {failure ? (
          <Text as="p" variant="small" color="status-red" role="alert">{failure}</Text>
        ) : null}
      </div>
    </Dialog>
  );
}

function CodeLine({ text, copyLabel }: { text: string; copyLabel: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-control py-2 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-small text-primary">{text}</code>
      <CopyButton text={text} label={copyLabel} className="shrink-0" />
    </div>
  );
}

/** Shown once, right after an app is added. Closing it forgets the token. */
function CredentialDialog({
  issued,
  url,
  onClose,
}: {
  issued: { credential: string; app: AidenMcpAppView } | null;
  url: string | undefined;
  onClose: () => void;
}) {
  const snippets = issued && url ? aidenMcpClientSnippets(url, issued.credential) : [];
  return (
    <Dialog
      open={issued !== null}
      onOpenChange={(open) => !open && onClose()}
      title={issued ? `Connect ${issued.app.name}` : "Connect app"}
      description="Copy the token now. Aiden keeps only a fingerprint of it, so it won't be shown again."
      confirmHidden
      cancelLabel="Done"
      size="large"
    >
      {issued ? (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-1.5">
            <Text variant="small-strong">Token</Text>
            <CodeLine text={issued.credential} copyLabel="Copy token" />
          </div>
          {snippets.length > 0 ? (
            snippets.map((snippet) => (
              <div key={snippet.id} className="flex flex-col gap-1.5">
                <Text variant="small-strong">{snippet.client}</Text>
                <Text as="p" variant="small" color="secondary">
                  Set the token in the shell you start {snippet.client} from, or in your shell profile:
                </Text>
                <CodeLine text={snippet.exportLine} copyLabel={`Copy the ${snippet.client} token line`} />
                <Text as="p" variant="small" color="secondary">Then add Aiden. {snippet.client} reads the token from that variable:</Text>
                <CodeLine text={snippet.command} copyLabel={`Copy the ${snippet.client} command`} />
              </div>
            ))
          ) : (
            <Text as="p" variant="small" color="secondary">
              Turn on Let apps use Aiden to get the address your app connects to.
            </Text>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}

export interface AidenMcpAppRowProps {
  app: AidenMcpAppView;
  onRevoke(): void;
}

export function AidenMcpAppRow({ app, onRevoke }: AidenMcpAppRowProps) {
  const used = app.lastSeenAt > 0 ? `Last used ${formatDate(app.lastSeenAt)}` : "Not used yet";
  return (
    <div
      data-aiden-mcp-app={app.id}
      className="relative flex items-center gap-3 p-4 after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-separator last:after:hidden max-[540px]:flex-wrap"
    >
      <AppWindow className="size-4 shrink-0 text-secondary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Text variant="small-strong" truncate className="block">{app.name}</Text>
        <Text variant="small" color="secondary" className="block">
          Added {formatDate(app.createdAt)} · {used}
        </Text>
      </div>
      <Badge color={app.access === "supervised" ? "blue" : "gray"}>{AIDEN_MCP_ACCESS_LABELS[app.access]}</Badge>
      <Button size="small" variant="transparent" onClick={onRevoke} aria-label={`Revoke ${app.name}`}>
        Revoke
      </Button>
    </div>
  );
}

/** Settings → Connections → Apps using Aiden. */
export function AidenMcpSettings() {
  const capabilities = useAppCapabilities();
  if (!capabilities.mcpServer) return null;
  return <AidenMcpSettingsView />;
}

function AidenMcpSettingsView() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: aidenMcpQueryKeys.status(), queryFn: aidenMcpApi.status });
  const apps = useQuery({ queryKey: aidenMcpQueryKeys.apps(), queryFn: aidenMcpApi.listApps });
  const [switching, setSwitching] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [issued, setIssued] = React.useState<{ credential: string; app: AidenMcpAppView } | null>(null);
  const [revoking, setRevoking] = React.useState<AidenMcpAppView | null>(null);
  const [revokeBusy, setRevokeBusy] = React.useState(false);

  const setEnabled = async (enabled: boolean) => {
    const previous = queryClient.getQueryData<AidenMcpServerStatusView>(aidenMcpQueryKeys.status());
    if (previous) {
      queryClient.setQueryData<AidenMcpServerStatusView>(aidenMcpQueryKeys.status(), {
        ...previous,
        enabled,
        running: enabled && previous.running,
      });
    }
    setSwitching(true);
    try {
      queryClient.setQueryData(aidenMcpQueryKeys.status(), await aidenMcpApi.setEnabled(enabled));
    } catch (error) {
      if (previous) queryClient.setQueryData(aidenMcpQueryKeys.status(), previous);
      toast.error(errorMessage(error, enabled ? "Couldn't turn on the MCP server." : "Couldn't turn off the MCP server."));
    } finally {
      setSwitching(false);
    }
  };

  const revoke = async () => {
    const app = revoking;
    if (!app) return;
    setRevokeBusy(true);
    try {
      await aidenMcpApi.revokeApp(app.id);
      queryClient.setQueryData<AidenMcpAppView[]>(aidenMcpQueryKeys.apps(), (current) =>
        current?.filter((entry) => entry.id !== app.id),
      );
      void queryClient.invalidateQueries({ queryKey: aidenMcpQueryKeys.apps() });
      setRevoking(null);
    } catch (error) {
      toast.error(errorMessage(error, "Couldn't revoke this app."));
    } finally {
      setRevokeBusy(false);
    }
  };

  if (status.isLoading) return <BotPageSkeleton label="Reading Apps using Aiden" groups={[1, 2]} />;
  if (!status.data) {
    return (
      <FieldSet title="Apps using Aiden">
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 p-4">
          <Text variant="small">Couldn't read the MCP server's status.</Text>
          <Button size="small" disabled={status.isFetching} onClick={() => void status.refetch()}>Try again</Button>
        </div>
      </FieldSet>
    );
  }

  const server = status.data;
  const presentation = aidenMcpStatusPresentation(server);
  const appList = apps.data ?? [];

  return (
    <>
      <FieldSet title="MCP server">
        <Field label="Let apps use Aiden" description={presentation.detail}>
          <div className="flex items-center justify-end gap-3">
            <Badge color={presentation.tone}>{presentation.label}</Badge>
            <Switch
              checked={server.enabled}
              disabled={switching}
              onCheckedChange={(checked) => void setEnabled(checked)}
              aria-label="Let apps use Aiden"
            />
          </div>
        </Field>
        {server.enabled && server.url ? (
          <Field label="Address" description="Apps on this computer connect here.">
            <div className="flex items-center justify-end gap-2 max-[540px]:justify-start">
              <code className="min-w-0 truncate font-mono text-small text-secondary">{server.url}</code>
              <CopyButton text={server.url} label="Copy address" />
            </div>
          </Field>
        ) : null}
        {presentation.canRetry ? (
          <Field label="Start again" description="Aiden tries the same port again.">
            <div className="flex justify-end max-[540px]:justify-start">
              <Button size="small" variant="filled" disabled={switching} onClick={() => void setEnabled(true)}>
                <RotateCw /> Try again
              </Button>
            </div>
          </Field>
        ) : null}
      </FieldSet>

      <FieldSet
        title="Apps"
        action={(
          <Button size="small" variant="accent" onClick={() => setAdding(true)}>
            <Plus /> Add app
          </Button>
        )}
      >
        {apps.isLoading ? (
          <div className="p-4" role="status">
            <Text variant="small" color="secondary">Loading apps…</Text>
          </div>
        ) : apps.isError ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 p-4">
            <Text variant="small">Couldn't load your apps. Their access hasn't changed.</Text>
            <Button size="small" disabled={apps.isFetching} onClick={() => void apps.refetch()}>Try again</Button>
          </div>
        ) : appList.length === 0 ? (
          <EmptyState
            placement="inline"
            title="No apps yet"
            description="Add Claude Code, Codex or another MCP app to let it read your chats here."
          />
        ) : (
          appList.map((app) => <AidenMcpAppRow key={app.id} app={app} onRevoke={() => setRevoking(app)} />)
        )}
      </FieldSet>
      <Text as="p" variant="small" color="secondary" className="-mt-4 mb-7 px-4 text-pretty">
        Apps never answer approvals or questions; those wait for you in Aiden. A Supervised app's turns run
        with its workspace's permissions, so in a Full-access workspace its tools run without asking.
      </Text>

      <AddAppDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={(next) => {
          setAdding(false);
          setIssued(next);
          void queryClient.invalidateQueries({ queryKey: aidenMcpQueryKeys.apps() });
        }}
      />
      <CredentialDialog issued={issued} url={server.url} onClose={() => setIssued(null)} />
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={revoking ? `Revoke ${revoking.name}?` : "Revoke app?"}
        description="Its token stops working right away, and any runs it started stop. To connect it again, add it again and use the new token."
        confirmLabel="Revoke"
        confirmVariant="destructive"
        keepOpenOnConfirm
        busy={revokeBusy}
        onConfirm={revoke}
      />
    </>
  );
}
