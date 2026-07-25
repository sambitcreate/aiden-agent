import { cn } from "../lib/ui-utils";
import type { GenerationThinkingLevel } from "../shared/generation-thinking";

const LABELS: Record<GenerationThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function ThinkingControl<TLevel extends GenerationThinkingLevel>({
  level,
  levels,
  canDisable = true,
  disabled = false,
  providerLabel = "Gemini",
  onChange,
}: {
  level: TLevel;
  levels: readonly TLevel[];
  canDisable?: boolean;
  disabled?: boolean;
  providerLabel?: string;
  onChange: (level: TLevel) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`${providerLabel} thinking level`}
      aria-disabled={disabled || undefined}
      className="flex h-7 shrink-0 items-center rounded-pill bg-control/50 p-0.5"
    >
      {levels.map((value, index) => {
        const selected = value === level;
        const hidesMinimumThinking = value === "off" && !canDisable;
        const label = hidesMinimumThinking ? "Hide" : LABELS[value];
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={
              hidesMinimumThinking
                ? "Thinking: hide model thoughts"
                : `Thinking: ${value === "off" ? "off" : `${value} effort`}`
            }
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            title={
              hidesMinimumThinking
                ? "Hide model thoughts (this model still uses its minimum thinking level)"
                : `${providerLabel} thinking: ${value === "off" ? "off" : value}`
            }
            onClick={() => {
              if (!selected) onChange(value);
            }}
            onKeyDown={(event) => {
              let nextIndex: number | undefined;
              switch (event.key) {
                case "ArrowRight":
                case "ArrowDown":
                  nextIndex = (index + 1) % levels.length;
                  break;
                case "ArrowLeft":
                case "ArrowUp":
                  nextIndex = (index - 1 + levels.length) % levels.length;
                  break;
                case "Home":
                  nextIndex = 0;
                  break;
                case "End":
                  nextIndex = levels.length - 1;
                  break;
              }
              if (nextIndex === undefined) return;
              event.preventDefault();
              const nextLevel = levels[nextIndex];
              if (nextLevel !== level) onChange(nextLevel);
              const radios =
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="radio"]',
                );
              radios?.[nextIndex]?.focus();
            }}
            className={cn(
              "h-6 rounded-pill px-1.5 text-small outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out focus-visible:outline-none disabled:pointer-events-none disabled:opacity-45",
              selected
                ? "bg-popover text-primary shadow-control focus-visible:bg-popover"
                : "text-tertiary hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
