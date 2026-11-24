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
  /** The packageManager field's manager, when the field is part of `conflict`. */
  field?: PackageManagerName;
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
const RUNNER_SEQUENCES = [
  ["turbo"],
  ["nx"],
  ["lerna"],
  ["pnpm", "-r"],
  ["pnpm", "--recursive"],
  ["pnpm", "-C"],
  ["yarn", "workspaces"],
  ["yarn", "workspace"],
  ["concurrently"],
  ["npm-run-all"],
  ["run-p"],
];
const PACKAGE_MANAGER_WORDS = ["npm", "pnpm", "yarn", "bun"];
/** Flags that point a package manager at one member. Other tools use some of them too (`tsc -w`), so they count only next to a manager. */
const MEMBER_FLAGS = ["-w", "--workspace", "--prefix", "--dir"];

function flagIn(words: readonly string[], flags: readonly string[]): boolean {
  return words.some((word) => flags.some((flag) => word === flag || word.startsWith(`${flag}=`)));
}

function isRunner(words: readonly string[]): boolean {
  return (
    RUNNER_SEQUENCES.some((sequence) => hasSequence(words, sequence)) ||
    flagIn(words, ["--filter", "--workspaces"]) ||
    (words.some((word) => PACKAGE_MANAGER_WORDS.includes(word)) && flagIn(words, MEMBER_FLAGS))
  );
}

type SkipKind = "runner" | "storybook" | "production" | "build";

/** Why R3 passes a script over, or null when it is usable. A production run that also builds counts as a production run. */
function skipKind(words: readonly string[]): SkipKind | null {
  if (isRunner(words)) return "runner";
  if (words.includes("storybook")) return "storybook";
  if (PRODUCTION_SEQUENCES.some((sequence) => hasSequence(words, sequence))) return "production";
  if (
    BUILD_SEQUENCES.some((sequence) => hasSequence(words, sequence)) ||
    (hasSequence(words, ["next", "build"]) && !hasSequence(words, ["next", "dev"]))
  ) {
    return "build";
  }
  return null;
}

export interface DevScriptChoice {
  script: string | undefined;
  /** A dev, start or serve string script existed. */
  hadDevScript: boolean;
  /** One of them was passed over as a workspace runner. */
  skippedRunner: boolean;
}

interface DevScriptScan extends DevScriptChoice {
  /** Every dev, start or serve script was passed over as a production run. */
  onlyProductionRuns: boolean;
}

function scanDevScripts(pkg: PackageJson, framework: FrameworkId | undefined, workspaceRoot: boolean): DevScriptScan {
  const scripts = new Map(stringScripts(pkg));
  const present = DEV_SCRIPT_NAMES.flatMap((name) => {
    const text = scripts.get(name);
    return text === undefined ? [] : [{ name, skip: skipKind(scriptWords(text)), words: scriptWords(text) }];
  });
  const specs = framework ? FRAMEWORKS.filter((spec) => spec.id === framework) : [];
  const preferred = present.find(({ words }) => specs.some((spec) => runsDevCommand(words, spec)));
  const fallback = present.find(({ skip }) => skip === null);
  // A workspace root's other scripts reach its apps some other way, so they hand off to a member.
  const handsOff = workspaceRoot && !preferred && fallback !== undefined;
  return {
    script: (preferred ?? (workspaceRoot ? undefined : fallback))?.name,
    hadDevScript: present.length > 0,
    skippedRunner: handsOff || present.some(({ skip }) => skip === "runner"),
    onlyProductionRuns: present.length > 0 && present.every(({ skip }) => skip === "production"),
  };
}

/**
 * R3: `dev`, `start`, `serve`. The first that runs the framework's dev
 * command wins; otherwise the first that isn't a build, a production run,
 * Storybook or a workspace runner.
 */
export function pickDevScript(pkg: PackageJson, framework: FrameworkId | undefined): DevScriptChoice {
  const { script, hadDevScript, skippedRunner } = scanDevScripts(pkg, framework, false);
  return { script, hadDevScript, skippedRunner };
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

/**
 * R4, in order. `null` is a package.json that couldn't be read or parsed.
 * `workspaceRoot` is a root that declares workspaces: it is `web` only when
 * its script runs the framework's own dev command.
 */
export function classifyPackage(
  pkg: PackageJson | null,
  markers: { workspaceRunnerFile: boolean; workspaceRoot?: boolean },
): PackageClassification {
  if (!pkg) return { kind: "none", reason: "invalid-package-json", usesReact: false };
  const deps = dependencies(pkg);
  const usesReact = deps.has("react") || deps.has("react-dom");
  const framework = frameworkSpec(deps)?.id;
  const choice = scanDevScripts(pkg, framework, markers.workspaceRoot === true);
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
  if (framework && !choice.script && (!choice.hadDevScript || choice.onlyProductionRuns) && !usesStorybook(deps)) {
    return result("none", "no-dev-script");
  }
  if (choice.script && !framework) return result("none", "unknown-framework");
  if (usesReact) return result("react-nonweb", "no-web-framework");
  return result("none", "no-web-framework");
}

// ---- package managers (R5) ----

const PACKAGE_MANAGERS: readonly PackageManagerName[] = ["npm", "pnpm", "yarn", "bun"];

function isPackageManagerName(value: string): value is PackageManagerName {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/** Lockfile names, in the order a manager's own files are preferred. */
export const LOCKFILES: ReadonlyArray<readonly [string, PackageManagerName]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["npm-shrinkwrap.json", "npm"],
  ["package-lock.json", "npm"],
];

/** Files a manager leaves inside `node_modules` after an install. */
export const INSTALL_MARKERS: ReadonlyArray<readonly [string, PackageManagerName]> = [
  [".package-lock.json", "npm"],
  [".modules.yaml", "pnpm"],
  [".yarn-integrity", "yarn"],
  [".yarn-state.yml", "yarn"],
];

export const DENO_MARKERS: readonly string[] = ["deno.lock", "deno.json", "deno.jsonc"];

/** `"pnpm@9.15.0+sha512…"` → `{ name: "pnpm", major: 9 }`. Anything but npm, pnpm, yarn or bun is ignored. */
export function parsePackageManagerField(value: unknown): { name: PackageManagerName; major?: number } | null {
  if (typeof value !== "string") return null;
  const match = /^([a-z]+)(?:@(\d+))?/u.exec(value.trim());
  if (!match || !isPackageManagerName(match[1])) return null;
  return match[2] === undefined ? { name: match[1] } : { name: match[1], major: Number(match[2]) };
}

export function lockfileManagers(fileNames: readonly string[]): Map<PackageManagerName, string> {
  const present = new Set(fileNames);
  const result = new Map<PackageManagerName, string>();
  for (const [file, manager] of LOCKFILES) {
    if (present.has(file) && !result.has(manager)) result.set(manager, file);
  }
  return result;
}

export function installedMarkerManagers(fileNames: readonly string[]): Set<PackageManagerName> {
  const present = new Set(fileNames);
  return new Set(INSTALL_MARKERS.filter(([file]) => present.has(file)).map(([, manager]) => manager));
}

export interface PackageManagerSignals {
  field: { name: PackageManagerName; major?: number } | null;
  /** Lockfiles in the folder the signals came from. */
  lockfiles: Map<PackageManagerName, string>;
  /** Managers with an install marker in that folder's `node_modules`. */
  installedMarkers: Set<PackageManagerName>;
  pnpmWorkspaceFile: boolean;
  denoMarker: boolean;
  /** From the folder holding the yarn signal. `lockHead` is at most the first 512 bytes of `yarn.lock`. */
  yarnFlavourHints: { yarnrc: boolean; pnp: boolean; lockHead: string | null };
  /** 0 for the install root; 1 or more when the signals came from an enclosing folder. */
  levelsUp: number;
}

function yarnFlavour(signals: PackageManagerSignals): "classic" | "berry" {
  const { field, yarnFlavourHints: hints } = signals;
  if (field?.name === "yarn" && field.major !== undefined) return field.major >= 2 ? "berry" : "classic";
  return hints.yarnrc || hints.pnp || (hints.lockHead ?? "").includes("__metadata:") ? "berry" : "classic";
}

/** R5. Disk-free: the caller gathers the signals of one folder. */
export function decidePackageManager(signals: PackageManagerSignals): PackageManagerInfo {
  const enclosing = signals.levelsUp > 0;
  const levelsUp = signals.levelsUp;
  const pick = (name: PackageManagerName, source: PackageManagerInfo["source"], conflict?: PackageManagerName[]): PackageManagerInfo => {
    const lockfile = signals.lockfiles.get(name);
    return {
      name,
      source,
      ...(lockfile ? { lockfile } : {}),
      lockfileLevelsUp: levelsUp,
      ...(conflict ? { conflict } : {}),
      ...(name === "yarn" ? { yarn: yarnFlavour(signals) } : {}),
    };
  };
  const settle = (conflict: PackageManagerName[], source: PackageManagerInfo["source"], field?: PackageManagerName): PackageManagerInfo => {
    const installed = conflict.filter((name) => signals.installedMarkers.has(name));
    if (installed.length === 1) return pick(installed[0], "installed", conflict);
    return { name: null, source, lockfileLevelsUp: levelsUp, conflict, ...(field ? { field } : {}) };
  };
  const locked = [...signals.lockfiles.keys()].sort();
  const lockSource = enclosing ? "enclosing" : "lockfile";

  if (signals.field) {
    const field = signals.field.name;
    if (locked.every((name) => name === field)) return pick(field, "packageManager");
    return settle([...new Set([...locked, field])].sort(), "packageManager", field);
  }
  if (locked.length === 1) return pick(locked[0], lockSource);
  if (locked.length > 1) return settle(locked, lockSource);
  if (signals.pnpmWorkspaceFile) return pick("pnpm", enclosing ? "enclosing" : "workspace-file");
  if (signals.denoMarker) return { name: null, source: "none", lockfileLevelsUp: 0, unsupported: "deno" };
  return { name: "npm", source: "none", lockfileLevelsUp: 0 };
}

// ---- commands (R10) ----

export interface ManagerCommand {
  command: PackageManagerName;
  args: string[];
}

function requireManager(info: PackageManagerInfo): PackageManagerName {
  if (info.name === null) throw new Error("This app has no package manager to run.");
  return info.name;
}

/** The frozen install when R5 chose a lockfile (an enclosing one included), else a plain install. */
export function installCommand(info: PackageManagerInfo): ManagerCommand {
  const name = requireManager(info);
  if (!info.lockfile) return { command: name, args: ["install"] };
  if (name === "npm") return { command: name, args: ["ci"] };
  if (name === "yarn" && info.yarn === "berry") return { command: name, args: ["install", "--immutable"] };
  return { command: name, args: ["install", "--frozen-lockfile"] };
}

/**
 * `<manager> run <script> <extra…>`. Only npm needs `--` to hand options to
 * the script; pnpm and Yarn 2+ would pass a bare `--` through to it.
 */
export function runScriptCommand(info: PackageManagerInfo, script: string, extraArgs: readonly string[] = []): ManagerCommand {
  const name = requireManager(info);
  if (!isSafeScriptName(script)) throw new Error("That script name can't be run.");
  if (extraArgs.some((arg) => CONTROL_CHARS.test(arg))) throw new Error("A script argument has a control character.");
  const extra = name === "npm" && extraArgs.length > 0 ? ["--", ...extraArgs] : [...extraArgs];
  return { command: name, args: ["run", script, ...extra] };
}

// ---- workspace patterns (R1) ----

function patternList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (isRecord(value) && Array.isArray(value.packages)) return patternList(value.packages);
  return [];
}

function normalisePattern(raw: string): string | null {
  let pattern = raw.trim();
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  pattern = pattern.replace(/\/+$/u, "");
  if (!pattern || pattern.startsWith("/") || /^[a-zA-Z]:/u.test(pattern) || pattern.includes("\\")) return null;
  if (pattern.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) return null;
  return pattern;
}

/** The root's declared workspace patterns: package.json `workspaces` and pnpm-workspace.yaml `packages`. */
export function workspacePatterns(rootPkg: PackageJson | null, pnpmWorkspaceYaml: unknown): { include: string[]; exclude: string[] } {
  const include = new Set<string>();
  const exclude = new Set<string>();
  const raw = [
    ...(rootPkg ? patternList(rootPkg.workspaces) : []),
    ...(isRecord(pnpmWorkspaceYaml) ? patternList(pnpmWorkspaceYaml.packages) : []),
  ];
  for (const entry of raw) {
    const negated = entry.trim().startsWith("!");
    const pattern = normalisePattern(negated ? entry.trim().slice(1) : entry);
    if (pattern) (negated ? exclude : include).add(pattern);
  }
  return { include: [...include], exclude: [...exclude] };
}

export interface WorkspacePatternShape {
  /** Literal parent segments. */
  parent: string[];
  /** The last segment; may hold `*`. */
  last: string;
  wildcard: boolean;
}

/**
 * The supported forms: up to three segments, literal except the last, which
 * may hold `*` (`**` counts as `*`). Braces and deeper wildcards give null.
 */
export function parseWorkspacePattern(pattern: string): WorkspacePatternShape | null {
  const segments = pattern.split("/");
  if (segments.length === 0 || segments.length > 3 || /[{}]/u.test(pattern)) return null;
  const parent = segments.slice(0, -1);
  if (parent.some((segment) => segment.includes("*") || segment === "")) return null;
  const last = segments[segments.length - 1].replace(/\*+/gu, "*");
  if (!last) return null;
  return { parent, last, wildcard: last.includes("*") };
}

function matchesSegment(name: string, glob: string): boolean {
  const pieces = glob.split("*");
  if (pieces.length === 1) return name === glob;
  const [first, ...rest] = pieces;
  if (!name.startsWith(first)) return false;
  let at = first.length;
  for (let i = 0; i < rest.length; i++) {
    const piece = rest[i];
    if (i === rest.length - 1) return name.length - piece.length >= at && name.endsWith(piece);
    const found = name.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return true;
}

export function matchesWorkspacePattern(relPath: string, pattern: string): boolean {
  const shape = parseWorkspacePattern(pattern);
  if (!shape) return false;
  const segments = relPath.split("/");
  if (segments.length !== shape.parent.length + 1) return false;
  if (!shape.parent.every((segment, i) => segments[i] === segment)) return false;
  return matchesSegment(segments[segments.length - 1], shape.last);
}

// ---- design target (R8) ----

export type DesignTarget =
  | { kind: "single"; app: DetectedApp }
  | { kind: "choose"; apps: DetectedApp[] }
  | { kind: "react-nonweb"; apps: DetectedApp[] }
  | { kind: "none"; apps: DetectedApp[] };

/**
 * What design mode does with a detection: start the one web app, ask which
 * web apps, offer React mocks, or nothing. A web app with no package manager
 * is still web, so 2b can say why it won't start it.
 */
export function designTarget(detection: WebAppDetection): DesignTarget {
  const web = detection.apps.filter((candidate) => candidate.kind === "web");
  if (web.length === 1) return { kind: "single", app: web[0] };
  if (web.length > 1) return { kind: "choose", apps: web };
  const nonWeb = detection.apps.filter((candidate) => candidate.kind === "react-nonweb");
  if (nonWeb.length > 0) return { kind: "react-nonweb", apps: nonWeb };
  return { kind: "none", apps: [...detection.apps] };
}
