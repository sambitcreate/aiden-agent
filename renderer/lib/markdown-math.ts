// On-demand KaTeX for transcript markdown.
//
// KaTeX (JS, fonts, and stylesheet) is only needed when a message contains
// `$` math delimiters, so it loads the first time such a message renders.
// Until it is ready the message renders without the math plugins (the TeX
// source shows as typed), then re-renders once KaTeX lands.

import remarkMath from "remark-math";
import type { Element, ElementContent, Root, RootContent } from "hast";
import type { Options } from "react-markdown";
import type { VFile } from "vfile";

type RemarkPlugin = NonNullable<Options["remarkPlugins"]>[number];
type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];
type RehypeTransform = (tree: Root, file: VFile) => void;

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
      plugins = {
        remark: remarkMath,
        rehype: cachedRehypeMath(rehypeKatex.default as () => RehypeTransform),
      };
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

/** Typeset formulas kept across parses; enough for several long math replies. */
export const TYPESET_FORMULA_CACHE_LIMIT = 500;
const typesetFormulas = new Map<string, ElementContent[]>();

function classesOf(node: Element): unknown[] {
  return Array.isArray(node.properties.className) ? node.properties.className : [];
}

function isMathElement(node: Element): boolean {
  const classes = classesOf(node);
  return (
    classes.includes("language-math") ||
    classes.includes("math-display") ||
    classes.includes("math-inline")
  );
}

/**
 * The node rehype-katex replaces for a formula: the element carrying a math
 * class, or the `<pre>` around a math `<code>` (fenced and `$$` math).
 */
function mathScope(node: Element): boolean {
  if (isMathElement(node)) return true;
  return (
    node.tagName === "pre" &&
    node.children.some(
      (child) =>
        child.type === "element" &&
        child.tagName === "code" &&
        classesOf(child).includes("language-math"),
    )
  );
}

/** The scope without source positions, so the same formula anywhere matches. */
function formulaKey(scope: Element): string {
  return JSON.stringify(scope, (key, value: unknown) => (key === "position" ? undefined : value));
}

/** The last formula in document order: the one a streaming reply may still be writing. */
function lastMathScope(parent: Root | Element): Element | undefined {
  for (let index = parent.children.length - 1; index >= 0; index -= 1) {
    const child = parent.children[index] as RootContent;
    if (child.type !== "element") continue;
    if (mathScope(child)) return child;
    const nested = lastMathScope(child);
    if (nested) return nested;
  }
  return undefined;
}

export interface CachedMathOptions {
  /** The reply is still arriving, so its trailing formula may be a partial prefix. */
  streaming?: boolean;
}

/**
 * Streaming re-parses the whole reply at every release, and rehype-katex
 * typesets every formula in the tree each time. This runs rehype-katex once per
 * distinct formula and reuses the typeset nodes for later parses, so settled
 * formulas cost a lookup instead of a KaTeX render. While a reply streams, its
 * trailing formula (an open `$$` block grows with every release) is typeset
 * without being stored, so its prefixes cannot evict settled formulas.
 */
function cachedRehypeMath(rehypeKatex: () => RehypeTransform): RehypePlugin {
  return function rehypeCachedKatex(options?: CachedMathOptions) {
    const typeset = rehypeKatex();
    const render = (scope: Element, file: VFile, store: boolean): ElementContent[] => {
      const key = formulaKey(scope);
      let nodes = typesetFormulas.get(key);
      if (nodes) {
        // Refresh its place in the LRU order.
        typesetFormulas.delete(key);
        typesetFormulas.set(key, nodes);
      } else {
        const fragment: Root = { type: "root", children: [scope] };
        typeset(fragment, file);
        nodes = fragment.children as ElementContent[];
        if (store) {
          if (typesetFormulas.size >= TYPESET_FORMULA_CACHE_LIMIT) {
            typesetFormulas.delete(typesetFormulas.keys().next().value!);
          }
          typesetFormulas.set(key, nodes);
        }
      }
      // Later stages may rewrite properties, so each tree gets its own copy.
      return structuredClone(nodes);
    };
    const walk = (parent: Root | Element, file: VFile, unsettled: Element | undefined) => {
      for (let index = 0; index < parent.children.length; index += 1) {
        const child = parent.children[index] as RootContent;
        if (child.type !== "element") continue;
        if (!mathScope(child)) {
          walk(child, file, unsettled);
          continue;
        }
        const typesetNodes = render(child, file, child !== unsettled);
        parent.children.splice(index, 1, ...typesetNodes);
        index += typesetNodes.length - 1;
      }
    };
    return (tree: Root, file: VFile) =>
      walk(tree, file, options?.streaming ? lastMathScope(tree) : undefined);
  } as RehypePlugin;
}
