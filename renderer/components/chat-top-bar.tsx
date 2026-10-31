// Chat top bar pieces: the chat title menu, the workspace chip beside it, and
// the compact workspace tool buttons on the trailing side.

import { openWorkspaceSettings } from "./workspace-settings-dialog";
import { workspaceHasOwnSettings } from "../lib/workspace-settings-view";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  MessageCircle,
  Pencil,
  Settings2,
  SquareTerminal,
  Users,
} from "lucide-react";
import * as React from "react";
import { workspacesApi } from "../lib/ipc";
import { queryKeys, useWorkspaceRepositoryIdentity } from "../lib/queries";
import type { GitInfo, Workspace } from "../lib/types";
import { cn } from "../lib/ui-utils";
import { githubRepositoryUrl } from "../lib/workspace-chip";
import type { EnvironmentPanelTab } from "../lib/environment-panel-state";
import { isSubagentRunViewStateActive, type SubagentRunView } from "../lib/subagent-view-state";
import { useEnvironmentPanel } from "./environment-panel";
import { useLinkOpener } from "../lib/link-opener";
import {
  Button,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  toast,
} from "./ui";
import { WORKSPACE_TOOLS } from "./workspace-tool-launcher";
import { useCommandHandler } from "../lib/command-system";

const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);

/**
 * Header menu triggers fill their heading's box, which clips overflow for the
 * ellipsis, so their keyboard outline is drawn inside the edge instead.
 */
const INSET_FOCUS_RING = { "--keyboard-focus-offset": "-2px" } as React.CSSProperties;

async function copyToClipboard(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error(`Couldn't copy the ${label.toLowerCase()}.`);
  }
}

/**
 * The chat title as a menu trigger: rename, duplicate, or copy the title. A
 * draft (not yet saved) shows its title as plain text.
 */
export function ChatTitleMenu({
  title,
  persisted,
  onRename,
  onDuplicate,
  duplicateDisabledReason,
}: {
  title: string;
  persisted: boolean;
  onRename: (title: string) => Promise<void>;
  onDuplicate: () => Promise<void>;
  duplicateDisabledReason: string | null;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  if (!persisted) return <span className="block truncate">{title}</span>;

  const commitRename = async () => {
    const next = renameValue.trim();
    if (!next || saving) return;
    setSaving(true);
    try {
      await onRename(next);
      setRenaming(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't rename this chat.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The visible title is the accessible name so the heading keeps it. */}
          <Button
            variant="bar"
            size="small"
            data-chat-title-menu
            style={INSET_FOCUS_RING}
            className="no-drag max-w-full min-w-0 shrink gap-1 px-1.5 text-strong text-primary"
          >
            <span className="min-w-0 truncate">{title}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          <DropdownMenuItem
            onSelect={() => {
              setRenameValue(title);
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden="true" className="size-4" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={Boolean(duplicateDisabledReason)}
            title={duplicateDisabledReason ?? undefined}
            onSelect={() => {
              void onDuplicate().catch((error: unknown) => {
                toast.error(error instanceof Error ? error.message : "Couldn't duplicate this chat.");
              });
            }}
          >
            <Copy aria-hidden="true" className="size-4" />
            Duplicate chat
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copyToClipboard(title, "Chat title")}>
            Copy title
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={renaming}
        onOpenChange={(open) => {
          if (!open && !saving) setRenaming(false);
        }}
        title="Rename chat"
        description="Choose the name shown for this conversation in the sidebar."
        confirmLabel="Save"
        confirmDisabled={!renameValue.trim()}
        busy={saving}
        submitOnEnter
        onConfirm={commitRename}
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          placeholder="Chat name"
          aria-label="Chat name"
          autoFocus
        />
      </Dialog>
    </>
  );
}

const CHIP_CLASS =
  "workspace-chip no-drag min-w-0 max-w-44 gap-1 bg-control/50 px-2 text-small font-normal text-secondary [&_svg:not([class*='size-'])]:size-3.5";

/**
 * The chat's workspace beside its title. Works for any workspace: Git-only
 * actions (branch, GitHub) appear only for a readable repository, folder
 * actions only when the workspace has a folder Aiden may access, and a
 * workspace without a folder shows a plain label with no menu.
 */
export function WorkspaceChip({
  workspace,
  git,
  canOpenTerminal,
  onOpenTerminal,
}: {
  workspace: Workspace;
  git: GitInfo | undefined;
  canOpenTerminal: boolean;
  onOpenTerminal: () => void;
}) {
  const qc = useQueryClient();
  const { openLink } = useLinkOpener();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const folderPath = workspace.folderPath;
  // Without access, Git reads report "not a repository"; never present that as fact.
  const accessible = Boolean(folderPath) && workspace.permission !== "none";
  const isRepo = accessible && git?.isRepo === true;
  const branch = isRepo && git?.branch && !git.detached ? git.branch : undefined;
  // The remote identity is read only once someone opens the menu.
  const identity = useWorkspaceRepositoryIdentity(
    workspace.id,
    menuOpen && isRepo && git?.hasRemote === true,
  );
  const githubUrl = identity.data ? githubRepositoryUrl(identity.data.canonicalKey) : null;
  const Icon = isRepo ? FolderGit2 : workspace.noWorkspace ? MessageCircle : Folder;

  if (!folderPath) {
    return (
      <span
        data-workspace-chip
        data-workspace-chip-static
        title={`${workspace.name} has no folder`}
        className={cn(
          CHIP_CLASS,
          "inline-flex h-7 shrink items-center rounded-button [corner-shape:squircle]",
        )}
      >
        <Icon aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 truncate">{workspace.name}</span>
      </span>
    );
  }

  const statusLine = !accessible
    ? "Workspace access is off"
    : git === undefined
      ? null
      : !isRepo
        ? "Not a Git repository"
        : (branch ?? (git.detached ? "Detached HEAD" : null));

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        // Opening the menu re-reads Git state, so a folder that just became a
        // repository (or switched branch) shows it without waiting for the poll.
        if (open && accessible) void qc.invalidateQueries({ queryKey: queryKeys.git(workspace.id) });
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="bar"
          size="small"
          data-workspace-chip
          aria-label={`Workspace ${workspace.name}`}
          title={folderPath}
          className={cn(CHIP_CLASS, "shrink")}
        >
          <Icon aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{workspace.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-primary">{workspace.name}</span>
          <span className="truncate font-normal" title={folderPath}>
            {folderPath}
          </span>
          {statusLine ? (
            <span className="flex min-w-0 items-center gap-1 font-normal" data-workspace-chip-status>
              {branch ? <GitBranch aria-hidden="true" className="size-3 shrink-0" /> : null}
              <span className="truncate">{statusLine}</span>
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {accessible ? (
          <>
            <DropdownMenuItem
              onSelect={() => {
                void workspacesApi.openFolder(workspace.id).catch((error: unknown) => {
                  toast.error(error instanceof Error ? error.message : "Couldn't open this folder.");
                });
              }}
            >
              <FolderOpen aria-hidden="true" className="size-4" />
              {IS_MAC ? "Show in Finder" : "Open folder"}
            </DropdownMenuItem>
            {canOpenTerminal ? (
              <DropdownMenuItem onSelect={onOpenTerminal}>
                <SquareTerminal aria-hidden="true" className="size-4" />
                Open in terminal
              </DropdownMenuItem>
            ) : null}
            {githubUrl ? (
              <DropdownMenuItem onSelect={() => openLink(githubUrl)}>
                <ExternalLink aria-hidden="true" className="size-4" />
                Open on GitHub
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem onSelect={() => void copyToClipboard(folderPath, "Folder path")}>
          Copy folder path
        </DropdownMenuItem>
        {branch ? (
          <DropdownMenuItem onSelect={() => void copyToClipboard(branch, "Branch name")}>
            Copy branch name
          </DropdownMenuItem>
        ) : null}
        {workspaceHasOwnSettings(workspace) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openWorkspaceSettings(workspace.id)}>
              <Settings2 aria-hidden="true" className="size-4" />
              Workspace settings…
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ToolId = Extract<EnvironmentPanelTab, "review" | "browser" | "devices" | "files">;

/** Tool buttons in reading order, after the terminal. */
const TOOL_BUTTON_ORDER: readonly ToolId[] = ["review", "browser", "devices", "files"];

function toolDefinition(id: EnvironmentPanelTab) {
  return WORKSPACE_TOOLS.find((tool) => tool.id === id);
}

/**
 * Below this header content width (after the collapsed-sidebar inset) the
 * individual tool buttons fold into the overflow menu, leaving room for a
 * readable title and the workspace chip. The chip itself hides at 560px
 * through the `chat-toolbar` container query, which also measures content.
 */
const COMPACT_TOOLBAR_CONTENT_WIDTH = 680;

function useToolbarCompact(anchor: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = React.useState(false);
  React.useLayoutEffect(() => {
    const toolbar = anchor.current?.closest<HTMLElement>("[data-toolbar]");
    if (!toolbar) return;
    const update = () => {
      const style = getComputedStyle(toolbar);
      const content =
        toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setCompact(content < COMPACT_TOOLBAR_CONTENT_WIDTH);
    };
    update();
    // The collapsed-sidebar inset animates padding, which changes the content box.
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    toolbar.addEventListener("transitionend", update);
    return () => {
      observer.disconnect();
      toolbar.removeEventListener("transitionend", update);
    };
  }, [anchor]);
  return compact;
}

/**
 * Shown only while this chat has subagents at work: how many, in the soft
 * status fill the sidebar uses for a working chat, and the way to the
 * Subagents tool. Waiting on the person turns it to the warning fill.
 */
function SubagentsRunningButton({
  runs,
  pressed,
  disabled,
  onActivate,
}: {
  runs: readonly SubagentRunView[];
  pressed: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const active = runs.filter((run) => isSubagentRunViewStateActive(run.state));
  if (active.length === 0) return null;
  return (
    <SubagentsRunningBadge
      count={active.length}
      attention={active.filter((run) => run.state === "needs_attention").length}
      pressed={pressed}
      disabled={disabled}
      onActivate={onActivate}
    />
  );
}

function SubagentsRunningBadge({
  count,
  attention,
  pressed,
  disabled,
  onActivate,
}: {
  count: number;
  attention: number;
  pressed: boolean;
  disabled: boolean;
  onActivate: () => void;
}) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  // The badge leaves when the work it was opened to watch ends, often while it
  // still has keyboard focus. Hand focus to the overflow menu beside it (or,
  // without a usable menu, another toolbar button) rather than dropping it on
  // the document, unless the whole toolbar is going too.
  React.useLayoutEffect(() => {
    const button = buttonRef.current;
    return () => {
      if (!button || document.activeElement !== button) return;
      const toolbar = button.closest<HTMLElement>("[data-workspace-tool-buttons]");
      queueMicrotask(() => {
        if (!toolbar?.isConnected) return;
        if (document.activeElement && document.activeElement !== document.body) return;
        (
          toolbar.querySelector<HTMLElement>("[data-workspace-tools-menu]:not(:disabled)") ??
          toolbar.querySelector<HTMLElement>("button:not(:disabled)")
        )?.focus();
      });
    };
  }, []);
  const label = `${count} subagent${count === 1 ? "" : "s"} running${
    attention > 0 ? `, ${attention} waiting on you` : ""
  }`;
  return (
    <Button
      ref={buttonRef}
      size="small"
      variant="bar"
      data-subagents-running={attention > 0 ? "attention" : "active"}
      aria-label={`${pressed ? "Hide" : "Show"} Subagents. ${label}.`}
      aria-pressed={pressed}
      aria-controls="environment-panel"
      title={label}
      disabled={disabled}
      onClick={onActivate}
      className="px-1.5"
    >
      <span
        className={cn(
          "inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-mini font-medium tabular-nums",
          attention > 0
            ? "bg-status-warning-surface text-status-warning"
            : "bg-status-accent-surface text-status-accent",
        )}
      >
        <Users aria-hidden="true" className="size-3.5" />
        {count}
      </span>
    </Button>
  );
}

/**
 * One quiet button per workspace tool. Each opens the Environment panel on its
 * tab and shows as pressed while that tab is visible; pressing it again hides
 * the panel. Tools a workspace cannot use are left out rather than disabled:
 * Changes needs a Git repository, Files needs a folder, and a chat with no
 * workspace gets none. `leading` sits before the tools and `end` after the
 * overflow menu; both stay visible when the tools fold into that menu.
 */
export function WorkspaceToolButtons({
  chatId,
  hasWorkspace,
  hasFolder,
  hasFolderAccess,
  isRepo,
  terminalButton,
  leading,
  trailing,
  end,
}: {
  /** The chat this header belongs to; the running-subagents badge counts only its runs. */
  chatId: string;
  hasWorkspace: boolean;
  hasFolder: boolean;
  hasFolderAccess: boolean;
  isRepo: boolean;
  terminalButton: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  end?: React.ReactNode;
}) {
  const panel = useEnvironmentPanel();
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const compact = useToolbarCompact(anchorRef);
  const available = (id: EnvironmentPanelTab): boolean => {
    if (!hasWorkspace) return false;
    if (id === "review") return hasFolder && isRepo;
    if (id === "files") return hasFolder;
    if (id === "devices") return panel.devicesEnabled;
    if (id === "subagents") return panel.subagentsEnabled;
    return true;
  };
  const blockedReason = (id: EnvironmentPanelTab): string | undefined =>
    id === "files" && !hasFolderAccess ? "Workspace access is off for this folder" : undefined;
  const showing = (id: EnvironmentPanelTab) => panel.toolsPresented && panel.tab === id;
  const activate = (id: EnvironmentPanelTab) => {
    if (showing(id)) panel.closeTools();
    else panel.showTools(id);
  };
  const buttons = TOOL_BUTTON_ORDER.filter(available);
  // ⌘K "Open Files" and friends open the same tabs the buttons do, while those tools exist here.
  const commandReady = (id: EnvironmentPanelTab) =>
    available(id) && !blockedReason(id) && !panel.gitOperationBusy;
  useCommandHandler("tools.review", () => panel.showTools("review"), commandReady("review"));
  useCommandHandler("tools.files", () => panel.showTools("files"), commandReady("files"));
  useCommandHandler("tools.browser", () => panel.showTools("browser"), commandReady("browser"));
  useCommandHandler("tools.devices", () => panel.showTools("devices"), commandReady("devices"));
  useCommandHandler("tools.context", () => panel.showTools("context"), commandReady("context"));
  useCommandHandler("tools.subagents", () => panel.showTools("subagents"), commandReady("subagents"));
  useCommandHandler(
    "tools.artifacts",
    () => panel.showTools("artifacts"),
    commandReady("artifacts") && panel.artifacts.views.length > 0,
  );
  const menuTools: EnvironmentPanelTab[] = hasWorkspace
    ? [...(compact ? buttons : []), "context", ...(available("subagents") ? (["subagents"] as const) : [])]
    : [];

  return (
    <div ref={anchorRef} className="flex items-center gap-0.5" data-workspace-tool-buttons>
      {leading ? (
        <>
          {leading}
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-separator" />
        </>
      ) : null}
      {terminalButton}
      {compact
        ? null
        : buttons.map((id) => {
            const tool = toolDefinition(id);
            if (!tool) return null;
            const ToolIcon = tool.icon;
            const reason = blockedReason(id);
            const pressed = showing(id);
            return (
              <Button
                key={id}
                iconOnly
                size="small"
                variant="bar"
                data-workspace-tool={id}
                aria-label={pressed ? `Hide ${tool.label}` : `Show ${tool.label}`}
                aria-pressed={pressed}
                aria-controls="environment-panel"
                title={reason ?? tool.label}
                disabled={Boolean(reason) || panel.gitOperationBusy}
                onClick={() => activate(id)}
              >
                <ToolIcon />
              </Button>
            );
          })}
      {trailing ? (
        <>
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-separator" />
          {trailing}
        </>
      ) : null}
      {available("subagents") ? (
        <SubagentsRunningButton
          // The panel rebuilds its views for a new chat after the switch renders.
          runs={panel.subagents.chatId === chatId ? panel.subagentViews : []}
          pressed={showing("subagents")}
          disabled={panel.gitOperationBusy}
          onActivate={() => activate("subagents")}
        />
      ) : null}
      {menuTools.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              iconOnly
              size="small"
              variant="bar"
              aria-label="More workspace tools"
              title="More workspace tools"
              data-workspace-tools-menu
              disabled={panel.gitOperationBusy}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {menuTools.map((id) => {
              const tool = toolDefinition(id);
              if (!tool) return null;
              const ToolIcon = tool.icon;
              const reason = blockedReason(id);
              return (
                <DropdownMenuItem
                  key={id}
                  disabled={Boolean(reason)}
                  title={reason}
                  className={cn(showing(id) && "text-primary")}
                  onSelect={() => panel.showTools(id)}
                >
                  <ToolIcon aria-hidden="true" className="size-4" />
                  <span className="min-w-0 flex-1">{tool.label}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {end}
    </div>
  );
}
