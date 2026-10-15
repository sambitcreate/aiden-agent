// Compact composer Git control: local status/refs, safe branch switching,
// branch creation, and managed isolated worktrees using Aiden's existing menu
// vocabulary and progressive disclosure. On a draft it also chooses where the
// chat will run (Work in): this checkout, a new worktree created on first
// send, or one of the repository's existing managed worktrees.

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CustomDropdownMenu,
  CustomDropdownMenuContent,
  CustomDropdownMenuTrigger,
  Input,
  CommandSeparator,
  Text,
  toast,
} from "./ui";
import { Check, ChevronDown, FolderGit2, GitBranch, Loader2, Plus } from "lucide-react";
import { gitApi } from "../lib/ipc";
import { queryKeys, useGitBranches, useGitWorktrees } from "../lib/queries";
import { branchChipState } from "../lib/draft-git-menu";
import { cn } from "../lib/ui-utils";
import { DraftWorkIn, useDraftWorktreeDefaults, type GitBranchPickerDraft } from "./draft-work-in";

export type { GitBranchPickerDraft } from "./draft-work-in";

interface GitBranchPickerProps {
  workspaceId: string;
  branch: string;
  disabled?: boolean;
  onCreateWorktree?: (branchName: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  worktreeDescription: string;
  triggerVariant?: "compact" | "overview";
  disabledReason?: string;
  detached?: boolean;
  unborn?: boolean;
  /** Used with a keyed mount by `/worktree` to open the managed flow. */
  openWorktreeOnMount?: boolean;
  /** Restores focus to the slash-command origin instead of the untouched trigger. */
  programmaticReturnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Uncommitted changes from the workspace's Git status, shown on the compact trigger before the menu loads its own read. */
  uncommitted?: number;
  /** The workspace is an Aiden-managed worktree. */
  managedWorktree?: boolean;
  /** Set on drafts: the Work in choice and New worktree settings. */
  draft?: GitBranchPickerDraft;
}

type CreateMode = "branch" | "worktree" | null;

function statusSummary(
  uncommitted: number,
  ahead: number,
  behind: number,
  upstream?: string,
): string | undefined {
  const parts: string[] = [];
  if (uncommitted > 0) parts.push(`${uncommitted} change${uncommitted === 1 ? "" : "s"}`);
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  if (upstream) parts.push(`${upstream} (last fetched)`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function GitBranchPicker({
  workspaceId,
  branch,
  disabled = false,
  onCreateWorktree,
  onBusyChange,
  worktreeDescription,
  triggerVariant = "compact",
  disabledReason,
  detached: detachedProp = false,
  unborn: unbornProp = false,
  openWorktreeOnMount = false,
  programmaticReturnFocusRef,
  uncommitted: uncommittedProp,
  managedWorktree = false,
  draft,
}: GitBranchPickerProps) {
  const qc = useQueryClient();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  // A draft chooses New worktree in Work in instead of creating one now.
  const createWorktree = draft ? undefined : onCreateWorktree;
  const openManagedWorktree =
    openWorktreeOnMount && Boolean(createWorktree) && !disabled && !unbornProp;
  const programmaticOriginRef = React.useRef(openManagedWorktree);
  const [open, setOpen] = React.useState(openManagedWorktree);
  const [createMode, setCreateMode] = React.useState<CreateMode>(
    openManagedWorktree ? "worktree" : null,
  );
  const [newName, setNewName] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const draftNewWorktree = draft?.gitMode === "worktree";
  // A New worktree draft reads branches while closed too, to resolve its base.
  const branches = useGitBranches(workspaceId, open || draftNewWorktree);
  const worktrees = useGitWorktrees(workspaceId, open);
  const detached = branches.data?.detached ?? detachedProp;
  const unborn = branches.data?.unborn ?? unbornProp;
  const currentRef = branches.data?.current ?? branch;
  const current = detached ? "Detached HEAD" : currentRef;
  // The branches read is disabled (and not refreshed) while the menu is closed,
  // so a closed trigger follows the caller's live Git status when it has one.
  const uncommitted =
    open || uncommittedProp === undefined
      ? (branches.data?.uncommitted ?? uncommittedProp ?? 0)
      : uncommittedProp;
  const ahead = branches.data?.ahead ?? 0;
  const behind = branches.data?.behind ?? 0;
  const upstream = branches.data?.upstream;
  const defaultBranch = branches.data?.defaultBranch;
  const list = branches.data?.branches ?? [];
  const remoteBranches = branches.data?.remoteBranches ?? [];
  const status = statusSummary(uncommitted, ahead, behind, upstream);
  const currentSummary =
    [unborn ? "No commits yet" : undefined, status].filter(Boolean).join(" · ") || undefined;
  const unavailable = disabled || busy;
  const branchWorktrees = new Map(
    (worktrees.data ?? [])
      .filter((worktree) => !worktree.current && worktree.branch)
      .map((worktree) => [worktree.branch as string, worktree.path]),
  );

  React.useEffect(() => {
    if (disabled && !busy) setOpen(false);
  }, [busy, disabled]);

  useDraftWorktreeDefaults(draft, branches.data);
  const chip = branchChipState({
    branch: current,
    uncommitted,
    draftGitMode: draft?.gitMode,
    baseRef: draft?.worktree?.baseRef,
    managedWorktree,
  });
  // On a draft, uncommitted changes keep this checkout on its branch: the
  // escape hatch is a new worktree, which starts clean.
  const draftDirty = Boolean(draft) && uncommitted > 0;
  // New worktree and an existing worktree replace the branch list with their own settings.
  const showBranchList =
    !draft ||
    (draft.gitMode !== "worktree" && !(draft.workIn.selectedWorktreeId && draft.workIn.source));

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.gitBranches(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.gitWorktrees(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.git(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.gitReview(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.gitPushCapability(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.gitPullRequestStatus(workspaceId) }),
      qc.invalidateQueries({ queryKey: queryKeys.gitComparisons(workspaceId) }),
    ]);

  const reset = () => {
    setCreateMode(null);
    setNewName("");
    setQuery("");
  };

  // Keep the search text when entering a create form so Cancel returns to it,
  // and seed the new name from it so typing a missing branch is one step.
  const startCreate = (mode: Exclude<CreateMode, null>) => {
    setNewName(query.trim());
    setCreateMode(mode);
  };

  const backToList = () => {
    if (programmaticOriginRef.current) {
      setOpen(false);
      reset();
      return;
    }
    setCreateMode(null);
    setNewName("");
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const checkout = async (name: string) => {
    if (draftDirty && name !== currentRef) return;
    if (unavailable || name === currentRef || branchWorktrees.has(name)) {
      if (name === currentRef) setOpen(false);
      return;
    }
    onBusyChange?.(true);
    setBusy(true);
    let closeAfterSuccess = false;
    try {
      await gitApi.checkout(workspaceId, name);
      await refresh();
      closeAfterSuccess = true;
    } catch (error) {
      await refresh().catch(() => undefined);
      toast.error(error instanceof Error ? error.message : "Couldn't switch branch.");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      if (closeAfterSuccess) {
        requestAnimationFrame(() => {
          setOpen(false);
          reset();
        });
      }
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name || !createMode || unavailable || unborn) return;
    onBusyChange?.(true);
    setBusy(true);
    let closeAfterSuccess = false;
    try {
      if (createMode === "worktree") {
        if (!createWorktree) return;
        await createWorktree(name);
      } else {
        await gitApi.createBranch(workspaceId, name);
        await refresh();
      }
      closeAfterSuccess = true;
    } catch (error) {
      await refresh().catch(() => undefined);
      toast.error(
        error instanceof Error
          ? error.message
          : createMode === "worktree"
            ? "Couldn't create isolated workspace."
            : "Couldn't create branch.",
      );
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      if (closeAfterSuccess) {
        requestAnimationFrame(() => {
          setOpen(false);
          reset();
        });
      }
    }
  };

  const trimmedQuery = query.trim();
  const creatingLabel = createMode === "worktree" ? "Creating workspace…" : "Creating branch…";

  return (
    <CustomDropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (disabled && nextOpen) return;
        setOpen(nextOpen);
        if (!nextOpen && !busy) reset();
      }}
    >
      <CustomDropdownMenuTrigger asChild>
        {triggerVariant === "overview" ? (
          <button
            ref={triggerRef}
            type="button"
            disabled={disabled}
            aria-label={`Branch ${current}${currentSummary ? `, ${currentSummary}` : ""}`}
            title={disabledReason ?? (currentSummary ? `${current} · ${currentSummary}` : current)}
            className="grid min-h-9 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-control px-2.5 text-left outline-none transition-colors duration-150 ease-out hover:bg-list-hover active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45"
          >
            <GitBranch className="size-4.5 text-secondary" aria-hidden="true" />
            <span className="min-w-0 truncate text-regular text-primary">{current}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-small text-tertiary">
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
              {currentSummary ? <span className="max-w-52 truncate">{currentSummary}</span> : null}
              <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
            </span>
          </button>
        ) : (
          <Button
            ref={triggerRef}
            variant="transparent"
            size="small"
            disabled={disabled}
            data-branch-chip={chip.kind}
            className={cn(
              "composer-branch-trigger h-7 min-w-0 max-w-[14rem] flex-1 shrink gap-1.5 px-2 max-[520px]:max-w-[7rem]",
              chip.kind === "new-worktree"
                ? "bg-status-accent-surface text-status-accent hover:bg-status-accent-surface active:bg-status-accent-surface"
                : "text-tertiary",
            )}
            aria-label={chip.ariaLabel}
            title={
              disabledReason ??
              (chip.kind === "new-worktree"
                ? `${chip.label}. Created when you send.`
                : currentSummary
                  ? `${current} · ${currentSummary}`
                  : current)
            }
          >
            {chip.kind === "checkout" ? (
              <GitBranch className="size-4 shrink-0" />
            ) : (
              <FolderGit2 className="size-4 shrink-0" />
            )}
            <span className="min-w-0 truncate text-small">{chip.label}</span>
            {chip.changes > 0 ? (
              <span
                data-changes-badge
                aria-hidden="true"
                className="inline-flex h-4 shrink-0 items-center rounded-full bg-status-warning-surface px-1.5 text-mini font-medium tabular-nums text-status-warning"
              >
                {chip.changes}
              </span>
            ) : null}
          </Button>
        )}
      </CustomDropdownMenuTrigger>

      <CustomDropdownMenuContent
        align="start"
        className={cn("p-0", draft ? "w-80" : "w-72")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            const returnTarget = programmaticOriginRef.current
              ? programmaticReturnFocusRef?.current
              : triggerRef.current;
            programmaticOriginRef.current = false;
            if (
              returnTarget?.isConnected &&
              !(returnTarget instanceof HTMLButtonElement && returnTarget.disabled)
            ) {
              returnTarget.focus();
            }
          });
        }}
      >
        {draft && !createMode ? (
          <DraftWorkIn
            draft={draft}
            branches={branches.data}
            current={current}
            uncommitted={uncommitted}
            unborn={unborn}
            disabled={unavailable}
            onDone={() => setOpen(false)}
          />
        ) : null}
        {!showBranchList && !createMode ? null : createMode ? (
          <div className="flex flex-col gap-2 p-3" aria-busy={busy}>
            <Text variant="small" color="tertiary">
              {createMode === "worktree" ? "Isolated worktree" : "New branch"} from {current}
            </Text>
            {createMode === "worktree" ? (
              <Text variant="small" color="secondary">
                {worktreeDescription}
              </Text>
            ) : null}
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  event.stopPropagation();
                  backToList();
                } else if (event.key === "Enter" && !busy) {
                  event.preventDefault();
                  void create();
                }
              }}
              placeholder="feature/my-branch"
              aria-label="New branch name"
              disabled={busy}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="transparent" size="small" onClick={backToList} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="accent"
                size="small"
                onClick={() => void create()}
                disabled={busy || !newName.trim() || unborn}
                aria-busy={busy}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? creatingLabel : createMode === "worktree" ? "Create workspace" : "Create"}
              </Button>
            </div>
          </div>
        ) : (
          <Command
            onKeyDown={(event) => {
              if (event.key !== "Escape") event.stopPropagation();
            }}
          >
            <CommandInput
              ref={searchRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search branches"
            />
            <div className="px-3 pt-2">
              <Text variant="small" color="tertiary">
                Local branches
              </Text>
            </div>
            {draftDirty ? (
              <div
                className="mx-2 mt-2 flex flex-col items-start gap-1.5 rounded-control bg-status-warning-surface px-2.5 py-2 text-small text-status-warning"
                data-dirty-checkout-note
              >
                <span>
                  {uncommitted} uncommitted change{uncommitted === 1 ? "" : "s"}. Commit or stash
                  them to switch branches here.
                </span>
                {!unborn ? (
                  <Button
                    variant="filled"
                    size="small"
                    disabled={unavailable}
                    onClick={() => void draft?.onSelectNewWorktree()}
                  >
                    Use a new worktree instead
                  </Button>
                ) : null}
              </div>
            ) : null}
            {branches.error ? (
              <div
                className="mx-2 mt-2 flex items-center justify-between gap-2 rounded-control bg-status-red-surface px-2 py-1.5 text-small text-status-red"
                role="status"
              >
                <span className="min-w-0">
                  {branches.data
                    ? "Refresh failed. Showing known branches."
                    : "Branches are unavailable."}
                </span>
                <button
                  type="button"
                  onClick={() => void branches.refetch()}
                  className="shrink-0 rounded-control px-1.5 py-0.5 text-small-strong outline-none hover:bg-status-red-surface focus-visible:bg-list-selection focus-visible:outline-none"
                >
                  Try again
                </button>
              </div>
            ) : null}
            <CommandList>
              <CommandEmpty>
                {branches.isLoading
                  ? "Loading…"
                  : branches.error
                    ? "No branch snapshot is available."
                    : "No branches found."}
              </CommandEmpty>
              {list.map((name) => {
                const isActive = name === current;
                const otherWorktree = branchWorktrees.get(name);
                return (
                  <CommandItem
                    key={name}
                    value={name}
                    disabled={
                      unavailable || Boolean(otherWorktree) || (draftDirty && name !== currentRef)
                    }
                    onSelect={() => void checkout(name)}
                    className="gap-2"
                  >
                    <GitBranch className="size-4 shrink-0 text-tertiary" />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-small-strong">{name}</span>
                      {otherWorktree ? (
                        <span className="block truncate text-small text-tertiary">
                          Checked out in {otherWorktree.split("/").filter(Boolean).pop()}
                        </span>
                      ) : isActive && currentSummary ? (
                        <span className="block truncate text-small text-tertiary">
                          {currentSummary}
                        </span>
                      ) : unborn && isActive ? (
                        <span className="block truncate text-small text-tertiary">
                          Create the first commit to continue
                        </span>
                      ) : name === defaultBranch ? (
                        <span className="block truncate text-small text-tertiary">
                          Default branch
                        </span>
                      ) : null}
                    </div>
                    {isActive ? <Check className="size-4 shrink-0 text-accent-text" /> : null}
                  </CommandItem>
                );
              })}
              {remoteBranches.length > 0 ? (
                <div className="px-2 pb-1 pt-2 text-small-strong text-tertiary">
                  Remote tracking refs
                </div>
              ) : null}
              {remoteBranches.map((name) => (
                <CommandItem
                  key={`remote-${name}`}
                  value={`remote ${name}`}
                  disabled
                  className="gap-2"
                >
                  <GitBranch className="size-4 shrink-0 text-tertiary" />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-small-strong">{name}</span>
                    <span className="block truncate text-small text-tertiary">
                      Create a local branch to switch
                    </span>
                  </div>
                </CommandItem>
              ))}
              <CommandSeparator alwaysRender />
              <CommandItem
                forceMount
                value="__create-branch__"
                disabled={unavailable || unborn}
                onSelect={() => startCreate("branch")}
                className="gap-2 text-secondary"
              >
                <Plus className="size-4 shrink-0" />
                <span className="min-w-0 truncate text-small-strong">
                  {trimmedQuery && !list.includes(trimmedQuery)
                    ? `Create branch “${trimmedQuery}”…`
                    : "Create and checkout new branch…"}
                </span>
              </CommandItem>
              {createWorktree ? (
                <CommandItem
                  forceMount
                  value="__create-worktree__"
                  disabled={unavailable || unborn}
                  onSelect={() => startCreate("worktree")}
                  className="gap-2 text-secondary"
                >
                  <FolderGit2 className="size-4 shrink-0" />
                  <span className="min-w-0 truncate text-small-strong">
                    New isolated worktree…
                  </span>
                </CommandItem>
              ) : null}
            </CommandList>
          </Command>
        )}
      </CustomDropdownMenuContent>
    </CustomDropdownMenu>
  );
}
