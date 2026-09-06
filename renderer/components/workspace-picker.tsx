import * as React from "react";
import { Check, Folder, FolderX, Loader2 } from "lucide-react";
import type { Workspace } from "../lib/types";
import { workspaceDisplayName } from "../lib/workspace-path-display";
import { WorkspacePathLabel } from "./workspace-path-label";
import { useWorkspacePathPreferences } from "../lib/use-workspace-path-preferences";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from "./ui";

interface WorkspacePickerProps {
  trigger: React.ReactElement;
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onSelectWorkspace: (workspaceId: string) => Promise<void>;
  onCreateScratchWorkspace: () => Promise<void>;
  blockedReason?: string;
}

export function WorkspacePicker({
  trigger,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateScratchWorkspace,
  blockedReason,
}: WorkspacePickerProps) {
  const pathPreferences = useWorkspacePathPreferences();
  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState<string | null>(null);
  const blockedReasonId = React.useId();

  const perform = async (key: string, action: () => Promise<void>) => {
    if (blockedReason) {
      toast.error(blockedReason);
      return;
    }
    if (pending) return;
    setPending(key);
    try {
      await action();
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't change the workspace.",
      );
    } finally {
      setPending(null);
    }
  };

  const chooseWorkspace = (workspaceId: string) => {
    if (workspaceId === activeWorkspaceId) {
      setOpen(false);
      return;
    }
    void perform(workspaceId, () => onSelectWorkspace(workspaceId));
  };

  return (
    <>
      {blockedReason ? (
        <span id={blockedReasonId} className="sr-only" role="status">
          {blockedReason}
        </span>
      ) : null}
      <Popover
        open={blockedReason ? false : open}
        onOpenChange={(nextOpen) =>
          !pending && !blockedReason && setOpen(nextOpen)
        }
      >
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
          aria-label="Choose a workspace"
        >
          <Command>
            <CommandInput placeholder="Search workspaces" autoFocus />
            <CommandList className="h-auto max-h-72">
              <CommandEmpty>No matching workspaces.</CommandEmpty>
              {workspaces.map((workspace) => (
                <CommandItem
                  key={workspace.id}
                  value={`${workspace.name} ${workspace.folderPath ?? ""} ${workspace.id}`}
                  disabled={pending !== null || Boolean(blockedReason)}
                  onSelect={() => chooseWorkspace(workspace.id)}
                  className="min-h-11 gap-2.5 px-2.5 py-1.5"
                >
                  <Folder className="size-4.5 shrink-0 text-secondary" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-regular">
                      {workspaceDisplayName(workspace, workspaces)}
                    </span>
                    {workspace.folderPath && pathPreferences.showWorkspacePaths ? (
                      <WorkspacePathLabel path={workspace.folderPath} format={pathPreferences.workspacePathFormat} />
                    ) : null}
                  </span>
                  {pending === workspace.id ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-secondary" />
                  ) : workspace.id === activeWorkspaceId ? (
                    <Check
                      className="size-4 shrink-0 text-secondary"
                      aria-label="Current workspace"
                    />
                  ) : null}
                </CommandItem>
              ))}
              <CommandSeparator />
              <CommandItem
                value="don't work in a workspace scratch folder aiden"
                disabled={pending !== null || Boolean(blockedReason)}
                onSelect={() =>
                  void perform("scratch", onCreateScratchWorkspace)
                }
                className="min-h-12 gap-2.5 px-2.5 py-1.5"
              >
                <FolderX className="size-4.5 shrink-0 text-secondary" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-regular">
                    Don’t work in a workspace
                  </span>
                  <span className="truncate text-small text-tertiary">
                    Use a new scratch folder in ~/aiden
                  </span>
                </span>
                {pending === "scratch" ? (
                  <Loader2 className="size-4 shrink-0 animate-spin text-secondary" />
                ) : null}
              </CommandItem>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  );
}
