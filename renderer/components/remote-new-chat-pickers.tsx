import * as React from "react";
import { Check, ChevronDown, Folder, FolderOpen, FolderX, Globe, Loader2, Monitor } from "lucide-react";
import type { NewChatMachine, RemoteProjectChoice } from "../lib/hosts/new-chat-targets";
import type { HostModelCatalog, HostModelChoice } from "../lib/hosts/host-resources";
import { LOCAL_MACHINE_LABEL } from "../lib/sidebar-remote-groups";
import {
  Button,
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./ui";

/**
 * Pickers for a new chat that can run on another Mac: which machine, which of
 * that host's projects, and which of its models. Every choice comes from the
 * host; none of them lists this Mac's projects or models for a remote chat.
 */

/** `"local"` is this Mac; any other value is a paired host's ID. */
export type NewChatMachineId = "local" | (string & {});

const TRIGGER_CLASS = "h-7 min-w-0 max-w-[14rem] shrink gap-1.5 px-2 text-secondary max-[520px]:max-w-[9rem]";

export function RemoteMachinePicker({
  machines,
  selected,
  disabled,
  onSelect,
}: {
  machines: readonly NewChatMachine[];
  selected: NewChatMachineId;
  disabled?: boolean;
  onSelect(machine: NewChatMachineId): void;
}) {
  const current = machines.find((machine) => machine.id === selected);
  const label = current?.label ?? LOCAL_MACHINE_LABEL;
  const Icon = current ? Globe : Monitor;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          className={TRIGGER_CLASS}
          disabled={disabled}
          aria-label={`Runs on ${label}. Choose where this chat runs`}
          data-new-chat-machine={selected}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel>Run this chat on</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={selected} onValueChange={(value) => onSelect(value)}>
          <DropdownMenuRadioItem value="local">
            <span className="flex min-w-0 items-center gap-2">
              <Monitor className="size-4 shrink-0 text-secondary" aria-hidden="true" />
              <span className="truncate">{LOCAL_MACHINE_LABEL}</span>
            </span>
          </DropdownMenuRadioItem>
          {machines.map((machine) => (
            <DropdownMenuRadioItem
              key={machine.id}
              value={machine.id}
              disabled={Boolean(machine.disabledReason) && machine.id !== selected}
              data-new-chat-machine-option={machine.id}
            >
              <span className="flex min-w-0 items-start gap-2">
                <Globe className="mt-0.5 size-4 shrink-0 text-secondary" aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{machine.label}</span>
                  {machine.disabledReason ? (
                    <span className="max-w-64 text-small text-tertiary">{machine.disabledReason}</span>
                  ) : null}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Scratch chats run in a project the host creates for them. */
export const SCRATCH_PROJECT = "scratch";

export function RemoteProjectPicker({
  hostLabel,
  projects,
  selected,
  disabled,
  canCreate,
  canBrowse,
  onSelect,
  onBrowse,
}: {
  hostLabel: string;
  projects: readonly RemoteProjectChoice[];
  /** A project ID, or `SCRATCH_PROJECT`. */
  selected: string;
  disabled?: boolean;
  /** The host lets this Mac create projects (scratch or from a folder). */
  canCreate: boolean;
  canBrowse: boolean;
  onSelect(projectId: string): void;
  onBrowse(): void;
}) {
  const [open, setOpen] = React.useState(false);
  const current = projects.find((project) => project.id === selected);
  const label = current?.name ?? (selected === SCRATCH_PROJECT ? "No project" : "Choose a project");
  const choose = (projectId: string) => {
    setOpen(false);
    onSelect(projectId);
  };
  return (
    <Popover open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
      <PopoverTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          className={TRIGGER_CLASS}
          disabled={disabled}
          aria-label={`Project on ${hostLabel}: ${label}`}
          data-remote-project={selected}
        >
          {selected === SCRATCH_PROJECT ? (
            <FolderX className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <Folder className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        aria-label={`Choose a project on ${hostLabel}`}
      >
        <Command>
          <CommandInput placeholder={`Search projects on ${hostLabel}`} autoFocus />
          <CommandList className="h-auto max-h-72">
            <CommandEmpty>No matching projects.</CommandEmpty>
            {projects.map((project) => (
              <CommandItem
                key={project.id}
                value={`${project.name} ${project.detail ?? ""} ${project.id}`}
                onSelect={() => choose(project.id)}
                className="min-h-11 gap-2.5 px-2.5 py-1.5"
              >
                <Folder className="size-4.5 shrink-0 text-secondary" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-regular">{project.name}</span>
                  {project.detail ? <span className="truncate text-small text-tertiary">{project.detail}</span> : null}
                </span>
                {project.id === selected ? (
                  <Check className="size-4 shrink-0 text-secondary" aria-label="Current project" />
                ) : null}
              </CommandItem>
            ))}
            {canCreate ? (
              <>
                {projects.length > 0 ? <CommandSeparator /> : null}
                {canBrowse ? (
                  <CommandItem
                    value={`choose a folder on ${hostLabel} browse`}
                    onSelect={() => {
                      setOpen(false);
                      onBrowse();
                    }}
                    className="min-h-11 gap-2.5 px-2.5 py-1.5"
                  >
                    <FolderOpen className="size-4.5 shrink-0 text-secondary" aria-hidden="true" />
                    <span className="truncate text-regular">{`Choose a folder on ${hostLabel}…`}</span>
                  </CommandItem>
                ) : null}
                <CommandItem
                  value="don't work in a project scratch"
                  onSelect={() => choose(SCRATCH_PROJECT)}
                  className="min-h-12 gap-2.5 px-2.5 py-1.5"
                >
                  <FolderX className="size-4.5 shrink-0 text-secondary" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-regular">Don’t work in a project</span>
                    <span className="truncate text-small text-tertiary">{`Use a new scratch folder on ${hostLabel}`}</span>
                  </span>
                  {selected === SCRATCH_PROJECT ? (
                    <Check className="size-4 shrink-0 text-secondary" aria-label="Current project" />
                  ) : null}
                </CommandItem>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function choiceValue(choice: HostModelChoice): string {
  return JSON.stringify([choice.providerId, choice.modelId]);
}

export function RemoteModelPicker({
  hostLabel,
  catalog,
  loading,
  selected,
  disabled,
  onSelect,
}: {
  hostLabel: string;
  catalog: HostModelCatalog | undefined;
  loading: boolean;
  selected: HostModelChoice | undefined;
  disabled?: boolean;
  onSelect(choice: HostModelChoice): void;
}) {
  const providers = catalog?.providers ?? [];
  const model = selected
    ? providers.find((provider) => provider.id === selected.providerId)?.models.find((entry) => entry.id === selected.modelId)
    : undefined;
  const label = model?.label ?? (loading ? "Loading models…" : "Host default");
  const byValue = new Map(
    providers.flatMap((provider) =>
      provider.models.map((entry) => [choiceValue({ providerId: provider.id, modelId: entry.id }), { providerId: provider.id, modelId: entry.id }] as const),
    ),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="transparent"
          size="small"
          className={TRIGGER_CLASS}
          disabled={disabled || providers.length === 0}
          aria-label={`Model on ${hostLabel}: ${label}`}
        >
          {loading ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" /> : null}
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-tertiary" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="max-h-80 w-[min(18rem,calc(100vw-2rem))] overflow-y-auto">
        <DropdownMenuRadioGroup
          value={selected ? choiceValue(selected) : ""}
          onValueChange={(value) => {
            const choice = byValue.get(value);
            if (choice) onSelect(choice);
          }}
        >
          {providers.map((provider, index) => (
            <React.Fragment key={provider.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuLabel>{provider.label}</DropdownMenuLabel>
              {provider.models.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={choiceValue({ providerId: provider.id, modelId: entry.id })}>
                  <span className="truncate">{entry.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </React.Fragment>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
