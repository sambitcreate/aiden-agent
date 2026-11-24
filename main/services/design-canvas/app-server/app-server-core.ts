/**
 * Pure rules for finding the web app design mode runs (spec §6.2.1–§6.2.3).
 *
 * Everything here takes parsed inputs (a package.json object, file names,
 * existence flags) and returns a classification or an argv. No disk, process
 * or Electron access: `app-detect.ts` reads the disk and feeds these rules.
 */

export type AppKind = "web" | "react-nonweb" | "none";
export type AppReason =
  | "ok"
  | "desktop"
  | "workspace-runner"
  | "react-native"
  | "no-dev-script"
  | "unknown-framework"
  | "no-web-framework"
  | "invalid-package-json";
export type FrameworkId =
  | "next"
  | "react-router"
  | "remix"
  | "remix-3"
  | "tanstack-start"
  | "nuxt"
  | "angular"
  | "astro"
  | "gatsby"
  | "create-react-app"
  | "tanstack-router"
  | "vite";
export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";
export type DesktopShell = "electron" | "tauri";

/** A parsed package.json: a plain JSON object, nothing else assumed. */
export type PackageJson = Record<string, unknown>;

export interface PackageManagerInfo {
  /** `null` on an unresolved conflict or an unsupported manager. */
  name: PackageManagerName | null;
  source: "packageManager" | "lockfile" | "installed" | "workspace-file" | "enclosing" | "none";
  /** The lockfile R5 chose, e.g. "pnpm-lock.yaml". */
  lockfile?: string;
  /** 0 inside the workspace; 1 or more for a signal found in an enclosing folder. */
  lockfileLevelsUp: number;
  conflict?: PackageManagerName[];
  unsupported?: "deno";
  yarn?: "classic" | "berry";
}

export interface DetectedApp {
  /** POSIX, relative to the workspace root: "." or "apps/web". */
  root: string;
  name?: string;
  kind: AppKind;
  reason: AppReason;
  desktopShell?: DesktopShell;
  framework?: FrameworkId;
  script?: string;
  /** Safe script names, at most 50. */
  scripts: string[];
  usesReact: boolean;
  packageManager: PackageManagerInfo;
  installRoot: string;
  installed: boolean;
}

export interface WebAppDetection {
  apps: DetectedApp[];
  truncated: boolean;
}

interface FrameworkSpec {
  id: FrameworkId;
  label: string;
  defaultPort: number;
  /** Dependency names; the first spec with any of them present wins. */
  packages: readonly string[];
  /** Word sequences that start this framework's dev server. */
  devCommands: readonly (readonly string[])[];
  /** Extra check on the dependency's version range. */
  accepts?: (range: string) => boolean;
}

/**
 * R2, in precedence order. Later entries also appear inside earlier
 * frameworks' apps (Remix, React Router, TanStack Start and SvelteKit list
 * `vite`), so order matters.
 */
export const FRAMEWORKS: readonly FrameworkSpec[] = [
  { id: "next", label: "Next.js", defaultPort: 3000, packages: ["next"], devCommands: [["next", "dev"]] },
  { id: "react-router", label: "React Router", defaultPort: 5173, packages: ["@react-router/dev"], devCommands: [["react-router", "dev"]] },
  { id: "remix", label: "Remix", defaultPort: 5173, packages: ["@remix-run/dev"], devCommands: [["remix", "vite:dev"], ["remix", "dev"]] },
  // Remix 3's starter runs `node --watch --import remix/node-tsx server.ts` on PORT or 44100.
  {
    id: "remix-3",
    label: "Remix",
    defaultPort: 44100,
    packages: ["remix"],
    devCommands: [["node", "--watch"]],
    accepts: (range) => (rangeMajor(range) ?? 0) >= 3,
  },
  { id: "tanstack-start", label: "TanStack Start", defaultPort: 3000, packages: ["@tanstack/react-start"], devCommands: [["vite"], ["vinxi", "dev"]] },
  { id: "tanstack-start", label: "TanStack Start", defaultPort: 3000, packages: ["@tanstack/start"], devCommands: [["vinxi", "dev"], ["vite"]] },
  { id: "nuxt", label: "Nuxt", defaultPort: 3000, packages: ["nuxt"], devCommands: [["nuxt", "dev"], ["nuxi", "dev"]] },
  { id: "angular", label: "Angular", defaultPort: 4200, packages: ["@angular/build", "@angular-devkit/build-angular"], devCommands: [["ng", "serve"]] },
  { id: "astro", label: "Astro", defaultPort: 4321, packages: ["astro"], devCommands: [["astro", "dev"]] },
  { id: "gatsby", label: "Gatsby", defaultPort: 8000, packages: ["gatsby"], devCommands: [["gatsby", "develop"]] },
  { id: "create-react-app", label: "Create React App", defaultPort: 3000, packages: ["react-scripts"], devCommands: [["react-scripts", "start"]] },
  { id: "tanstack-router", label: "Vite", defaultPort: 5173, packages: ["@tanstack/router-plugin"], devCommands: [["vite"]] },
  { id: "vite", label: "Vite", defaultPort: 5173, packages: ["vite"], devCommands: [["vite"]] },
];

/** The major version a range starts from: `^3`, `3.x`, `~3.0.0`, `>=3`. Tags and protocols give null. */
function rangeMajor(range: string): number | null {
  const match = /^\s*(?:\^|~|>=|>|=|v)?\s*(\d+)/u.exec(range);
  return match ? Number(match[1]) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePackageJson(text: string): PackageJson | null {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/u, ""));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** `dependencies` and `devDependencies`, never `peerDependencies`. */
function dependencies(pkg: PackageJson): Map<string, string> {
  const result = new Map<string, string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const group = pkg[field];
    if (!isRecord(group)) continue;
    for (const [name, range] of Object.entries(group)) {
      if (typeof range === "string" && !result.has(name)) result.set(name, range);
    }
  }
  return result;
}

export function detectFramework(pkg: PackageJson): FrameworkId | undefined {
  return frameworkSpec(dependencies(pkg))?.id;
}

function frameworkSpec(deps: Map<string, string>): FrameworkSpec | undefined {
  return FRAMEWORKS.find((spec) =>
    spec.packages.some((name) => {
      const range = deps.get(name);
      return range !== undefined && (spec.accepts?.(range) ?? true);
    }),
  );
}

// ---- scripts (R3) ----

const MAX_SCRIPT_NAME = 100;
const MAX_LISTED_SCRIPTS = 50;
const DEV_SCRIPT_NAMES = ["dev", "start", "serve"] as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

/** A name that can never be read as a manager option or break a terminal line. */
export function isSafeScriptName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SCRIPT_NAME && !CONTROL_CHARS.test(name) && !name.startsWith("-");
}

function stringScripts(pkg: PackageJson): Array<[string, string]> {
  const scripts = pkg.scripts;
  if (!isRecord(scripts)) return [];
  return Object.entries(scripts).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && isSafeScriptName(entry[0]),
  );
}

export function safeScriptNames(pkg: PackageJson): string[] {
  return stringScripts(pkg).slice(0, MAX_LISTED_SCRIPTS).map(([name]) => name);
}

/** Script text as shell words: quotes and operators become separators. */
function scriptWords(text: string): string[] {
  return text.split(/[\s"'`;&|()]+/u).filter(Boolean);
}

function hasSequence(words: readonly string[], sequence: readonly string[]): boolean {
  for (let i = 0; i + sequence.length <= words.length; i++) {
    if (sequence.every((word, offset) => words[i + offset] === word)) return true;
  }
  return false;
}

/** `vite`, `vite dev` or `vite serve`, never `vite build`, `vite preview` or `vite optimize`. */
function runsViteDev(words: readonly string[]): boolean {
  return words.some((word, i) => word === "vite" && !["build", "preview", "optimize"].includes(words[i + 1] ?? ""));
}

function runsDevCommand(words: readonly string[], spec: FrameworkSpec): boolean {
  return spec.devCommands.some((command) =>
    command.length === 1 && command[0] === "vite" ? runsViteDev(words) : hasSequence(words, command),
  );
}

const BUILD_SEQUENCES = [["vite", "build"], ["tsc"], ["tsup"], ["rollup"]];
const PRODUCTION_SEQUENCES = [
  ["next", "start"],
  ["vite", "preview"],
  ["astro", "preview"],
  ["gatsby", "serve"],
  ["remix-serve"],
  ["react-router-serve"],
  ["NODE_ENV=production"],
  ["serve", "-s"],
];
const RUNNER_SEQUENCES = [["turbo"], ["nx"], ["lerna"], ["pnpm", "-r"], ["pnpm", "--recursive"], ["yarn", "workspaces"]];

function isRunner(words: readonly string[]): boolean {
  return (
    RUNNER_SEQUENCES.some((sequence) => hasSequence(words, sequence)) ||
    words.some((word) => word === "--filter" || word.startsWith("--filter=") || word === "--workspaces" || word.startsWith("--workspaces="))
  );
}

function isSkipped(words: readonly string[]): boolean {
  const build =
    BUILD_SEQUENCES.some((sequence) => hasSequence(words, sequence)) ||
    (hasSequence(words, ["next", "build"]) && !hasSequence(words, ["next", "dev"]));
  return (
    build ||
    PRODUCTION_SEQUENCES.some((sequence) => hasSequence(words, sequence)) ||
    words.includes("storybook") ||
    isRunner(words)
  );
}

export interface DevScriptChoice {
  script: string | undefined;
  /** A dev, start or serve string script existed. */
  hadDevScript: boolean;
  /** One of them was passed over as a workspace runner. */
  skippedRunner: boolean;
}

/**
 * R3: `dev`, `start`, `serve`. The first that runs the framework's dev
 * command wins; otherwise the first that isn't a build, a production run,
 * Storybook or a workspace runner.
 */
export function pickDevScript(pkg: PackageJson, framework: FrameworkId | undefined): DevScriptChoice {
  const scripts = new Map(stringScripts(pkg));
  const present = DEV_SCRIPT_NAMES.flatMap((name) => {
    const text = scripts.get(name);
    return text === undefined ? [] : [{ name, words: scriptWords(text) }];
  });
  const specs = framework ? FRAMEWORKS.filter((spec) => spec.id === framework) : [];
  const preferred = present.find(({ words }) => specs.some((spec) => runsDevCommand(words, spec)));
  const usable = preferred ?? present.find(({ words }) => !isSkipped(words));
  return {
    script: usable?.name,
    hadDevScript: present.length > 0,
    skippedRunner: present.some(({ words }) => isRunner(words)),
  };
}

// ---- kind (R4) ----

export interface PackageClassification {
  kind: AppKind;
  reason: AppReason;
  desktopShell?: DesktopShell;
  framework?: FrameworkId;
  script?: string;
  usesReact: boolean;
}

function desktopShellOf(deps: Map<string, string>): DesktopShell | undefined {
  if (deps.has("electron")) return "electron";
  if (deps.has("@tauri-apps/api") || deps.has("@tauri-apps/cli")) return "tauri";
  return undefined;
}

function usesStorybook(deps: Map<string, string>): boolean {
  return [...deps.keys()].some((name) => name === "storybook" || name.startsWith("@storybook/"));
}

/** R4, in order. `null` is a package.json that couldn't be read or parsed. */
export function classifyPackage(pkg: PackageJson | null, markers: { workspaceRunnerFile: boolean }): PackageClassification {
  if (!pkg) return { kind: "none", reason: "invalid-package-json", usesReact: false };
  const deps = dependencies(pkg);
  const usesReact = deps.has("react") || deps.has("react-dom");
  const framework = frameworkSpec(deps)?.id;
  const choice = pickDevScript(pkg, framework);
  const result = (kind: AppKind, reason: AppReason, desktopShell?: DesktopShell): PackageClassification => ({
    kind,
    reason,
    ...(desktopShell ? { desktopShell } : {}),
    ...(framework ? { framework } : {}),
    ...(choice.script ? { script: choice.script } : {}),
    usesReact,
  });

  const shell = desktopShellOf(deps);
  if (shell) return result(usesReact ? "react-nonweb" : "none", "desktop", shell);
  if (framework && choice.script) return result("web", "ok");
  if (choice.skippedRunner || markers.workspaceRunnerFile) return result("none", "workspace-runner");
  if (deps.has("react-native") || deps.has("expo")) return result("react-nonweb", "react-native");
  if (framework && !choice.hadDevScript && !usesStorybook(deps)) return result("none", "no-dev-script");
  if (choice.script && !framework) return result("none", "unknown-framework");
  if (usesReact) return result("react-nonweb", "no-web-framework");
  return result("none", "no-web-framework");
}
