import * as React from "react";
import { Check } from "lucide-react";
import { AvatarFace } from "../../components/bot-avatar";
import { Button, Text } from "../../components/ui";
import {
  BOT_AVATAR_COLOR_LABELS,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPE_LABELS,
  BOT_AVATAR_SHAPES,
  DEFAULT_BOT_AVATAR,
  resolveBotAvatar,
  type BotAvatar,
  type BotAvatarAppearance,
  type BotAvatarColor,
  type BotAvatarShape,
} from "../../shared/bots";

function sameCharacter(left: BotAvatarAppearance, right: BotAvatarAppearance): boolean {
  return left.shape === right.shape && left.color === right.color;
}

/**
 * Keyboard model shared by both choice rows: one tab stop on the selected
 * choice, arrow keys move and select, as native radio groups do.
 */
function useRovingRadio<Value extends string>(
  values: readonly Value[],
  selected: Value,
  select: (value: Value) => void,
) {
  const refs = React.useRef(new Map<Value, HTMLButtonElement>());
  const onKeyDown = (event: React.KeyboardEvent, value: Value) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const index = values.indexOf(value);
    const next = values[(index + step + values.length) % values.length]!;
    select(next);
    refs.current.get(next)?.focus();
  };
  const register = (value: Value) => (element: HTMLButtonElement | null) => {
    if (element) refs.current.set(value, element);
    else refs.current.delete(value);
  };
  return { onKeyDown, register, tabIndex: (value: Value) => (value === selected ? 0 : -1) };
}

/**
 * Character: the colour and shape that make up a Bot's mark everywhere.
 * Selection is shown with a check or a soft fill, never a decorative border.
 */
export function BotCharacterCard({
  avatar,
  onChange,
  disabled = false,
}: {
  avatar: BotAvatar;
  onChange(avatar: BotAvatarAppearance): void;
  disabled?: boolean;
}) {
  const current = resolveBotAvatar(avatar);
  const choose = (patch: Partial<Pick<BotAvatarAppearance, "shape" | "color">>) => {
    const next = { ...current, ...patch };
    if (!sameCharacter(next, current)) onChange(next);
  };
  const colors = useRovingRadio<BotAvatarColor>(BOT_AVATAR_COLORS, current.color, (color) =>
    choose({ color }),
  );
  const shapes = useRovingRadio<BotAvatarShape>(BOT_AVATAR_SHAPES, current.shape, (shape) =>
    choose({ shape }),
  );
  const isDefault = sameCharacter(current, DEFAULT_BOT_AVATAR);

  return (
    <section aria-labelledby="bot-character-title" className="space-y-2">
      <Text id="bot-character-title" as="h2" variant="small-strong" color="secondary" className="px-1">
        Character
      </Text>
      <div className="space-y-3 rounded-card bg-well p-3">
        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-2">
          {BOT_AVATAR_COLORS.map((color) => {
            const checked = current.color === color;
            return (
              <button
                key={color}
                ref={colors.register(color)}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={BOT_AVATAR_COLOR_LABELS[color]}
                tabIndex={colors.tabIndex(color)}
                disabled={disabled}
                onClick={() => choose({ color })}
                onKeyDown={(event) => colors.onKeyDown(event, color)}
                className="grid size-8 place-items-center rounded-full outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-45"
                style={{ backgroundColor: `var(--bot-avatar-${color})` }}
              >
                {checked ? (
                  <Check aria-hidden="true" className="size-4 text-[var(--bot-avatar-face)]" />
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="h-px bg-separator" aria-hidden="true" />
        <div role="radiogroup" aria-label="Shape" className="flex flex-wrap gap-1">
          {BOT_AVATAR_SHAPES.map((shape) => {
            const checked = current.shape === shape;
            return (
              <button
                key={shape}
                ref={shapes.register(shape)}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={BOT_AVATAR_SHAPE_LABELS[shape]}
                tabIndex={shapes.tabIndex(shape)}
                disabled={disabled}
                onClick={() => choose({ shape })}
                onKeyDown={(event) => shapes.onKeyDown(event, shape)}
                className={`grid size-10 place-items-center rounded-control p-1.5 outline-none transition-colors duration-150 hover:bg-list-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-45 ${
                  checked ? "bg-list-selection" : ""
                }`}
              >
                <AvatarFace avatar={{ ...current, shape }} />
              </button>
            );
          })}
        </div>
        <div className="h-px bg-separator" aria-hidden="true" />
        <Button
          size="small"
          variant="transparent"
          disabled={disabled || isDefault}
          onClick={() => onChange({ ...DEFAULT_BOT_AVATAR })}
        >
          Reset to default
        </Button>
      </div>
      <Text as="p" variant="small" color="tertiary" className="px-1">
        How this Bot looks everywhere.
      </Text>
    </section>
  );
}
