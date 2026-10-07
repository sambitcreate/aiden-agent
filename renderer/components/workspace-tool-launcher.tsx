import * as React from "react";
import {
  CircleGauge,
  Files,
  GitCompareArrows,
  Globe,
  List,
  Plus,
  Smartphone,
  TerminalSquare,
  Users,
} from "lucide-react";
import { Button, Input, Text } from "./ui";
import type { EnvironmentPanelTab } from "../lib/environment-panel-state";
import { useShortcutLabel } from "../lib/command-system";

export const WORKSPACE_TOOLS = [
  { id: "review", label: "Changes", icon: GitCompareArrows, folder: true },
  { id: "files", label: "Files", icon: Files, folder: true },
  { id: "terminal", label: "Terminal", icon: TerminalSquare, folder: true },
  { id: "context", label: "Context", icon: CircleGauge, folder: false },
  { id: "browser", label: "Browser", icon: Globe, folder: false },
  { id: "subagents", label: "Subagents", icon: Users, folder: false },
  { id: "devices", label: "Simulator", icon: Smartphone, folder: false },
] as const;

export function workspaceToolLabel(tab: EnvironmentPanelTab): string {
  return WORKSPACE_TOOLS.find((tool) => tool.id === tab)?.label ?? "New tab";
}

export function WorkspaceToolLauncher({
  hasWorkspace,
  hasFolderAccess,
  canOpenTerminal,
  subagents,
  devices,
  busy,
  onOpen,
  onUrl,
  onQuickView,
}: {
  hasWorkspace: boolean;
  hasFolderAccess: boolean;
  canOpenTerminal: boolean;
  subagents: boolean;
  devices: boolean;
  busy: boolean;
  onOpen: (tab: EnvironmentPanelTab) => void;
  onUrl: (url: string) => Promise<void>;
  onQuickView: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const terminalShortcut = useShortcutLabel("terminal.toggle");
  const [more, setMore] = React.useState(false);
  return (
    <div
      className="h-full overflow-y-auto p-5 @container"
      aria-label="Workspace tools"
    >
      <form
        className="mb-7"
        onSubmit={(event) => {
          event.preventDefault();
          if (!url.trim() || pending) return;
          setPending(true);
          setError(null);
          void onUrl(url.trim())
            .catch(() => setError("Could not open this address. Try again."))
            .finally(() => setPending(false));
        }}
      >
        <Input
          aria-label="Open a URL"
          placeholder="Enter a URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={!hasWorkspace || busy || pending}
        />
        {error ? (
          <p role="alert" className="mt-2 text-small text-support-danger">
            {error}
          </p>
        ) : null}
      </form>
      <h2 className="mb-3 text-large-strong">Tools</h2>
      <div className="grid grid-cols-1 gap-2 @min-[500px]:grid-cols-2">
        {WORKSPACE_TOOLS.filter(
          (tool) =>
            (tool.id !== "subagents" || subagents) &&
            (tool.id !== "devices" || devices) &&
            (more || (tool.id !== "subagents" && tool.id !== "devices")),
        ).map(({ id, label, icon: Icon, folder }) => {
          const unavailable =
            id === "context"
              ? null
              : !hasWorkspace
                ? "Choose a workspace"
                : folder && !hasFolderAccess
                  ? "Choose a folder and enable workspace access"
                  : id === "terminal" && !canOpenTerminal
                    ? "Terminal is unavailable"
                    : null;
          return (
            <Button
              key={id}
              variant="transparent"
              className="h-auto min-h-12 justify-start gap-3 bg-well px-4 py-3 text-left"
              disabled={busy || Boolean(unavailable)}
              title={unavailable ?? label}
              onClick={() => onOpen(id)}
            >
              <Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block">{label}</span>
                {unavailable ? (
                  <span className="block text-mini font-normal text-tertiary">
                    {unavailable}
                  </span>
                ) : null}
              </span>
              {id === "terminal" ? (
                <span className="text-mini text-tertiary">
                  {terminalShortcut}
                </span>
              ) : null}
            </Button>
          );
        })}
        {subagents || devices ? (
          <Button
            variant="transparent"
            className="min-h-12 justify-start gap-3 bg-well px-4"
            aria-expanded={more}
            onClick={() => setMore(!more)}
          >
            <Plus className="size-4" />
            {more ? "Fewer tools" : "More tools…"}
          </Button>
        ) : null}
        <Button
          variant="transparent"
          className="min-h-12 justify-start gap-3 bg-well px-4"
          disabled={!hasWorkspace || busy}
          onClick={onQuickView}
        >
          <List className="size-4" />
          Quick View
        </Button>
      </div>
      <Text variant="small" color="tertiary" className="mt-5 block">
        Open tools beside your chat. Use + to open another tab.
      </Text>
    </div>
  );
}
