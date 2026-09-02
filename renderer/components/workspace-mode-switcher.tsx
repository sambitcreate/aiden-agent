import { Check, ChevronDown } from "lucide-react";
import type { ShellMode } from "../lib/shell-mode";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui";

const MODES: ReadonlyArray<{ id: ShellMode; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "design", label: "Design" },
];

export function WorkspaceModeSwitcher({
  mode,
  onModeChange,
}: {
  mode: ShellMode;
  onModeChange: (mode: ShellMode) => void;
}) {
  const label = mode === "design" ? "Design" : "Agent";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Current mode: ${label}. Switch mode`}
          className="no-drag flex h-12 max-w-full cursor-default items-center gap-2 rounded-[13px] bg-control/70 px-3.5 text-[30px] font-bold leading-none text-primary outline-none transition-[background-color,box-shadow] duration-150 hover:bg-control focus-visible:ring-2 focus-visible:ring-focus-ring data-[state=open]:bg-control-active"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-5 shrink-0 text-tertiary" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        {MODES.map((item) => (
          <DropdownMenuItem
            key={item.id}
            aria-checked={mode === item.id}
            role="menuitemradio"
            className="justify-between"
            onSelect={() => onModeChange(item.id)}
          >
            <span>{item.label}</span>
            {mode === item.id ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
