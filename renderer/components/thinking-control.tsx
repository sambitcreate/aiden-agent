import { cn } from "../lib/ui-utils";
import {
  GOOGLE_THINKING_LEVELS,
  type GoogleThinkingLevel,
} from "../shared/google-thinking";

const LABELS: Record<GoogleThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Med",
  high: "High",
};

export function ThinkingControl({
  level,
  levels = GOOGLE_THINKING_LEVELS,
  canDisable = true,
  disabled = false,
  onChange,
}: {
  level: GoogleThinkingLevel;
  levels?: readonly GoogleThinkingLevel[];
  canDisable?: boolean;
  disabled?: boolean;
  onChange: (level: GoogleThinkingLevel) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Gemini thinking level"
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
                : `Gemini thinking: ${value === "off" ? "off" : value}`
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
              "h-6 rounded-pill px-1.5 text-small outline-none transition-[background-color,box-shadow,color,opacity] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-focus-ring disabled:pointer-events-none disabled:opacity-45",
              selected
                ? "bg-popover text-primary shadow-control"
                : "text-tertiary hover:bg-list-hover hover:text-secondary active:bg-list-selection",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
