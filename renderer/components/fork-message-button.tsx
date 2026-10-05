// Transcript hover action that forks the chat at one message. Settled replies
// offer "Fork from here"; sent prompts offer "Edit in fork".

import { GitFork, SquarePen } from "lucide-react";
import { cn } from "../lib/ui-utils";

export interface MessageForkAction {
  onFork: () => void;
  /** When set, forking is unavailable right now and this explains why. */
  disabledReason?: string | null;
}

interface ForkMessageButtonProps {
  action: MessageForkAction;
  kind: "fork" | "edit";
  className?: string;
}

export function ForkMessageButton({ action, kind, className }: ForkMessageButtonProps) {
  const label = kind === "fork" ? "Fork from here" : "Edit in fork";
  const disabledReason = action.disabledReason ?? null;
  const Icon = kind === "fork" ? GitFork : SquarePen;
  return (
    <button
      type="button"
      onClick={disabledReason ? undefined : action.onFork}
      aria-label={label}
      aria-disabled={disabledReason ? true : undefined}
      title={disabledReason ?? label}
      data-fork-action={kind}
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-1.5 py-1 text-tertiary outline-none",
        "transition-[background-color,box-shadow,color] duration-150 ease-out hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection focus-visible:outline-none",
        "aria-disabled:cursor-default aria-disabled:hover:bg-transparent aria-disabled:hover:text-tertiary aria-disabled:[&>svg]:opacity-50",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </button>
  );
}
