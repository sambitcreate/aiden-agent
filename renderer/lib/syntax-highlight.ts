// Lazy syntax highlighting for transcript code blocks.
//
// The full highlight.js build registers ~190 grammars (~900 KB minified) and
// its auto-detection runs every grammar over the text. Chat code blocks only
// need a handful of common languages, so the core and each grammar load on
// demand the first time a fence names them. Unlabeled or unknown fences stay
// plain text: there is no auto-detection.

import type { HLJSApi, LanguageFn } from "highlight.js";

type GrammarModule = { default: LanguageFn };

const GRAMMARS: Record<string, () => Promise<GrammarModule>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  elixir: () => import("highlight.js/lib/languages/elixir"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  haskell: () => import("highlight.js/lib/languages/haskell"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  protobuf: () => import("highlight.js/lib/languages/protobuf"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

// Grammars that embed another grammar (shell sessions highlight their commands
// as bash; HTML highlights inline <script>/<style>).
const EMBEDDED: Record<string, readonly string[]> = {
  shell: ["bash"],
  xml: ["javascript", "css"],
  markdown: ["xml"],
  php: ["xml"],
};

// Fence labels models commonly use, mapped onto the grammar that the full
// highlight.js build would have resolved them to.
const ALIASES: Record<string, string> = {
  atom: "xml",
  "c++": "cpp",
  "c#": "csharp",
  cc: "cpp",
  cjs: "javascript",
  console: "shell",
  cs: "csharp",
  cts: "typescript",
  cxx: "cpp",
  docker: "dockerfile",
  ex: "elixir",
  exs: "elixir",
  gemspec: "ruby",
  golang: "go",
  gql: "graphql",
  h: "c",
  hh: "cpp",
  hpp: "cpp",
  hs: "haskell",
  html: "xml",
  hxx: "cpp",
  js: "javascript",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  make: "makefile",
  md: "markdown",
  mjs: "javascript",
  mk: "makefile",
  mkdown: "markdown",
  mm: "objectivec",
  mts: "typescript",
  objc: "objectivec",
  patch: "diff",
  pl: "perl",
  plist: "xml",
  pm: "perl",
  proto: "protobuf",
  ps: "powershell",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  rss: "xml",
  sh: "bash",
  shellsession: "shell",
  svg: "xml",
  text: "plaintext",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xhtml: "xml",
  yml: "yaml",
  zsh: "bash",
};

/** Map a fence label to a supported grammar name, or `undefined` for plain text. */
export function resolveHighlightLanguage(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const normalized = label.trim().toLowerCase();
  const language = ALIASES[normalized] ?? normalized;
  return Object.prototype.hasOwnProperty.call(GRAMMARS, language) ? language : undefined;
}

let core: HLJSApi | undefined;
let corePromise: Promise<HLJSApi> | undefined;
const registered = new Set<string>();
const pending = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
let version = 0;

function loadCore(): Promise<HLJSApi> {
  corePromise ??= import("highlight.js/lib/core").then((module) => {
    core = module.default;
    return core;
  });
  return corePromise;
}

async function register(language: string): Promise<void> {
  const embedded = EMBEDDED[language] ?? [];
  const [hljs, grammar] = await Promise.all([
    loadCore(),
    GRAMMARS[language]!(),
    ...embedded.map((name) => loadHighlightLanguage(name)),
  ]);
  if (!registered.has(language)) {
    hljs.registerLanguage(language, grammar.default);
    registered.add(language);
  }
}

/**
 * Load the grammar a fence label names (once per renderer). Resolves `false`
 * for labels that render as plain text or when the chunk fails to load.
 */
export function loadHighlightLanguage(label: string | undefined): Promise<boolean> {
  const language = resolveHighlightLanguage(label);
  if (!language) return Promise.resolve(false);
  if (registered.has(language)) return Promise.resolve(true);
  let promise = pending.get(language);
  if (!promise) {
    promise = register(language).then(
      () => {
        version += 1;
        for (const listener of listeners) listener();
        return true;
      },
      () => {
        // A failed chunk load stays plain text; a later block may retry.
        pending.delete(language);
        return false;
      },
    );
    pending.set(language, promise);
  }
  return promise;
}

/**
 * Highlight with an already-loaded grammar. Returns `null` (render plain text)
 * when the label is unsupported or its grammar has not loaded yet.
 */
export function highlightCode(code: string, label: string | undefined): string | null {
  const language = resolveHighlightLanguage(label);
  if (!language || !core || !registered.has(language)) return null;
  try {
    return core.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** `useSyncExternalStore` hooks: the version changes whenever a grammar loads. */
export function subscribeHighlightLanguages(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function highlightLanguagesVersion(): number {
  return version;
}
