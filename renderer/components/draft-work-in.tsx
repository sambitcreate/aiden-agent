// The branch menu's draft-only section: Work in (this checkout, a new worktree
// created on first send, or an existing managed worktree), and the New
// worktree settings. Nothing here touches disk; the worktree is created when
// the first message is sent.

import * as React from "react";
import { FolderGit2, PencilLine } from "lucide-react";
import { Input, Switch, Text, toast } from "./ui";
import { cn } from "../lib/ui-utils";
import type { ChatDraftGitMode, ChatDraftWorktree } from "../lib/chat-draft";
import { resolveDraftWorktreeDefaults } from "../lib/chat-draft-git-memory";
import type { DraftWorkInOptions } from "../lib/draft-git-menu";
import type { GitBranches } from "../lib/types";
import { isValidBranchName } from "../shared/worktree-on-send";

export interface GitBranchPickerDraft {
  /** This checkout or New worktree; a draft in an existing worktree reports checkout. */
  gitMode: ChatDraftGitMode;
  worktree?: ChatDraftWorktree;
  workIn: DraftWorkInOptions;
  onSelectCheckout: () => void | Promise<void>;
  onSelectNewWorktree: () => void | Promise<void>;
  onSelectWorktree: (workspaceId: string) => void | Promise<void>;
  onUpdateWorktree: (update: { baseRef?: string; fromOrigin?: boolean; branchName?: string }) => void;
}

function report(action: () => void | Promise<void>, fallback: string): Promise<void> {
  return Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : fallback);
    });
}

function baseExists(branches: GitBranches, ref: string): boolean {
  return branches.branches.includes(ref) || branches.remoteBranches.includes(ref);
}

/**
 * Keep a New worktree draft's base valid: fill it in from the remembered base,
 * the default branch or the current branch once the branches are known, and
 * replace a remembered base that no longer exists.
 */
export function useDraftWorktreeDefaults(
  draft: GitBranchPickerDraft | undefined,
  branches: GitBranches | undefined,
): void {
  const worktreeMode = draft?.gitMode === "worktree";
  const baseRef = draft?.worktree?.baseRef;
  const fromOrigin = draft?.worktree?.fromOrigin;
  const update = draft?.onUpdateWorktree;
  React.useEffect(() => {
    if (!worktreeMode || !branches || !update) return;
    if (baseRef && baseExists(branches, baseRef)) return;
    const defaults = resolveDraftWorktreeDefaults(
      { gitMode: "worktree", ...(fromOrigin === undefined ? {} : { fromOrigin }) },
      branches,
    );
    if (!defaults) return;
    try {
      update(defaults);
    } catch {
      // The draft is being sent; its settings are fixed until that settles.
    }
  }, [baseRef, branches, fromOrigin, update, worktreeMode]);
}

/** Arrow keys move between a group's radios; Enter or Space chooses. */
function moveRadioFocus(event: React.KeyboardEvent<HTMLButtonElement>) {
  const step =
    event.key === "ArrowDown" || event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? -1
        : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  const radios = Array.from(
    event.currentTarget
      .closest('[role="radiogroup"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([aria-disabled="true"])') ?? [],
  );
  if (radios.length === 0) return;
  event.preventDefault();
  const index = radios.indexOf(event.currentTarget);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (index + step + radios.length) % radios.length;
  radios[next]?.focus();
}

function RadioRow({
  checked,
  disabled,
  onChoose,
  icon,
  label,
  meta,
  rowKey,
}: {
  checked: boolean;
  disabled?: boolean;
  onChoose: () => void;
  icon?: React.ReactNode;
  label: string;
  meta?: string;
  rowKey?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={checked ? 0 : -1}
      data-work-in-row={rowKey}
      onClick={() => {
        if (!disabled && !checked) onChoose();
      }}
      onKeyDown={moveRadioFocus}
      className={cn(
        "flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-regular outline-none transition-colors duration-(--motion-duration) ease-standard",
        "hover:bg-list-hover active:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring",
        "aria-disabled:cursor-default aria-disabled:opacity-45 aria-disabled:hover:bg-transparent",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full transition-colors duration-(--motion-duration) ease-standard",
          // Unchecked reads as an empty well, like the Switch's off state.
          checked ? "bg-accent" : "bg-control-hover shadow-control-pressed",
        )}
      >
        {checked ? <span className="size-1.5 rounded-full bg-accent-foreground" /> : null}
      </span>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {meta ? <span className="max-w-36 shrink-0 truncate text-small text-tertiary">{meta}</span> : null}
    </button>
  );
}

function BranchNameRow({
  branchName,
  disabled,
  onSave,
}: {
  branchName?: string;
  disabled: boolean;
  onSave: (name: string | undefined) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(branchName ?? "");
  const [invalid, setInvalid] = React.useState(false);
  const inputId = React.useId();
  const errorId = React.useId();
  const rowRef = React.useRef<HTMLButtonElement>(null);

  const finish = (save: boolean) => {
    const name = value.trim();
    if (save && name && !isValidBranchName(name)) {
      setInvalid(true);
      return;
    }
    if (save) onSave(name || undefined);
    setInvalid(false);
    setEditing(false);
    requestAnimationFrame(() => rowRef.current?.focus());
  };

  if (!editing) {
    return (
      <button
        ref={rowRef}
        type="button"
        disabled={disabled}
        data-branch-name-row
        onClick={() => {
          setValue(branchName ?? "");
          setEditing(true);
        }}
        className="flex min-h-8 w-full items-center gap-2 rounded-control px-2 text-left text-regular outline-none transition-colors duration-(--motion-duration) ease-standard hover:bg-list-hover active:bg-list-selection focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-45"
      >
        <PencilLine aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
        <span className="shrink-0">Branch name</span>
        <span className="min-w-0 flex-1 truncate text-right text-small text-tertiary">
          {branchName ?? "Auto (from first message)"}
        </span>
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <label htmlFor={inputId} className="text-small text-tertiary">
        Branch name (↵ to save, blank = auto)
      </label>
      <Input
        id={inputId}
        value={value}
        autoFocus
        placeholder="aiden/…"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            finish(true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish(false);
          }
        }}
      />
      {invalid ? (
        <Text id={errorId} variant="small" className="text-status-red">
          Enter a valid Git branch name.
        </Text>
      ) : null}
    </div>
  );
}

export function DraftWorkIn({
  draft,
  branches,
  current,
  uncommitted,
  unborn,
  disabled,
  onDone,
}: {
  draft: GitBranchPickerDraft;
  branches?: GitBranches;
  current: string;
  uncommitted: number;
  unborn: boolean;
  disabled: boolean;
  onDone: () => void;
}) {
  const workInLabelId = React.useId();
  const startFromLabelId = React.useId();
  const { workIn } = draft;
  if (!workIn.source) return null;
  const inExistingWorktree = Boolean(workIn.selectedWorktreeId);
  const mode: "checkout" | "worktree" | "existing" = inExistingWorktree
    ? "existing"
    : draft.gitMode;
  const existingBranch = workIn.worktrees.find(
    (worktree) => worktree.workspaceId === workIn.selectedWorktreeId,
  )?.branch;
  const checkoutMeta = inExistingWorktree
    ? workIn.source.name
    : [current, uncommitted > 0 ? `${uncommitted} change${uncommitted === 1 ? "" : "s"}` : undefined]
        .filter(Boolean)
        .join(" · ");
  const hasRemote = branches ? (branches.hasRemote ?? branches.remoteBranches.length > 0) : false;
  const baseRef = draft.worktree?.baseRef;
  const bases = branches
    ? [...(baseRef && !branches.branches.includes(baseRef) ? [baseRef] : []), ...branches.branches]
    : [];

  return (
    // The menu's own key handling (typeahead, arrow roving between menu
    // items) would swallow these controls' keys; Escape still closes it.
    <div
      className="flex flex-col gap-0.5 p-1"
      data-draft-work-in={mode}
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <div id={workInLabelId} className="px-2 pb-0.5 pt-1.5 text-small text-tertiary">
        Work in
      </div>
      <div role="radiogroup" aria-labelledby={workInLabelId} className="flex flex-col gap-0.5">
        <RadioRow
          rowKey="checkout"
          checked={mode === "checkout"}
          disabled={disabled}
          label="This checkout"
          meta={checkoutMeta}
          onChoose={() => void report(draft.onSelectCheckout, "Couldn't switch to this checkout.")}
        />
        <RadioRow
          rowKey="new-worktree"
          checked={mode === "worktree"}
          disabled={disabled || unborn}
          label="New worktree"
          meta={unborn ? "No commits yet" : "created on send"}
          onChoose={() => void report(draft.onSelectNewWorktree, "Couldn't choose a new worktree.")}
        />
        {workIn.worktrees.map((worktree) => (
          <RadioRow
            key={worktree.workspaceId}
            rowKey={`worktree:${worktree.workspaceId}`}
            checked={worktree.workspaceId === workIn.selectedWorktreeId}
            disabled={disabled}
            icon={<FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-tertiary" />}
            label={worktree.branch}
            meta="worktree"
            onChoose={() =>
              void report(
                () => draft.onSelectWorktree(worktree.workspaceId),
                "Couldn't move this chat to that worktree.",
              ).then(onDone)
            }
          />
        ))}
      </div>
      {mode === "worktree" ? (
        <>
          <div className="mx-2 my-1 h-px bg-separator" aria-hidden="true" />
          <div id={startFromLabelId} className="px-2 pb-0.5 pt-1 text-small text-tertiary">
            Start from
          </div>
          {branches ? (
            <div
              role="radiogroup"
              aria-labelledby={startFromLabelId}
              className="flex max-h-40 flex-col gap-0.5 overflow-y-auto"
            >
              {bases.map((name) => (
                <RadioRow
                  key={name}
                  rowKey={`base:${name}`}
                  checked={name === baseRef}
                  disabled={disabled}
                  label={name}
                  meta={name === branches.defaultBranch ? "default" : undefined}
                  onChoose={() =>
                    void report(
                      () => draft.onUpdateWorktree({ baseRef: name }),
                      "Couldn't change the base branch.",
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <Text variant="small" color="tertiary" className="px-2 py-1.5" role="status">
              Loading branches…
            </Text>
          )}
          {hasRemote && baseRef ? (
            <label className="flex min-h-8 cursor-default items-center gap-2 rounded-control px-2 text-regular hover:bg-list-hover">
              <span className="min-w-0 flex-1 truncate">
                Start from origin/{baseRef.replace(/^origin\//u, "")}
              </span>
              <Switch
                checked={draft.worktree?.fromOrigin === true}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  void report(
                    () => draft.onUpdateWorktree({ fromOrigin: checked }),
                    "Couldn't change where the worktree starts.",
                  )
                }
              />
            </label>
          ) : null}
          <div className="mx-2 my-1 h-px bg-separator" aria-hidden="true" />
          <BranchNameRow
            key={draft.worktree?.branchName ?? ""}
            branchName={draft.worktree?.branchName}
            disabled={disabled || !baseRef}
            onSave={(name) =>
              void report(
                () => draft.onUpdateWorktree({ branchName: name }),
                "Couldn't change the branch name.",
              )
            }
          />
        </>
      ) : mode === "existing" ? (
        <>
          <div className="mx-2 my-1 h-px bg-separator" aria-hidden="true" />
          <Text variant="small" color="secondary" className="px-2 py-1.5">
            Runs in the worktree for {existingBranch ?? current} as it is now.
          </Text>
        </>
      ) : (
        <div className="mx-2 mt-1 h-px bg-separator" aria-hidden="true" />
      )}
    </div>
  );
}
