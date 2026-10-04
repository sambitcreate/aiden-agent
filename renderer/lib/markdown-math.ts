// On-demand KaTeX for transcript markdown.
//
// KaTeX (JS, fonts, and stylesheet) is only needed when a message contains
// `$` math delimiters, so it loads the first time such a message renders.
// Until it is ready the message renders without the math plugins (the TeX
// source shows as typed), then re-renders once KaTeX lands.

import remarkMath from "remark-math";
import type { Options } from "react-markdown";

type RemarkPlugin = NonNullable<Options["remarkPlugins"]>[number];
type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

export interface MarkdownMathPlugins {
  remark: RemarkPlugin;
  rehype: RehypePlugin;
}

let plugins: MarkdownMathPlugins | null = null;
let pending: Promise<boolean> | null = null;
let version = 0;
const listeners = new Set<() => void>();

/** remark-math only recognises `$` delimiters, so this is an exact pre-check. */
export function contentMayContainMath(content: string): boolean {
  return content.includes("$");
}

const loadKatexStylesheet = () => import("katex/dist/katex.min.css");

/**
 * Load rehype-katex and the KaTeX stylesheet once per renderer. Resolves
 * `false` when a chunk fails to load; a later message may retry.
 */
export function loadMarkdownMath(
  loadStylesheet: () => Promise<unknown> = loadKatexStylesheet,
): Promise<boolean> {
  if (plugins) return Promise.resolve(true);
  pending ??= Promise.all([import("rehype-katex"), loadStylesheet()]).then(
    ([rehypeKatex]) => {
      plugins = { remark: remarkMath, rehype: rehypeKatex.default };
      version += 1;
      for (const listener of listeners) listener();
      return true;
    },
    () => {
      pending = null;
      return false;
    },
  );
  return pending;
}

/** The math plugins once KaTeX has loaded, otherwise `null`. */
export function markdownMathPlugins(): MarkdownMathPlugins | null {
  return plugins;
}

export function subscribeMarkdownMath(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function markdownMathVersion(): number {
  return version;
}
