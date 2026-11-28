import * as React from "react";
import { prefersReducedMotion } from "./appearance-runtime";

/** Slack after the longest animation's computed end before the fallback unmounts anyway. */
const SETTLE_MARGIN_MS = 50;

function endsAt(animation: Animation): number {
  return Number(animation.effect?.getComputedTiming().endTime);
}

/**
 * Calls `done` once every finite animation on `element` itself has finished, or right away
 * when there are none or Reduce Motion is applied. Animations inside it (a row's entrance)
 * do not hold it, infinite loops are ignored, and a timeout from the longest computed end
 * covers an animation that is paused, cancelled or never settles. Reading the animations flushes styles, so an exit
 * keyframe the last render switched on is included. Returns a cleanup that cancels.
 */
export function whenAnimationsSettle(element: Element | null, done: () => void): () => void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    done();
  };
  const animations =
    element && typeof element.getAnimations === "function" && !prefersReducedMotion()
      ? element.getAnimations().filter((animation) => Number.isFinite(endsAt(animation)))
      : [];
  if (animations.length === 0) {
    finish();
    return () => {};
  }
  const remaining = Math.max(
    0,
    ...animations.map(
      (animation) =>
        endsAt(animation) - (Number(animation.effect?.getComputedTiming().localTime) || 0),
    ),
  );
  timer = setTimeout(finish, remaining + SETTLE_MARGIN_MS);
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
  return () => {
    settled = true;
    clearTimeout(timer);
  };
}

/**
 * Keeps an element mounted while its exit animation plays. `rendered` stays true after
 * `present` turns false until the animations on `ref`'s element itself (styled by `exiting`,
 * usually `data-presence="exiting"`) finish; with none, or under Reduce Motion, it drops
 * before the next paint. Turning `present` back on cancels the exit.
 */
export function usePresence(
  present: boolean,
  ref: React.RefObject<Element | null>,
): { rendered: boolean; exiting: boolean } {
  const [retained, setRetained] = React.useState(present);
  const exiting = !present && retained;

  React.useLayoutEffect(() => {
    if (present) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    return whenAnimationsSettle(ref.current, () => setRetained(false));
  }, [present, ref, retained]);

  return { rendered: present || retained, exiting };
}
