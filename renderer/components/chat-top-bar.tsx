// Chat top bar pieces: the chat title menu, the workspace chip beside it, and
// the compact workspace tool buttons on the trailing side.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Copy,
  Ellipsis,
  ExternalLink,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Pencil,
  SquareTerminal,
} from "lucide-react";
import * as React from "react";
import { chatsApi, workspacesApi } from "../lib/ipc";
import { queryKeys } from "../lib/queries";
import type { GitInfo, Workspace } from "../lib/types";
import { cn } from "../lib/ui-utils";
import { githubRepositoryUrl } from "../lib/workspace-chip";
import type { EnvironmentPanelTab } from "../lib/environment-panel-state";
import { useEnvironmentPanel } from "./environment-panel";
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

const IS_MAC = typeof navigator !== "undefined" && /Mac/u.test(navigator.userAgent);

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
 * draft (not yet saved) shows its title as plain text because none apply.
 */
export function ChatTitleMenu({
  chatId,
  title,
  persisted,
  onDuplicate,
}: {
  chatId: string;
  title: string;
  persisted: boolean;
  onDuplicate: () => Promise<void>;
}) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = React.useState(false);
  const [renameValue, setRenameValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  if (!persisted) return <span className="block truncate">{title}</span>;

  const commitRename = async () => {
    const next = renameValue.trim();
    if (!next || saving) return;
    setSaving(true);
    try {
      await chatsApi.rename(chatId, next);
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.chats }),
        qc.invalidateQueries({ queryKey: queryKeys.chat(chatId) }),
      ]);
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
          <button
            type="button"
            data-chat-title-menu
            aria-label={`Chat actions for ${title}`}
            className="no-drag -mx-1.5 flex max-w-full min-w-0 items-center gap-1 rounded-button px-1.5 py-0.5 text-left text-strong text-primary outline-none transition-[background-color] duration-(--motion-duration) ease-standard [corner-shape:squircle] hover:bg-list-hover aria-expanded:bg-list-selection"
          >
            <span className="min-w-0 truncate">{title}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-tertiary" />
          </button>
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

/**
 * The chat's workspace beside its title. Works for any workspace: Git-only
 * actions (branch, GitHub) appear only when the folder is a repository, and
 * folder actions only when the workspace has a folder.
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
  const [menuOpen, setMenuOpen] = React.useState(false);
  const folderPath = workspace.folderPath;
  const isRepo = git?.isRepo === true;
  const branch = isRepo && git?.branch && !git.detached ? git.branch : undefined;
  // The remote identity is read only once someone opens the menu.
  const identity = useQuery({
    queryKey: ["workspace-repository-identity", workspace.id],
    queryFn: () => workspacesApi.repositoryIdentity(workspace.id),
    enabled: menuOpen && isRepo && git?.hasRemote === true,
    staleTime: 60_000,
    retry: false,
  });
  const githubUrl = identity.data ? githubRepositoryUrl(identity.data.canonicalKey) : null;
  const Icon = isRepo ? FolderGit2 : Folder;
  const branchLine = !folderPath
    ? "No folder"
    : git === undefined
      ? null
      : !isRepo
        ? "Not a Git repository"
        : branch
          ? branch
          : git.detached
            ? "Detached HEAD"
            : null;

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        // Opening the menu re-reads Git state, so a folder that just became a
        // repository (or switched branch) shows it without waiting for the poll.
        if (open && folderPath) void qc.invalidateQueries({ queryKey: queryKeys.git(workspace.id) });
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="bar"
          size="small"
          data-workspace-chip
          aria-label={`Workspace ${workspace.name}`}
          title={folderPath ?? workspace.name}
          className="workspace-chip no-drag max-w-44 shrink-0 gap-1 bg-control/50 px-2 text-small font-normal text-secondary [&_svg:not([class*='size-'])]:size-3.5"
        >
          <Icon aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{workspace.name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-primary">{workspace.name}</span>
          {folderPath ? (
            <span className="truncate font-normal" title={folderPath}>
              {folderPath}
            </span>
          ) : null}
          {branchLine ? (
            <span className="flex min-w-0 items-center gap-1 font-normal" data-workspace-chip-branch>
              {branch ? <GitBranch aria-hidden="true" className="size-3 shrink-0" /> : null}
              <span className="truncate">{branchLine}</span>
            </span>
          ) : null}
        </DropdownMenuLabel>
        {folderPath ? (
          <>
            <DropdownMenuSeparator />
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
              <DropdownMenuItem
                onSelect={() => window.open(githubUrl, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink aria-hidden="true" className="size-4" />
                Open on GitHub
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void copyToClipboard(folderPath, "Folder path")}>
              Copy folder path
            </DropdownMenuItem>
            {branch ? (
              <DropdownMenuItem onSelect={() => void copyToClipboard(branch, "Branch name")}>
                Copy branch name
              </DropdownMenuItem>
            ) : null}
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

/** Below this toolbar width the individual tool buttons fold into the overflow menu. */
const COMPACT_TOOLBAR_WIDTH = 600;

function useToolbarCompact(anchor: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = React.useState(false);
  React.useLayoutEffect(() => {
    const toolbar = anchor.current?.closest<HTMLElement>("[data-toolbar]");
    if (!toolbar) return;
    const update = () => setCompact(toolbar.getBoundingClientRect().width < COMPACT_TOOLBAR_WIDTH);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, [anchor]);
  return compact;
}

/**
 * One quiet button per workspace tool. Each opens the Environment panel on its
 * tab and shows as pressed while that tab is showing; pressing it again hides
 * the panel. Tools a workspace cannot use are left out rather than disabled:
 * Changes needs a Git repository, Files needs a folder.
 */
export function WorkspaceToolButtons({
  hasFolder,
  hasFolderAccess,
  isRepo,
  terminalButton,
  trailing,
}: {
  hasFolder: boolean;
  hasFolderAccess: boolean;
  isRepo: boolean;
  terminalButton: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const panel = useEnvironmentPanel();
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const compact = useToolbarCompact(anchorRef);
  const available = (id: EnvironmentPanelTab): boolean => {
    if (id === "review") return hasFolder && isRepo;
    if (id === "files") return hasFolder;
    if (id === "devices") return panel.devicesEnabled;
    if (id === "subagents") return panel.subagentsEnabled;
    return true;
  };
  const blockedReason = (id: EnvironmentPanelTab): string | undefined =>
    (id === "review" || id === "files") && !hasFolderAccess
      ? "Workspace access is off for this folder"
      : undefined;
  const showing = (id: EnvironmentPanelTab) => panel.toolsOpen && panel.tab === id;
  const activate = (id: EnvironmentPanelTab) => {
    // A pressed tool that Quick View covers comes forward; otherwise it hides.
    if (showing(id) && panel.frontSurface !== "quick-view") panel.closeTools();
    else panel.showTools(id);
  };
  const buttons = TOOL_BUTTON_ORDER.filter(available);
  const menuTools: EnvironmentPanelTab[] = [
    ...(compact ? buttons : []),
    "context",
    ...(available("subagents") ? (["subagents"] as const) : []),
  ];

  return (
    <div ref={anchorRef} className="flex items-center gap-0.5" data-workspace-tool-buttons>
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            iconOnly
            size="small"
            variant="bar"
            aria-label="More workspace tools"
            title="More workspace tools"
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
    </div>
  );
}
