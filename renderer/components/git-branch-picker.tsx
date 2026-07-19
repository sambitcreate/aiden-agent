// Git branch switcher for the composer. Compact trigger (branch icon + name)
// opens a searchable list of local branches with the current one checked and its
// uncommitted-file count, plus a "Create and checkout new branch…" action.

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
  Separator,
  Text,
  toast,
} from "./ui";
import { Check, GitBranch, Loader2, Plus } from "lucide-react";
import { gitApi } from "../lib/ipc";
import { queryKeys, useGitBranches } from "../lib/queries";

interface GitBranchPickerProps {
  folderPath: string;
  /** Current branch, from the composer's git info (used before the list loads). */
  branch: string;
}

export function GitBranchPicker({ folderPath, branch }: GitBranchPickerProps) {
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const branches = useGitBranches(folderPath, open);
  const current = branches.data?.current ?? branch;
  const uncommitted = branches.data?.uncommitted ?? 0;
  const list = branches.data?.branches ?? [];

  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.gitBranches(folderPath) }),
      qc.invalidateQueries({ queryKey: queryKeys.git(folderPath) }),
    ]);

  const reset = () => {
    setCreating(false);
    setNewName("");
  };

  const checkout = async (name: string) => {
    if (name === current) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await gitApi.checkout(folderPath, name);
      await refresh();
      setOpen(false);
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't switch branch.");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await gitApi.createBranch(folderPath, name);
      await refresh();
      setOpen(false);
      reset();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't create branch.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CustomDropdownMenu
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <CustomDropdownMenuTrigger asChild>
        <Button variant="transparent" size="small" className="h-7 min-w-0 max-w-[14rem] flex-1 shrink gap-1.5 px-2 text-tertiary max-[520px]:max-w-[7rem]">
          <GitBranch className="size-4 shrink-0" />
          <span className="min-w-0 truncate text-small">{current}</span>
        </Button>
      </CustomDropdownMenuTrigger>

      <CustomDropdownMenuContent align="start" className="w-72 p-0">
        {creating ? (
          <div className="flex flex-col gap-2 p-3">
            <Text variant="small" color="tertiary">
              New branch from {current}
            </Text>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void create();
                }
              }}
              placeholder="feature/my-branch"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="transparent" size="small" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button variant="accent" size="small" onClick={() => void create()} disabled={busy || !newName.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : "Create"}
              </Button>
            </div>
          </div>
        ) : (
          <Command
            onKeyDown={(e) => {
              if (e.key !== "Escape") e.stopPropagation();
            }}
          >
            <CommandInput placeholder="Search branches" />
            <div className="px-3 pt-2">
              <Text variant="small" color="tertiary">
                Branches
              </Text>
            </div>
            <CommandList>
              <CommandEmpty>{branches.isLoading ? "Loading…" : "No branches found."}</CommandEmpty>
              {list.map((name) => {
                const isActive = name === current;
                return (
                  <CommandItem key={name} value={name} onSelect={() => void checkout(name)} className="gap-2">
                    <GitBranch className="size-4 shrink-0 text-tertiary" />
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-small-strong">{name}</span>
                      {isActive && uncommitted > 0 ? (
                        <span className="block truncate text-small text-tertiary">
                          Uncommitted: {uncommitted} file{uncommitted === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                    {isActive ? <Check className="size-4 shrink-0 text-accent" /> : null}
                  </CommandItem>
                );
              })}
            </CommandList>
            <Separator />
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-7 w-full items-center gap-2 px-2 py-1.5 text-secondary outline-none transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-primary active:bg-list-selection focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
            >
              <Plus className="size-4 shrink-0" />
              <span className="min-w-0 truncate text-left text-small-strong">
                Create and checkout new branch…
              </span>
            </button>
          </Command>
        )}
      </CustomDropdownMenuContent>
    </CustomDropdownMenu>
  );
}
