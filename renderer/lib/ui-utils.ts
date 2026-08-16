import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Aiden's semantic typography tokens share Tailwind's `text-*` prefix for
 * both size and color. Teach tailwind-merge which group each token belongs to
 * so `text-small text-secondary` keeps both halves of the type hierarchy.
 */
const mergeAidenClasses = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "heading1",
            "heading2",
            "large-strong",
            "regular",
            "strong",
            "small",
            "small-strong",
            "mini",
          ],
        },
      ],
      "text-color": [
        {
          text: ["primary", "secondary", "tertiary", "quaternary", "red"],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return mergeAidenClasses(clsx(inputs));
}

export function initLogging(): void {
  // Browser console logging is available directly in Electron's renderer.
}
