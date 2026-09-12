import { Check, ChevronDown } from "lucide-react";
import type { ShellMode } from "../lib/shell-mode";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useSplitViewSidebar,
} from "./ui";

const MODES: ReadonlyArray<{ id: ShellMode; label: string; description: string }> = [
  { id: "agent", label: "Agent", description: "Build, debug, and ship" },
  { id: "design", label: "Design", description: "Create, iterate, and explore" },
];

export function WorkspaceModeSwitcher({
  mode,
  onModeChange,
}: {
  mode: ShellMode;
  onModeChange: (mode: ShellMode) => boolean;
}) {
  const label = mode === "design" ? "Design" : "Agent";
  const { closeIfCompact } = useSplitViewSidebar();

  const selectMode = (nextMode: ShellMode) => {
    if (onModeChange(nextMode)) closeIfCompact();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Current mode: ${label}. Switch mode`}
          style={{ fontSize: "calc(var(--ui-font-size) + var(--ui-font-size))" }}
          className="no-drag flex h-14 max-w-full cursor-default items-center gap-2 rounded-[10px] border-0 bg-transparent px-1 font-bold leading-none text-primary shadow-none outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-5 shrink-0 text-tertiary" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-80 !rounded-[18px] p-2">
        {MODES.map((item) => (
          <DropdownMenuItem
            key={item.id}
            aria-checked={mode === item.id}
            role="menuitemradio"
            className="group min-h-20 items-center justify-between rounded-[18px] px-4 py-3 outline-none"
            onSelect={() => selectMode(item.id)}
          >
            <span className="min-w-0">
              <span className="block text-[18px] font-medium leading-tight text-primary group-data-[highlighted]:text-accent-foreground">
                {item.label}
              </span>
              <span className="mt-1 block text-[15px] leading-snug text-secondary group-data-[highlighted]:text-accent-foreground">
                {item.description}
              </span>
            </span>
            {mode === item.id ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
