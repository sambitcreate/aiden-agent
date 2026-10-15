import * as React from "react";
import { browserFloatingContentBounds, type BrowserFloatingFrame } from "./browser-floating-layout";

/**
 * The chat area a floating player may cover, in viewport coordinates: the
 * transcript below its toolbar and above the composer, left of any open side
 * surface. Re-measured when the chat, composer, or side surfaces change.
 */
export function useFloatingContainerBounds(): BrowserFloatingFrame {
  const [container, setContainer] = React.useState<BrowserFloatingFrame>({ x: 0, y: 0, width: 0, height: 0 });
  React.useLayoutEffect(() => {
    const target = document.querySelector<HTMLElement>("[data-browser-floating-container]");
    const workbench = target?.closest<HTMLElement>("[data-environment-surface-mode]");
    let observed = new Set<HTMLElement>();
    let animationFrame = 0;
    const rect = (element: HTMLElement): BrowserFloatingFrame => {
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    };
    const measure = () => {
      animationFrame = 0;
      // ScrollArea's viewport excludes the terminal drawer; its absolute toolbar
      // is removed separately. The outer workbench can also contain an overlaid
      // Environment panel, so its full width is not the usable chat width.
      const viewport = target?.querySelector<HTMLElement>("[data-scroll-top]") ?? target;
      const toolbar = target?.querySelector<HTMLElement>("[data-toolbar]");
      const composer = target?.querySelector<HTMLElement>('[data-browser-composer-inset="true"]');
      const surfaces = Array.from(workbench?.querySelectorAll<HTMLElement>('[data-environment-surface][data-state="open"]') ?? []);
      const nextObserved = new Set([target, viewport, toolbar, composer, ...surfaces].filter((element): element is HTMLElement => Boolean(element)));
      for (const element of observed) if (!nextObserved.has(element)) observer.unobserve(element);
      for (const element of nextObserved) if (!observed.has(element)) observer.observe(element);
      observed = nextObserved;
      const next = viewport ? browserFloatingContentBounds({ viewport: rect(viewport), toolbar: toolbar ? rect(toolbar) : undefined, composer: composer ? rect(composer) : undefined, sideSurfaces: surfaces.map(rect) }) : { x: 0, y: 0, width: 0, height: 0 };
      setContainer((current) => Object.keys(next).every((key) => current[key as keyof typeof next] === next[key as keyof typeof next]) ? current : next);
    };
    const schedule = () => { if (!animationFrame) animationFrame = window.requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    measure();
    const mutations = new MutationObserver(schedule);
    if (workbench ?? target) mutations.observe((workbench ?? target)!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-browser-composer-inset", "data-state", "style"] });
    window.addEventListener("resize", schedule);
    document.addEventListener("transitionend", schedule, true);
    return () => { window.cancelAnimationFrame(animationFrame); observer.disconnect(); mutations.disconnect(); window.removeEventListener("resize", schedule); document.removeEventListener("transitionend", schedule, true); };
  }, []);
  return container;
}
