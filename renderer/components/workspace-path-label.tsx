import * as React from "react";
import { formatWorkspacePath } from "../lib/workspace-path-display";
import type { AppearanceConfig } from "../shared/appearance";

/** Fit the selected truncation style to the real label width, including UI font/zoom changes. */
export function WorkspacePathLabel({
  path,
  format,
}: {
  path: string;
  format: AppearanceConfig["workspacePathFormat"];
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [label, setLabel] = React.useState(() => formatWorkspacePath(path, format, 24));
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    const update = () => {
      context.font = getComputedStyle(element).font;
      const width = element.clientWidth;
      // Paths longer than a label could ever show need only a bounded search.
      let low = 0;
      let high = Math.min(path.length, 512);
      let next = "";
      while (low <= high) {
        const budget = Math.floor((low + high) / 2);
        const candidate = formatWorkspacePath(path, format, budget);
        if (context.measureText(candidate).width <= width) {
          next = candidate;
          low = budget + 1;
        } else {
          high = budget - 1;
        }
      }
      setLabel(next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // Fonts can change without the row's width changing.
    document.fonts.addEventListener("loadingdone", update);
    window.addEventListener("aiden:appearance-changed", update);
    update();
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", update);
      window.removeEventListener("aiden:appearance-changed", update);
    };
  }, [path, format]);
  return (
    <span
      ref={ref}
      className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-small text-tertiary"
      title={path}
    >
      {label}
    </span>
  );
}
