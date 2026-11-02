import type * as React from "react";

/**
 * Arrow keys, Home and End move a radio card group's selection and focus
 * together, as a native radio group does. Each group keeps one tab stop: the
 * checked card.
 */
export function handleRadioNavigation<Value extends string>(
  event: React.KeyboardEvent<HTMLButtonElement>,
  index: number,
  options: ReadonlyArray<{ value: Value }>,
  onChange: (value: Value) => void,
): void {
  let nextIndex: number | null = null;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + options.length) % options.length;
  } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % options.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = options.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const group = event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
  group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]?.focus();
  onChange(options[nextIndex].value);
}
