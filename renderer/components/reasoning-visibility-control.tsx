import { Eye, EyeOff } from "lucide-react";
import { cn } from "../lib/ui-utils";

export function ReasoningVisibilityControl({
  visible,
  disabled = false,
  onChange,
}: {
  visible: boolean;
  disabled?: boolean;
  onChange: (visible: boolean) => void;
}) {
  const label = visible ? "Hide local model reasoning" : "Show local model reasoning";
  const Icon = visible ? Eye : EyeOff;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={visible}
      aria-label={label}
      title={`${label}. This changes presentation only; the model's reasoning effort is unchanged.`}
      disabled={disabled}
      onClick={() => onChange(!visible)}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-pill bg-control/50 px-2 text-small outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
        visible
          ? "text-secondary hover:bg-list-hover hover:text-primary focus-visible:bg-list-selection"
          : "text-tertiary hover:bg-list-hover hover:text-secondary focus-visible:bg-list-selection",
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span>Reasoning</span>
    </button>
  );
}
