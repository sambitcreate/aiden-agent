import * as React from "react";
import {
  completeHeldModifierSet,
  heldModifiersAfterKeydown,
  heldModifiersAfterKeyup,
  trackedModifiersFromSets,
} from "./held-modifier-reveal";

export function useHeldModifierReveal(
  modifierSets: readonly string[][],
  delayMs: number,
): boolean {
  const [visible, setVisible] = React.useState(false);
  const signature = modifierSets.map((modifiers) => modifiers.join("+")).join("|");

  React.useEffect(() => {
    const revealModifierSets = signature
      .split("|")
      .filter(Boolean)
      .map((item) => item.split("+"));
    const tracked = trackedModifiersFromSets(revealModifierSets);
    const held = new Set<string>();
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const hide = () => {
      held.clear();
      clearTimer();
      setVisible(false);
    };
    const scheduleReveal = () => {
      if (timer !== null || !completeHeldModifierSet(held, revealModifierSets)) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (completeHeldModifierSet(held, revealModifierSets)) setVisible(true);
      }, delayMs);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const previousComplete = completeHeldModifierSet(held, revealModifierSets);
      const next = heldModifiersAfterKeydown(held, event, tracked);
      if (next.size === held.size && [...next].every((modifier) => held.has(modifier))) return;
      held.clear();
      for (const modifier of next) held.add(modifier);
      if (!previousComplete && completeHeldModifierSet(held, revealModifierSets)) {
        scheduleReveal();
      } else if (!completeHeldModifierSet(held, revealModifierSets)) {
        clearTimer();
        setVisible(false);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const next = heldModifiersAfterKeyup(held, event, tracked);
      held.clear();
      for (const modifier of next) held.add(modifier);
      if (held.size === 0) hide();
      else if (!completeHeldModifierSet(held, revealModifierSets)) {
        clearTimer();
        setVisible(false);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") hide();
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", hide);
      hide();
    };
  }, [delayMs, signature]);

  return visible;
}
