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
    <div className="group/thinking relative h-8 w-18 shrink-0">
      <div
        role="radiogroup"
        aria-label={`${providerLabel} thinking level`}
        aria-disabled={disabled || undefined}
        className="absolute bottom-0 right-0 z-20 flex min-w-18 flex-col items-stretch overflow-hidden rounded-dialog bg-transparent p-0.5 transition-[background-color,box-shadow] duration-150 ease-out group-hover/thinking:bg-control/80 group-hover/thinking:shadow-control-hover group-focus-within/thinking:bg-control/80 group-focus-within/thinking:shadow-control-hover"
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
              aria-disabled={disabled || undefined}
              title={
                hidesMinimumThinking
                  ? "Hide model thoughts (this model still uses its minimum thinking level)"
                  : `${providerLabel} thinking: ${value === "off" ? "off" : value}`
              }
              onClick={() => {
                if (!disabled && !selected) onChange(value);
              }}
              onKeyDown={(event) => {
                if (disabled) return;
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
                "flex h-7 w-full items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-pill px-3 text-regular outline-none transition-[max-height,background-color,box-shadow,color,opacity] duration-150 ease-out focus-visible:outline-none aria-disabled:cursor-default",
                selected
                  ? "max-h-7 bg-transparent text-primary group-hover/thinking:bg-popover group-hover/thinking:shadow-control group-focus-within/thinking:bg-popover group-focus-within/thinking:shadow-control"
                  : "pointer-events-none max-h-0 text-tertiary opacity-0 group-hover/thinking:pointer-events-auto group-hover/thinking:max-h-7 group-hover/thinking:opacity-100 group-focus-within/thinking:pointer-events-auto group-focus-within/thinking:max-h-7 group-focus-within/thinking:opacity-100 hover:bg-list-hover hover:text-secondary active:bg-list-selection focus-visible:bg-list-selection",
              )}
            >
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
