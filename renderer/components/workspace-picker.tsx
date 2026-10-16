import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Folder,
  FolderDown,
  FolderPlus,
  Loader2,
  MessageSquare,
} from "lucide-react";
import type { Workspace } from "../lib/types";
import { workspaceDisplayName } from "../lib/workspace-path-display";
import { WorkspacePathLabel } from "./workspace-path-label";
import { useWorkspacePathPreferences } from "../lib/use-workspace-path-preferences";
import { useAllRegularChats } from "../lib/queries";
import { workspacesApi } from "../lib/ipc";
import { newChatWorkspaceChoices } from "../lib/new-chat-workspaces";
import { formatRelativeTime } from "../lib/relative-time";
import { useShortcutLabel } from "../lib/command-system";
import {
  adoptWorkspace,
  useOpenWorkspacePathRow,
  useWorkspacePathIntake,
} from "../lib/use-workspace-path-intake";
import {
  cloneFailureMessage,
  cloneProgressLabel,
  newCloneId,
  workspaceMenuList,
  type WorkspacePathRow,
} from "../lib/workspace-menu";
import type { DraftWorkspaceMenuView } from "../lib/draft-workspace-menu";
import type { WorkspaceCloneProgress } from "../shared/workspace-intake";
import {
  Button,
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from "./ui";

/** Ask an already mounted picker to open (a new `nonce` each time). */
export interface WorkspaceMenuRequest {
  nonce: number;
  view: DraftWorkspaceMenuView;
}

interface WorkspacePickerProps {
  trigger: React.ReactElement;
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onSelectWorkspace: (workspaceId: string) => Promise<void>;
  onCreateScratchWorkspace: () => Promise<void>;
  /** Register a folder through the native dialog and move the draft there. */
  onOpenFolder?: () => Promise<void>;
  blockedReason?: string;
  /**
   * Set while the draft is being sent, a response runs or Git is busy: the
   * menu won't open on request and its rows can't change the workspace.
   */
  busyReason?: string;
  openRequest?: WorkspaceMenuRequest;
  /** Where focus lands when the menu closes (the composer input). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const CLONE_PREVIEW_DELAY_MS = 250;

export function WorkspacePicker({
  trigger,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateScratchWorkspace,
  onOpenFolder,
  blockedReason,
  busyReason,
  openRequest,
  returnFocusRef,
}: WorkspacePickerProps) {
  const [open, setOpen] = React.useState(false);
  const [view, setView] = React.useState<DraftWorkspaceMenuView>("list");
  const [pending, setPending] = React.useState<string | null>(null);
  const [cloning, setCloning] = React.useState(false);
  const blockedReasonId = React.useId();
  const cloneRef = React.useRef<CloneViewHandle | null>(null);

  // A programmatic request (headline name, ⌘⇧O palette Clone) opens the menu.
  const handledRequest = React.useRef(openRequest?.nonce ?? 0);
  React.useEffect(() => {
    if (!openRequest || openRequest.nonce === handledRequest.current) return;
    handledRequest.current = openRequest.nonce;
    if (blockedReason || busyReason) {
      toast.info(blockedReason ?? busyReason);
      return;
    }
    setView(openRequest.view);
    setOpen(true);
  }, [blockedReason, busyReason, openRequest]);

  const close = React.useCallback(() => {
    setOpen(false);
    setView("list");
  }, []);

  const perform = async (key: string, action: () => Promise<void>) => {
    if (blockedReason || busyReason) {
      toast.error(blockedReason ?? busyReason);
      return;
    }
    if (pending) return;
    setPending(key);
    try {
      await action();
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't change the workspace.");
    } finally {
      setPending(null);
    }
  };

  const onOpenChange = (nextOpen: boolean) => {
    if (pending || blockedReason) return;
    if (nextOpen) {
      setOpen(true);
      return;
    }
    // Closing while a clone runs stops it; nothing keeps running unseen.
    cloneRef.current?.cancel();
    close();
  };

  return (
    <>
      {blockedReason ? (
        <span id={blockedReasonId} className="sr-only" role="status">
          {blockedReason}
        </span>
      ) : null}
      <Popover open={blockedReason ? false : open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          {blockedReason
            ? React.cloneElement(trigger, {
                "aria-describedby": blockedReasonId,
                title: blockedReason,
              } as React.HTMLAttributes<HTMLElement>)
            : trigger}
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(24rem,calc(100vw-2rem))] p-0"
          aria-label={view === "clone" ? "Clone repository" : "Choose a workspace"}
          data-workspace-menu={view}
          onEscapeKeyDown={(event) => {
            if (view !== "clone") return;
            // Esc stops a running clone first, then steps back to the list.
            event.preventDefault();
            if (cloning) cloneRef.current?.cancel();
            else setView("list");
          }}
          onCloseAutoFocus={(event) => {
            const target = returnFocusRef?.current;
            if (!target) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          }}
        >
          {view === "clone" ? (
            <CloneView
              ref={cloneRef}
              onBack={() => setView("list")}
              onCloningChange={setCloning}
              onCloned={async (workspace) => {
                try {
                  await onSelectWorkspace(workspace.id);
                } catch (error) {
                  toast.info(
                    error instanceof Error
                      ? `The repository was cloned, but this chat could not move to it: ${error.message}`
                      : "The repository was cloned, but this chat could not move to it.",
                  );
                }
                close();
              }}
            />
          ) : (
            <WorkspaceListView
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              pending={pending}
              disabled={pending !== null || Boolean(blockedReason || busyReason)}
              onChooseWorkspace={(workspaceId) => {
                if (workspaceId === activeWorkspaceId) {
                  close();
                  return;
                }
                void perform(workspaceId, () => onSelectWorkspace(workspaceId));
              }}
              onOpenPathRow={(key, openRow) =>
                void perform(key, async () => {
                  const workspace = await openRow();
                  if (workspace.id !== activeWorkspaceId) await onSelectWorkspace(workspace.id);
                })
              }
              onOpenFolder={onOpenFolder ? () => void perform("open-folder", onOpenFolder) : undefined}
              onClone={() => setView("clone")}
              onScratch={() => void perform("scratch", onCreateScratchWorkspace)}
            />
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

function PendingMark({ active }: { active: boolean }) {
  return active ? <Loader2 className="size-4 shrink-0 animate-spin text-secondary" /> : null;
}

const ROW_CLASS = "min-h-9 gap-2.5 px-2.5 py-1.5";

function WorkspaceListView({
  workspaces,
  activeWorkspaceId,
  pending,
  disabled,
  onChooseWorkspace,
  onOpenPathRow,
  onOpenFolder,
  onClone,
  onScratch,
}: {
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  pending: string | null;
  disabled: boolean;
  onChooseWorkspace: (workspaceId: string) => void;
  onOpenPathRow: (key: string, open: () => Promise<Workspace>) => void;
  onOpenFolder?: () => void;
  onClone: () => void;
  onScratch: () => void;
}) {
  const pathPreferences = useWorkspacePathPreferences();
  const openFolderShortcut = useShortcutLabel("workspace.openFolder");
  const chats = useAllRegularChats(workspaces.length > 0);
  const [query, setQuery] = React.useState("");
  const [expanded, setExpanded] = React.useState(false);
  const [selected, setSelected] = React.useState("");
  const intake = useWorkspacePathIntake(query, {
    relativeToWorkspaceId: activeWorkspaceId,
    workspaces,
  });
  const openPathRow = useOpenWorkspacePathRow(activeWorkspaceId);
  const choices = React.useMemo(
    () => newChatWorkspaceChoices(workspaces, chats.data ?? [], activeWorkspaceId),
    [activeWorkspaceId, chats.data, workspaces],
  );
  const list = workspaceMenuList(choices, { query, expanded });
  const now = Date.now();
  const pathRow = intake.row;
  const pathRowValue = pathRow && pathRow.action !== "invalid" ? `path:${pathRow.action}:${pathRow.input}` : "";

  // A checked path becomes the default choice as soon as its answer arrives.
  React.useEffect(() => {
    if (pathRowValue) setSelected(pathRowValue);
  }, [pathRowValue]);

  const choosePathRow = (row: WorkspacePathRow) => {
    if (row.action === "select") onChooseWorkspace(row.workspaceId);
    else if (row.action === "open" || row.action === "create") {
      onOpenPathRow(`path:${row.input}`, () => openPathRow(row));
    }
  };

  return (
    <Command label="Search workspaces" shouldFilter={false} value={selected} onValueChange={setSelected} loop>
      <CommandInput
        placeholder="Search or paste a path"
        aria-label="Search workspaces"
        autoFocus
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="h-auto max-h-80">
        {intake.pathQuery ? (
          <PathRowView
            row={pathRow}
            checking={intake.checking}
            value={pathRowValue}
            pending={pending === `path:${pathRow?.input}`}
            disabled={disabled}
            onChoose={choosePathRow}
          />
        ) : (
          <>
            {list.rows.length > 0 ? (
              <CommandGroup heading={list.heading}>
                {list.rows.map(({ workspace, lastActivityAt }) => (
                  <CommandItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    disabled={disabled}
                    onSelect={() => onChooseWorkspace(workspace.id)}
                    className="min-h-11 gap-2.5 px-2.5 py-1.5"
                  >
                    <Folder className="size-4.5 shrink-0 text-secondary" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-regular">
                        {workspaceDisplayName(workspace, workspaces)}
                      </span>
                      {workspace.folderPath && pathPreferences.showWorkspacePaths ? (
                        <WorkspacePathLabel
                          path={workspace.folderPath}
                          format={pathPreferences.workspacePathFormat}
                        />
                      ) : null}
                    </span>
                    {pending === workspace.id ? (
                      <PendingMark active />
                    ) : workspace.id === activeWorkspaceId ? (
                      <Check className="size-4 shrink-0 text-secondary" aria-label="Current workspace" />
                    ) : (
                      <span className="shrink-0 text-small text-tertiary">
                        {formatRelativeTime(lastActivityAt, now)}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : query.trim() ? (
              <p className="px-3 py-3 text-small text-tertiary">
                No workspace matches “{query.trim()}”. Paste a path to open a folder.
              </p>
            ) : null}
            {list.allCount > 0 ? (
              <CommandItem
                value="action:all-workspaces"
                disabled={disabled}
                onSelect={() => setExpanded(true)}
                className={`${ROW_CLASS} text-secondary`}
              >
                <ChevronRight className="size-4.5 shrink-0" />
                <span className="flex-1">All workspaces ({list.allCount})</span>
              </CommandItem>
            ) : null}
          </>
        )}
        <CommandSeparator alwaysRender />
        {onOpenFolder ? (
          <CommandItem
            value="action:open-folder"
            disabled={disabled}
            onSelect={onOpenFolder}
            className={ROW_CLASS}
          >
            <FolderPlus className="size-4.5 shrink-0 text-secondary" />
            <span className="flex-1">Open folder…</span>
            {pending === "open-folder" ? (
              <PendingMark active />
            ) : openFolderShortcut ? (
              <kbd className="shrink-0 font-sans text-small text-tertiary">{openFolderShortcut}</kbd>
            ) : null}
          </CommandItem>
        ) : null}
        <CommandItem value="action:clone" disabled={disabled} onSelect={onClone} className={ROW_CLASS}>
          <FolderDown className="size-4.5 shrink-0 text-secondary" />
          <span className="flex-1">Clone repository…</span>
        </CommandItem>
        <CommandItem value="action:scratch" disabled={disabled} onSelect={onScratch} className={ROW_CLASS}>
          <MessageSquare className="size-4.5 shrink-0 text-secondary" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-regular">Scratch chat</span>
            <span className="truncate text-small text-tertiary">Uses a new folder in ~/aiden</span>
          </span>
          <PendingMark active={pending === "scratch"} />
        </CommandItem>
      </CommandList>
    </Command>
  );
}

function PathRowView({
  row,
  checking,
  value,
  pending,
  disabled,
  onChoose,
}: {
  row: WorkspacePathRow | null;
  checking: boolean;
  value: string;
  pending: boolean;
  disabled: boolean;
  onChoose: (row: WorkspacePathRow) => void;
}) {
  if (checking || !row) {
    return (
      <p role="status" className="flex items-center gap-2 px-3 py-2.5 text-small text-tertiary">
        <Loader2 className="size-4 shrink-0 animate-spin" />
        Checking path…
      </p>
    );
  }
  if (row.action === "invalid") {
    return (
      <p role="status" data-path-row="invalid" className="flex items-start gap-2 px-3 py-2.5 text-small text-secondary">
        <CircleAlert className="mt-px size-4 shrink-0 text-tertiary" />
        <span className="min-w-0 flex-1">{row.message}</span>
      </p>
    );
  }
  const Icon = row.action === "select" ? Folder : FolderPlus;
  const detail = row.action === "select" || row.action === "open" ? row.detail : undefined;
  return (
    <CommandItem
      value={value}
      disabled={disabled}
      onSelect={() => onChoose(row)}
      data-path-row={row.action}
      className="min-h-11 gap-2.5 px-2.5 py-1.5"
    >
      <Icon className="size-4.5 shrink-0 text-secondary" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-regular" title={row.path}>
          {row.label}
        </span>
        {detail ? <span className="truncate text-small text-tertiary">{detail}</span> : null}
      </span>
      <PendingMark active={pending} />
    </CommandItem>
  );
}

interface CloneViewHandle {
  cancel: () => void;
}

type ClonePreviewState =
  | { state: "idle" }
  | { state: "ready"; url: string; destination: string }
  | { state: "invalid"; url: string; reason: string };

const CloneView = React.forwardRef<
  CloneViewHandle,
  {
    onBack: () => void;
    onCloningChange: (cloning: boolean) => void;
    onCloned: (workspace: Workspace) => Promise<void>;
  }
>(function CloneView({ onBack, onCloningChange, onCloned }, ref) {
  const queryClient = useQueryClient();
  const urlId = React.useId();
  const destinationId = React.useId();
  const helpId = React.useId();
  const invalidId = React.useId();
  const [url, setUrl] = React.useState("");
  const [destination, setDestination] = React.useState("");
  const [destinationEdited, setDestinationEdited] = React.useState(false);
  const [preview, setPreview] = React.useState<ClonePreviewState>({ state: "idle" });
  const [cloneId, setCloneId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<WorkspaceCloneProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // A clone that succeeded stays busy until the draft has moved, so Clone
  // can't start a second clone in the meantime.
  const [finishing, setFinishing] = React.useState(false);
  const activeCloneRef = React.useRef<string | null>(null);
  const typedUrl = url.trim();

  // Validate the URL and suggest a destination after a short pause. Only the
  // answer for the URL still in the field is used.
  React.useEffect(() => {
    if (!typedUrl) {
      setPreview({ state: "idle" });
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      workspacesApi.clonePreview(typedUrl).then(
        (result) => {
          if (!current) return;
          setPreview(
            result.ok
              ? { state: "ready", url: typedUrl, destination: result.destination }
              : { state: "invalid", url: typedUrl, reason: result.reason },
          );
        },
        (previewError: unknown) => {
          if (!current) return;
          setPreview({
            state: "invalid",
            url: typedUrl,
            reason: previewError instanceof Error ? previewError.message : "Aiden couldn't check that URL.",
          });
        },
      );
    }, CLONE_PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [typedUrl]);

  const suggested = preview.state === "ready" && preview.url === typedUrl ? preview.destination : "";
  const shownDestination = destinationEdited ? destination : suggested;
  const invalidReason = preview.state === "invalid" && preview.url === typedUrl ? preview.reason : null;
  const running = cloneId !== null;
  const cloning = running || finishing;
  const canClone = !cloning && Boolean(suggested) && (!destinationEdited || destination.trim().length > 0);

  React.useEffect(() => {
    onCloningChange(cloning);
  }, [cloning, onCloningChange]);

  // Progress lines are routed by clone id; ignore any other clone's.
  React.useEffect(() => {
    if (!cloneId) return;
    return workspacesApi.onCloneProgress((line) => {
      if (line.cloneId === cloneId) setProgress(line);
    });
  }, [cloneId]);

  const cancel = React.useCallback(() => {
    const id = activeCloneRef.current;
    if (!id) return;
    activeCloneRef.current = null;
    setCloneId(null);
    setProgress(null);
    void workspacesApi.cancelClone(id).catch(() => undefined);
  }, []);
  React.useImperativeHandle(ref, () => ({ cancel }), [cancel]);
  // Leaving the view (or the menu unmounting) stops a running clone.
  React.useEffect(() => () => {
    const id = activeCloneRef.current;
    if (id) void workspacesApi.cancelClone(id).catch(() => undefined);
  }, []);

  const startClone = async () => {
    if (!canClone) return;
    const id = newCloneId();
    activeCloneRef.current = id;
    setCloneId(id);
    setProgress(null);
    setError(null);
    try {
      const result = await workspacesApi.clone({
        cloneId: id,
        url: typedUrl,
        ...(destinationEdited ? { destination: destination.trim() } : {}),
      });
      if (activeCloneRef.current !== id) {
        // Cancelled, but Git finished first: the workspace exists in main, so
        // refresh the list. The draft stays where it is.
        if (result.ok) {
          await adoptWorkspace(queryClient, result.workspace);
          toast.info(`${result.workspace.name} finished cloning before it could be cancelled. It is in your workspaces.`);
        }
        return;
      }
      activeCloneRef.current = null;
      if (!result.ok) {
        setCloneId(null);
        setProgress(null);
        setError(cloneFailureMessage(result));
        return;
      }
      setFinishing(true);
      setCloneId(null);
      try {
        await adoptWorkspace(queryClient, result.workspace);
        await onCloned(result.workspace);
      } finally {
        setFinishing(false);
      }
    } catch (cloneError) {
      if (activeCloneRef.current !== id) return;
      activeCloneRef.current = null;
      setCloneId(null);
      setProgress(null);
      setError(cloneError instanceof Error ? cloneError.message : "Git couldn't clone that repository.");
    }
  };

  return (
    <div className="flex flex-col gap-1 p-1.5">
      <Button
        variant="transparent"
        size="small"
        className="justify-start gap-2 px-2 text-secondary"
        disabled={cloning}
        onClick={onBack}
      >
        <ArrowLeft className="size-4" />
        Clone repository
      </Button>
      <div className="flex flex-col gap-1 px-1.5 pt-1">
        <label htmlFor={urlId} className="text-small text-tertiary">
          Git URL or owner/repo
        </label>
        <Input
          id={urlId}
          autoFocus
          value={url}
          disabled={cloning}
          placeholder="owner/repo or https://…"
          aria-invalid={invalidReason ? true : undefined}
          aria-describedby={invalidReason ? `${invalidId} ${helpId}` : helpId}
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void startClone();
            }
          }}
        />
        {invalidReason ? (
          <p id={invalidId} className="text-small text-secondary">
            {invalidReason}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 px-1.5 pt-1">
        <label htmlFor={destinationId} className="text-small text-tertiary">
          Destination
        </label>
        <Input
          id={destinationId}
          value={shownDestination}
          disabled={cloning || (!suggested && !destinationEdited)}
          placeholder="Chosen from the URL"
          onChange={(event) => {
            setDestinationEdited(true);
            setDestination(event.target.value);
            setError(null);
          }}
        />
      </div>
      <p id={helpId} className="px-1.5 pt-1 text-small text-tertiary">
        Uses your git credentials. Runs only when you press Clone.
      </p>
      {cloning ? (
        <div className="flex flex-col gap-1.5 px-1.5 pt-1" data-clone-progress>
          {/* Announce phase changes only; the percentage lives on the progress bar. */}
          <span role="status" className="sr-only">
            {finishing ? "Opening the repository" : (progress?.phase ?? "Cloning")}
          </span>
          <span aria-hidden="true" className="text-small text-secondary">
            {finishing ? "Opening…" : cloneProgressLabel(progress)}
          </span>
          <div
            role="progressbar"
            aria-label="Clone progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress?.percent}
            className="h-1 overflow-hidden rounded-full bg-control"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-(--motion-duration) ease-standard motion-reduce:transition-none"
              style={{ width: `${Math.round(progress?.percent ?? 0)}%` }}
            />
          </div>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mx-1.5 mt-1 rounded-control bg-status-red-surface px-3 py-2 text-small text-status-red">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 px-1.5 pb-1 pt-2">
        {cloning ? (
          <Button variant="filled" size="small" disabled={finishing} onClick={cancel}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="transparent" size="small" onClick={onBack}>
              Cancel
            </Button>
            <Button variant="accent" size="small" disabled={!canClone} onClick={() => void startClone()}>
              Clone
            </Button>
          </>
        )}
      </div>
    </div>
  );
});
