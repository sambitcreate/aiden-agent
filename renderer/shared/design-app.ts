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
  | { problem: "attach-not-in-app" };

export interface DesignAppStatus {
  workspaceId: string;
  /** POSIX, relative, "." for the workspace root. */
  appRoot: string;
  /** 2b only makes "started"; 2c attaches running servers. */
  source: "started" | "attached";
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
  revision: number;
}

export interface DesignAppCandidate {
  appRoot: string;
  framework?: FrameworkId;
  frameworkLabel: string;
  script?: string;
  name?: string;
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
  /** 2c renders these. */
  | { kind: "attach"; requestId: string; chatId: string; workspaceId: string; appRoot: string; url: string };

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
} as const;

/**
 * Whether a chat may run its workspace's apps: only an attended desktop chat,
 * never a Bot's or a feature-owned one (any present owner counts). Every path
 * that starts an app for a chat (the designApp:* channels, the Design toggle
 * and Enter on Aiden's design-mode card) asks this one guard.
 */
export function chatRunsDesignApps<T extends { botId?: string; owner?: unknown }>(chat: T | null | undefined): chat is T {
  return chat !== null && chat !== undefined && !chat.botId && chat.owner === undefined;
}

/** The S2 sentence every launch card ends with. */
export const DESIGN_APP_CONSENT_SCOPE =
  "This approves the commands above. The dev server then runs this app's own code, and approving doesn't cover what that code does.";
export const DESIGN_APP_INSTALL_NOTE = "Installing runs your dependencies' install scripts.";
export const DESIGN_APP_SAVES_CHOICE = "Allow also saves this choice in .aiden/canvas.json.";

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

/** A fixed sentence per problem. Never includes log text: tails travel separately, fenced or escaped. */
export function designAppProblemMessage(problem: DesignAppProblem): string {
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
      return "Only a server on this computer, at 127.0.0.1, can be connected.";
    case "attach-unreachable":
      return "Nothing answered at that address.";
    case "attach-not-in-app":
      return "That server doesn't belong to this workspace's apps.";
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
