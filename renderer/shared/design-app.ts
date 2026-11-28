// Design mode's live apps: the status, problem and consent contract shared by
// main and the renderer (spec §6.2, plan 2b). Main owns the dev-server
// processes; 2c's status chip and 3a's app frames read only these types, so
// they never import a main module. No Electron or Node imports here.

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

/** Every framework detection knows, for the analytics enum. */
export const FRAMEWORK_IDS: readonly FrameworkId[] = Object.freeze([
  "next",
  "react-router",
  "remix",
  "remix-3",
  "tanstack-start",
  "nuxt",
  "angular",
  "astro",
  "gatsby",
  "create-react-app",
  "tanstack-router",
  "vite",
]);

export const DESIGN_NODE_MIN_MAJOR = 22;

export type DesignAppPhase = "stopped" | "consent" | "installing" | "starting" | "running" | "crashed";

export type ToolchainProblem =
  | { problem: "node-missing" }
  | { problem: "manager-missing"; manager: PackageManagerName }
  | { problem: "manager-conflict"; conflict: PackageManagerName[]; field?: PackageManagerName }
  | { problem: "unsupported-manager"; manager: "deno" };

export type DesignAppProblem =
  /** The platform or the flag. */
  | { problem: "unavailable" }
  | { problem: "no-access" }
  | { problem: "interrupted" }
  | { problem: "desktop-only" }
  | { problem: "recovery-failed" }
  | ToolchainProblem
  /** Relative to the workspace, at most 200 characters. */
  | { problem: "launch-file-unreadable"; file: string }
  | { problem: "script-too-long" }
  | { problem: "consent-declined" }
  | { problem: "consent-unanswered" }
  | { problem: "consent-unavailable" }
  /** Allow on a choose card, but .aiden/canvas.json couldn't take the choice, so nothing ran. */
  | { problem: "choice-not-saved" }
  | { problem: "job-limit" }
  | { problem: "install-outside-workspace" }
  | { problem: "install-failed"; exitCode: number | null; tail: string }
  | { problem: "install-timeout" }
  | { problem: "not-ready"; tail: string }
  | { problem: "exposed" }
  | { problem: "exposure-unknown" }
  | { problem: "not-web" }
  // 2c's Connect running server, defined now so 2c adds no type:
  | { problem: "attach-not-loopback" }
  | { problem: "attach-unreachable" }
  | { problem: "attach-not-in-app" }
  /**
   * 2c: a server is already live for this root. Without `started`, design mode is
   * connected to a server it didn't start (D1); with it, Aiden runs this app.
   */
  | { problem: "already-running"; started?: true }
  /** 2c: `.aiden/canvas.json`'s `apps[].url` for this root isn't a loopback http origin. */
  | { problem: "attach-url-invalid" }
  /** 3d (S103): this workspace gets no design app, for this reason. */
  | { problem: "scaffold-refused"; why: MockRefusal }
  /** 3d (S107): writing the design app failed at this step, and what Aiden wrote was rolled back. */
  | { problem: "scaffold-failed"; step: "template" | "write" | "verify" | "design-md" };

// ---- 3d: mock apps (S102–S116) ----

export type DesignMockKind = "react-nonweb" | "starter";

/** Why a workspace gets no design app (S103, S104). */
export type MockRefusal =
  | "has-web-app"
  | "workspace-runner"
  | "unknown-framework"
  | "no-dev-script"
  | "invalid-package-json"
  | "truncated"
  | "unsupported-config"
  | "no-free-folder"
  | "in-workspaces"
  | "read-only";

export const MOCK_REFUSALS: readonly MockRefusal[] = Object.freeze([
  "has-web-app",
  "workspace-runner",
  "unknown-framework",
  "no-dev-script",
  "invalid-package-json",
  "truncated",
  "unsupported-config",
  "no-free-folder",
  "in-workspaces",
  "read-only",
]);

/** What design mode can do for a workspace with no web app (S103). */
export type DesignMockOffer =
  | { offer: "react-nonweb"; folder: string; source: string; shell?: "electron" | "tauri"; reactNative?: true }
  | { offer: "starter"; folder: string }
  | { offer: "existing"; folder: string }
  | { offer: "refused"; why: MockRefusal; folder?: string };

/** The snapshot's `mock` field: the offer, plus a toolchain problem the last scaffold hit. */
export type DesignMockState = DesignMockOffer & { problem?: ToolchainProblem };

export interface DesignAppStatus {
  workspaceId: string;
  /** POSIX, relative, "." for the workspace root. */
  appRoot: string;
  /** "attached": a server the person runs, which Aiden never starts, stops or signals (2c). */
  source: "started" | "attached";
  /** 2c: an `apps[].url` root's url from `.aiden/canvas.json`, as display text. The real origin comes from sockets. */
  url?: string;
  framework?: FrameworkId;
  /** "Vite", or "App" with no framework. */
  frameworkLabel: string;
  manager?: PackageManagerName;
  script?: string;
  phase: DesignAppPhase;
  since: number;
  /** "http://127.0.0.1:5173", only while running. */
  origin?: string;
  /** Only while running. */
  port?: number;
  startedBy?: "person" | "aiden";
  /** Crashed. */
  exitCode?: number | null;
  /** Crashed. */
  signal?: string;
  /** Crashed: at most 2 000 characters of the server's own output. Untrusted text. */
  tail?: string;
  problem?: DesignAppProblem;
  /** 3d: a design app (its package.json carries Aiden's marker, S104). A label only; nothing trusts it. */
  mock?: true;
  revision: number;
}

export interface DesignAppCandidate {
  appRoot: string;
  framework?: FrameworkId;
  frameworkLabel: string;
  script?: string;
  name?: string;
  /** 3d: a design app (S104). */
  mock?: true;
}

export interface DesignAppsSnapshot {
  workspaceId: string;
  target: "single" | "choose" | "react-nonweb" | "none" | "unavailable";
  /** Every known server, plus the target apps at "stopped". */
  apps: DesignAppStatus[];
  /** Web candidates, for Choose apps. */
  candidates: DesignAppCandidate[];
  /** Roots `.aiden/canvas.json` describes with a script. */
  chosen: string[];
  /** 3d: with the flag on and no web app, what a design app would be (S112). Absent otherwise. */
  mock?: DesignMockState;
}

export type DesignAppConsentRequest =
  | {
      kind: "launch";
      requestId: string;
      chatId: string;
      workspaceId: string;
      appRoot: string;
      packageName?: string;
      frameworkLabel: string;
      reason: "first" | "changed" | "install" | "choose";
      /** Display text: "pnpm run dev". */
      runCommand: string;
      /** Only when an install will run. */
      installCommand?: string;
      scripts: Array<{ name: string; text: string }>;
      /** The hashed rc, workspace and config file names present; never their contents. */
      launchFiles: string[];
      /** Reason "choose": Allow writes the choice to .aiden/canvas.json. */
      savesChoice: boolean;
    }
  /** 2c: an `apps[].url` root asks before Aiden connects to the person's server (S15). */
  | {
      kind: "attach";
      requestId: string;
      chatId: string;
      workspaceId: string;
      appRoot: string;
      /** The canonical origin Aiden will register: "http://127.0.0.1:4321" or "http://[::1]:4321". */
      url: string;
      /** What .aiden/canvas.json says, as written; untrusted text. */
      configUrl: string;
      /** The holder's process name (ps comm, at most 64 characters); untrusted text. */
      processName: string;
      /** The holder's folder relative to the workspace, POSIX, at most 200 characters. */
      folder: string;
    }
  /**
   * 3d (S102): add a design app. One card per workspace; its Allow is both the
   * person's yes and the launch consent, so no launch card follows.
   */
  | {
      kind: "scaffold";
      requestId: string;
      chatId: string;
      workspaceId: string;
      /** "design-app" or "design-app-2" … "design-app-9". */
      folder: string;
      mockKind: DesignMockKind;
      /** "Electron", "Tauri" or "React Native" for react-nonweb. */
      shellLabel?: string;
      installCommand: "npm ci";
      runCommand: "npm run dev";
      scripts: Array<{ name: "dev"; text: string }>;
      /** Direct dependencies with exact versions, from the template. */
      packages: Array<{ name: string; version: string }>;
      /** Paths relative to the folder, sorted; the card shows at most 40, then "and N more". */
      files: readonly string[];
    };

/** One row of Connect running server… (2c D6). */
export interface DesignAppRunningServer {
  port: number;
  pid: number;
  /** "http://127.0.0.1:5173" or "http://[::1]:5173"; only when connectable. */
  origin?: string;
  /** The deepest app root holding the process's folder, or that folder itself. */
  appRoot: string;
  /** The process's folder relative to the workspace, POSIX, at most 200 characters. Untrusted text. */
  folder: string;
  /** At most 64 characters. Untrusted text. */
  processName: string;
  connectable: boolean;
  why?: "beyond-loopback" | "other-address" | "other-user" | "already-running";
}

export interface DesignAppRunningScan {
  workspaceId: string;
  ok: boolean;
  /** Part of the process table couldn't be read, so some servers may be missing. */
  incomplete: boolean;
  servers: DesignAppRunningServer[];
}

export interface DesignAppConsentClosed {
  requestId: string;
}

export interface DesignAppLogs {
  /** The run (the dev server's job) the bytes belong to; absent before the app's first run. */
  run?: string;
  text: string;
  from: number;
  next: number;
  /** The run's output so far, in bytes. */
  end: number;
  /** The read began at the run's oldest kept byte instead of the cursor: older output was dropped, or the cursor was another run's. */
  truncated: boolean;
}

export type DesignAppConsentAnswer = "allow" | "decline";

export const DESIGN_APP_CHANNELS = {
  statusGet: "designApp:status:get",
  start: "designApp:start",
  stop: "designApp:stop",
  restart: "designApp:restart",
  choose: "designApp:choose",
  logs: "designApp:logs",
  consentAnswer: "designApp:consentAnswer",
  status: "designApp:status",
  consent: "designApp:consent",
  consentClosed: "designApp:consentClosed",
  /** (chatId) → DesignAppRunningScan. */
  running: "designApp:running",
  /** (chatId, { port, pid }) → DesignAppStatus. */
  connect: "designApp:connect",
  /** (chatId, appRoot) → DesignAppStatus. */
  retry: "designApp:retry",
  /** 3d: (chatId, { pageId }) → DesignAppScaffoldResult; throws on a refusal, like every designApp:* handler. */
  scaffold: "designApp:scaffold",
} as const;

/** What a scaffold answered (S113). */
export type DesignAppScaffoldResult =
  | {
      status: "scaffolded";
      root: string;
      kind: DesignMockKind;
      app: DesignAppStatus;
      /** "pending": the start hasn't reached running; `/` is placed when it does (kept for one retry). */
      placed: "placed" | "already" | "pending" | "none";
      aliases: Record<string, string>;
      stubs: Record<string, string>;
      globals: string[];
      designMd: "drafted" | "starter";
      styleSources: string[];
    }
  | { status: "existing"; root: string; app: DesignAppStatus }
  | { status: "problem"; problem: DesignAppProblem };

/**
 * Whether a chat may run its workspace's apps: only an attended desktop chat,
 * never a Bot's or a feature-owned one (any present owner counts). Every path
 * that starts an app for a chat (the designApp:* channels, the Design toggle
 * and Enter on Aiden's design-mode card) asks this one guard.
 */
export function chatRunsDesignApps<T extends { botId?: string; owner?: unknown }>(chat: T | null | undefined): chat is T {
  return chat !== null && chat !== undefined && !chat.botId && chat.owner === undefined;
}

/** The scaffold card's network sentence (S106). */
export const DESIGN_APP_SCAFFOLD_NETWORK = "Downloads these from the npm registry with your npm settings.";
/** In place of 2b's install note on the scaffold card: the template's .npmrc turns install scripts off (S106). */
export const DESIGN_APP_SCAFFOLD_NO_SCRIPTS = "The packages' install scripts don't run.";

/** One fixed sentence per refusal, saying what to fix (S103). `folder` names the design-app folder for in-workspaces. */
export function mockRefusalMessage(why: MockRefusal, folder = "design-app"): string {
  switch (why) {
    case "has-web-app":
      return "This workspace already has a web app, so design mode runs that instead of adding a design app.";
    case "workspace-runner":
      return "This workspace's dev script hands off to a workspace runner. Name the app in .aiden/canvas.json, or start it yourself and use Connect running server….";
    case "unknown-framework":
      return "This workspace has a dev script, but design mode can't tell which web framework it runs. Name the app in .aiden/canvas.json, or start it yourself and use Connect running server….";
    case "no-dev-script":
      return "This workspace's app has no dev, start or serve script. Add one to its package.json, then try again.";
    case "invalid-package-json":
      return "A package.json in this workspace can't be read as JSON. Fix it, then try again.";
    case "truncated":
      return "This workspace has too many folders for design mode to check them all, so it won't add a design app. Name the app in .aiden/canvas.json instead.";
    case "unsupported-config":
      return ".aiden/canvas.json is from a newer Aiden, so design mode can't add a design app to it.";
    case "no-free-folder":
      return "design-app and design-app-2 through design-app-9 are all taken by other folders. Rename one, then try again.";
    case "in-workspaces":
      return `This workspace's workspaces patterns would include ${folder}, so its install would join yours. Add "!${folder}" to them, then try again.`;
    case "read-only":
      return "Aiden can only read this workspace's folder, so it can't add a design app. Give it write access, then try again.";
  }
}

/** Which fixed hint a design app's failed install gets, read from npm's untrusted output (S112). Never shown itself. */
export function installFailureHint(tail: string): "network" | "auth" | "other" {
  if (/\b(?:E401|E403|ENEEDAUTH)\b/u.test(tail)) return "auth";
  if (/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH)\b/u.test(tail)) return "network";
  if (/\bnetwork request to \S+ failed\b/u.test(tail)) return "network";
  return "other";
}

const INSTALL_HINTS: Record<"network" | "auth" | "other", string> = {
  network: "The design app's install needs the npm registry. Check your network or proxy, then Retry.",
  auth: "The npm registry refused the download. Check your npm sign-in or registry settings, then Retry.",
  other: "Show logs has npm's output.",
};

/** The S2 sentence every launch card ends with. */
export const DESIGN_APP_CONSENT_SCOPE =
  "This approves the commands above. The dev server then runs this app's own code, and approving doesn't cover what that code does.";
export const DESIGN_APP_INSTALL_NOTE = "Installing runs your dependencies' install scripts.";
export const DESIGN_APP_SAVES_CHOICE = "Allow also saves this choice in .aiden/canvas.json.";
/** The sentence every attach card ends with (2c S50). */
export const DESIGN_APP_ATTACH_SCOPE =
  "Aiden will show this server's pages in design mode. It never starts, stops or restarts it, and approving doesn't cover what the server does.";

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One fixed sentence per toolchain problem, for 2b's tool answers and 2c's chip. */
export function toolchainProblemMessage(problem: ToolchainProblem): string {
  switch (problem.problem) {
    case "node-missing":
      return `Node.js ${DESIGN_NODE_MIN_MAJOR} or newer wasn't found. Install it from nodejs.org or Homebrew, then try again.`;
    case "manager-missing":
      return `This app uses ${problem.manager}, which wasn't found. Install ${problem.manager}, then try again.`;
    case "manager-conflict": {
      if (problem.field) {
        const locked = problem.conflict.filter((name) => name !== problem.field).map((name) => `${name}'s`);
        const several = locked.length > 1;
        return `packageManager says ${problem.field}, but the ${several ? "lockfiles are" : "lockfile is"} ${listNames(locked)}. Delete the other ${several ? "lockfiles" : "lockfile"} or change packageManager.`;
      }
      const several = problem.conflict.length > 2;
      return `This app has lockfiles for ${listNames(problem.conflict)}. Delete the ${several ? "ones" : "one"} you don't use, or set packageManager in package.json.`;
    }
    case "unsupported-manager":
      return "This app uses Deno, which design mode can't run yet.";
  }
}

/**
 * A fixed sentence per problem. Never includes log text: tails travel separately, fenced or escaped.
 * For a design app (`mock`), a failed or timed-out install adds one fixed hint (S112).
 */
export function designAppProblemMessage(problem: DesignAppProblem, options: { mock?: boolean } = {}): string {
  const base = problemSentence(problem);
  if (!options.mock) return base;
  if (problem.problem === "install-failed") return `${base} ${INSTALL_HINTS[installFailureHint(problem.tail)]}`;
  if (problem.problem === "install-timeout") return `${base} ${INSTALL_HINTS.network}`;
  return base;
}

function problemSentence(problem: DesignAppProblem): string {
  switch (problem.problem) {
    case "unavailable":
      return "Live apps are not available.";
    case "no-access":
      return "Aiden can't use this workspace's folder now, so it can't run the app.";
    case "interrupted":
      return "The workspace changed while the app was starting. Start it again.";
    case "desktop-only":
      return "Only an Aiden window on this computer can start the app.";
    case "recovery-failed":
      return "Aiden couldn't clean up the processes its last session left, so it can't start apps now. Quit and reopen Aiden, then try again.";
    case "node-missing":
    case "manager-missing":
    case "manager-conflict":
    case "unsupported-manager":
      return toolchainProblemMessage(problem);
    case "launch-file-unreadable":
      return `Aiden can't read ${problem.file} safely (it's a link, a special file or too large), so it won't start the app.`;
    case "script-too-long":
      return "The app's dev script is longer than 4,000 characters, so Aiden won't run it.";
    case "consent-declined":
      return "The app wasn't started: running it wasn't approved.";
    case "consent-unanswered":
      return "Nobody answered the run-app card in time, so the app didn't start.";
    case "consent-unavailable":
      return "There was no Aiden window to ask in, so the app didn't start.";
    case "choice-not-saved":
      return "Aiden couldn't save your choice in .aiden/canvas.json (it may be a link, unreadable, or from a newer Aiden), so it didn't start the app.";
    case "job-limit":
      return "Design mode already runs 8 apps. Stop one, then try again.";
    case "install-outside-workspace":
      return "This app's lockfile is in a parent folder, and Aiden never installs there. Install the dependencies in the parent repo, then start the app again.";
    case "install-failed":
      return problem.exitCode === null
        ? "Installing the app's dependencies failed."
        : `Installing the app's dependencies failed (exit code ${problem.exitCode}).`;
    case "install-timeout":
      return "Installing the app's dependencies took longer than 15 minutes, so Aiden stopped it.";
    case "not-ready":
      return "The app's dev server didn't start listening in time, so Aiden stopped it.";
    case "exposed":
      return "The app's dev server listened beyond this computer, not only on 127.0.0.1, so Aiden stopped it. Remove --host from its dev script, or make the server listen on process.env.PORT at process.env.HOST.";
    case "exposure-unknown":
      return "Aiden couldn't confirm the app's dev server listens only on 127.0.0.1, so it stopped it.";
    case "not-web":
      return "That folder isn't a web app design mode can run.";
    case "attach-not-loopback":
      return "Design mode connects only to a server that listens on this computer alone. Restart it bound to 127.0.0.1 (for example with --host 127.0.0.1 or --hostname 127.0.0.1), then connect again.";
    case "attach-unreachable":
      return "Design mode couldn't find a server of yours listening on that port.";
    case "attach-not-in-app":
      return "That server doesn't belong to this workspace's apps.";
    case "already-running":
      return problem.started
        ? "Aiden already runs this app. Stop it first, then connect."
        : "Design mode is already connected to a server for this app, and Aiden never restarts or replaces a server it didn't start. Disconnect it first.";
    case "attach-url-invalid":
      return "The url for this app in .aiden/canvas.json can't be connected. Use http://127.0.0.1:<port>, http://localhost:<port> or http://[::1]:<port>, with no path.";
    case "scaffold-refused":
      return mockRefusalMessage(problem.why);
    case "scaffold-failed":
      switch (problem.step) {
        case "template":
          return "Aiden couldn't read its design app template, so nothing was written. Reinstall Aiden, then try again.";
        case "write":
          return "Aiden couldn't finish writing the design app and left what it wrote in its folder. Delete that folder, then try again.";
        case "verify":
          return "A design app file changed while Aiden was writing it, so Aiden didn't start it. Start it again to review it.";
        case "design-md":
          return "Aiden couldn't draft the design app's DESIGN.md, so nothing was written. Try again.";
      }
  }
}

/**
 * Characters that could hide or reorder what the person approves: controls
 * (but `\n`), format characters (bidi overrides, zero-width), line and
 * paragraph separators, Hangul fillers, variation selectors and every other
 * default-ignorable code point (combining grapheme joiner, Khmer inherent vowels).
 */
const HIDDEN_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Variation_Selector}\p{Default_Ignorable_Code_Point}\u{115F}\u{1160}\u{3164}\u{FFA0}]/gu;

/** Script text, app roots and package names as the card shows them: verbatim, hidden characters as `\u{…}`. */
export function consentDisplayText(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, (character) =>
    character === "\n" ? character : `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

/**
 * An app root or folder as the chip's menu, the logs drawer, the attach card
 * and the Connect sheet show it: the workspace's own folder (`.`) as
 * "workspace folder", anything else escaped (B8). Main's values keep `.`.
 */
export function designAppRootText(root: string): string {
  return root === "." ? "workspace folder" : consentDisplayText(root);
}

/** Paths show in monospace; the workspace folder's name is words. */
export const designAppRootClass = (root: string): string | undefined => (root === "." ? undefined : "font-mono");

// ---- 2c: the logs drawer's text (D4) ----

/** What one log chunk leaves for the next: an unfinished sequence, the line's length so far, and its dropped characters. */
export interface LogCarry {
  pending: string;
  column: number;
  dropped: number;
}

export const EMPTY_LOG_CARRY: LogCarry = Object.freeze({ pending: "", column: 0, dropped: 0 });

/** A line longer than this shows its first characters and a count of the rest. */
const LOG_LINE_MAX = 4096;
/** An escape sequence longer than this without its end shows escaped instead (A-m4). */
const LOG_PENDING_MAX = 4096;
const ESC = "\u001B";

/** Log text keeps tabs and newlines; every other hidden character shows as `\u{…}`. */
function logEscapeHidden(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, (character) =>
    character === "\n" || character === "\t" ? character : `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`,
  );
}

/**
 * Where the escape sequence that starts at `at` (an ESC) ends: the index after
 * it, "incomplete" when the text ends first, or "lone" when the ESC starts no
 * sequence it can finish (it then shows escaped, and what follows shows as
 * text). A sequence still unfinished after 4 KiB is "lone", whether or not
 * the text ends there, so the answer doesn't depend on how the log was read.
 */
function escapeEnd(text: string, at: number): number | "incomplete" | "lone" {
  const limit = at + LOG_PENDING_MAX;
  const unfinished = () => (text.length > limit ? "lone" : "incomplete");
  const end = Math.min(text.length, limit);
  const introducer = text[at + 1];
  if (introducer === undefined) return "incomplete";
  if (introducer === "[") {
    // CSI: parameter bytes, intermediate bytes, then one final byte.
    let index = at + 2;
    while (index < end && text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x3f) index++;
    while (index < end && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++;
    if (index >= end) return unfinished();
    const final = text.charCodeAt(index);
    // A malformed CSI ends where it breaks; the breaking character is shown.
    return final >= 0x40 && final <= 0x7e ? index + 1 : index;
  }
  if (introducer === "]" || introducer === "P" || introducer === "X" || introducer === "^" || introducer === "_") {
    // OSC ends at BEL or ST; DCS, SOS, PM and APC at ST (BEL accepted too). CAN and SUB cancel it.
    // A line break ends it unfinished (the newline policy), so one never hides the lines after it.
    for (let index = at + 2; index < end; index++) {
      const character = text[index];
      if (character === "\u0007" || character === "\u0018" || character === "\u001A") return index + 1;
      if (character === "\n" || character === "\r") return "lone";
      if (character === ESC) {
        if (index + 1 >= text.length) return unfinished();
        if (text[index + 1] === "\\") return index + 2;
      }
    }
    return unfinished();
  }
  // Two-byte (or intermediate-prefixed) sequences: ESC, intermediates, a final byte.
  let index = at + 1;
  while (index < end && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++;
  if (index >= end) return unfinished();
  const final = text.charCodeAt(index);
  return final >= 0x30 && final <= 0x7e ? index + 1 : "lone";
}

/**
 * One chunk of a dev server's output as the logs drawer shows it (D4): escape
 * sequences removed (an unfinished one waits in the carry for the next chunk),
 * `\r\n` and lone `\r` as `\n`, lines capped at 4 KiB with the rest counted,
 * and every hidden character but tab shown as `\u{…}`.
 */
export function logDisplayChunk(text: string, carry: LogCarry): { text: string; carry: LogCarry } {
  const input = carry.pending + text;
  let column = carry.column;
  let dropped = carry.dropped;
  let pending = "";
  const out: string[] = [];
  let run = "";
  const flushRun = () => {
    if (run) out.push(run);
    run = "";
  };
  const newline = () => {
    flushRun();
    if (dropped > 0) out.push(` [${dropped} more characters]`);
    out.push("\n");
    column = 0;
    dropped = 0;
  };
  const emit = (character: string) => {
    if (column < LOG_LINE_MAX) {
      run += character;
      column++;
    } else dropped++;
  };
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (character === ESC) {
      const end = escapeEnd(input, index);
      if (end === "incomplete") {
        pending = input.slice(index);
        break;
      }
      if (end === "lone") {
        emit(character);
        index++;
      } else index = end;
      continue;
    }
    if (character === "\r") {
      if (index + 1 >= input.length) {
        pending = "\r";
        break;
      }
      if (input[index + 1] === "\n") index++;
      newline();
      index++;
      continue;
    }
    if (character === "\n") {
      newline();
      index++;
      continue;
    }
    const code = input.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    emit(input.slice(index, index + width));
    index += width;
  }
  flushRun();
  return { text: logEscapeHidden(out.join("")), carry: { pending, column, dropped } };
}

/** One-off log text: `logDisplayChunk` from an empty carry, with anything left unfinished shown escaped. */
export function logDisplayText(text: string): string {
  const { text: shown, carry } = logDisplayChunk(text, EMPTY_LOG_CARRY);
  const rest = carry.pending === "\r" ? "\n" : logEscapeHidden(carry.pending);
  return `${shown}${carry.dropped > 0 ? ` [${carry.dropped} more characters]` : ""}${rest}`;
}

// ---- 2c: the status chip, Retry, announcements and the browser listing ----

export interface DesignAppChip {
  label: string;
  tone: "neutral" | "busy" | "running" | "problem";
  apps: DesignAppStatus[];
  /** The menu offers Choose apps…. */
  choose: boolean;
  /** No app to run: the menu offers only Connect running server…. */
  connectOnly: boolean;
}

/** One app's chip label (D2). */
export function designAppLabel(status: DesignAppStatus): string {
  switch (status.phase) {
    case "running":
      return status.port === undefined ? status.frameworkLabel : `${status.frameworkLabel} · :${status.port}`;
    case "installing":
      return "Installing…";
    case "starting":
      return "Starting…";
    case "consent":
      return "Waiting for approval";
    case "crashed":
      return "Crashed";
    case "stopped":
      if (status.problem) return "Not running";
      if (status.source === "attached") return status.url !== undefined ? "Connect" : "Connect again";
      return "Start";
  }
}

/** One app's tone (D2). */
export function designAppTone(status: DesignAppStatus): DesignAppChip["tone"] {
  switch (status.phase) {
    case "running":
      return "running";
    case "installing":
    case "starting":
    case "consent":
      return "busy";
    case "crashed":
      return "problem";
    case "stopped":
      return status.problem ? "problem" : "neutral";
  }
}

const TONE_RANK: Record<DesignAppChip["tone"], number> = { neutral: 0, running: 1, busy: 2, problem: 3 };

/** The chip for a workspace's snapshot, or null when it's hidden (D2). */
export function designAppChip(snapshot: DesignAppsSnapshot): DesignAppChip | null {
  if (snapshot.target === "unavailable") return null;
  const apps = snapshot.apps;
  const choose = snapshot.candidates.length > 1;
  if (apps.length === 0) {
    if (snapshot.target === "choose") return { label: "Choose apps…", tone: "neutral", apps, choose: true, connectOnly: false };
    return { label: "Connect", tone: "neutral", apps, choose: false, connectOnly: true };
  }
  if (apps.length === 1) return { label: designAppLabel(apps[0]!), tone: designAppTone(apps[0]!), apps, choose, connectOnly: false };
  const tone = apps.map(designAppTone).reduce((worst, next) => (TONE_RANK[next] > TONE_RANK[worst] ? next : worst));
  return { label: `${apps.length} apps`, tone, apps, choose, connectOnly: false };
}

const RETRYABLE: ReadonlySet<DesignAppProblem["problem"]> = new Set([
  "install-failed",
  "install-timeout",
  "node-missing",
  "manager-missing",
  "manager-conflict",
  "unsupported-manager",
  "not-ready",
  "exposure-unknown",
  "recovery-failed",
  "choice-not-saved",
]);

/** Whether the chip's menu offers Retry (D5): a started app that crashed or failed in a way a retry can fix. */
export function designAppRetryable(status: DesignAppStatus): boolean {
  if (status.source !== "started") return false;
  if (status.phase === "crashed") return true;
  return status.phase === "stopped" && status.problem !== undefined && RETRYABLE.has(status.problem.problem);
}

/** The two transitions the chip announces (D2): a crash and a disconnect. */
export function designAppAnnouncement(previous: DesignAppStatus | undefined, next: DesignAppStatus): string | null {
  if (!previous || previous.phase !== "running") return null;
  if (next.phase === "crashed") return `${next.frameworkLabel} crashed.`;
  // The person's own Disconnect leaves no problem and isn't announced (B6).
  if (previous.source === "attached" && next.source === "attached" && next.phase === "stopped" && next.problem && previous.origin) {
    return `Disconnected from your server at ${previous.origin.replace(/^http:\/\//u, "")}.`;
  }
  return null;
}

/** Running design apps for the browser panel's Local servers (D12). */
export function designBrowserServers(snapshot: DesignAppsSnapshot): Array<{ url: string; label: string }> {
  return snapshot.apps
    .filter((status) => status.phase === "running" && status.origin !== undefined)
    .map((status) => ({ url: `${status.origin}/`, label: `${status.frameworkLabel} · ${consentDisplayText(status.appRoot)} · design mode` }));
}

/** A piece of script text as the card shows it: text, a marked line break, or a collapsed run shown as its count. */
export type ConsentScriptPart = { kind: "text"; text: string } | { kind: "break" } | { kind: "gap"; text: string };

/** Blank lines in a row that collapse into one "[N blank lines]" line. */
const BLANK_LINE_RUN = 3;
/** Space characters in a row that collapse into "[N spaces]". */
const SPACE_RUN = 8;

/**
 * Script text for the card (A-M2): `consentDisplayText`'s escapes, every line
 * break marked, and runs of three or more blank lines or eight or more
 * spaces shown as their count, so nothing can be pushed out of view below or
 * beside the text the person reads.
 */
export function consentScriptParts(text: string): ConsentScriptPart[] {
  const spaced = (line: string): ConsentScriptPart[] => {
    const parts: ConsentScriptPart[] = [];
    let at = 0;
    for (const match of line.matchAll(new RegExp(`\\p{Zs}{${SPACE_RUN},}`, "gu"))) {
      if (match.index > at) parts.push({ kind: "text", text: line.slice(at, match.index) });
      parts.push({ kind: "gap", text: `[${[...match[0]].length} spaces]` });
      at = match.index + match[0].length;
    }
    if (at < line.length) parts.push({ kind: "text", text: line.slice(at) });
    return parts;
  };
  const lines: ConsentScriptPart[][] = [];
  let blank: string[] = [];
  const flush = () => {
    if (blank.length >= BLANK_LINE_RUN) lines.push([{ kind: "gap", text: `[${blank.length} blank lines]` }]);
    else for (const line of blank) lines.push(spaced(line));
    blank = [];
  };
  for (const line of consentDisplayText(text).split("\n")) {
    if (/^\p{Zs}*$/u.test(line)) blank.push(line);
    else {
      flush();
      lines.push(spaced(line));
    }
  }
  flush();
  return lines.flatMap((line, index) => (index === 0 ? line : [{ kind: "break" as const }, ...line]));
}
