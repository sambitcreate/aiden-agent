// What a command approval card says in plain words (the "flip" card):
//
// - `explanation` is the model's own one-sentence description of the command
//   (`run_command`'s `description`). It is model-written, so it is display
//   text only: the card always keeps the exact command one flip away, and
//   remembered rules never read it.
// - `tags` are Aiden's own reading of the command text, worked out here
//   without any model. A model that was tricked into describing something
//   harmful as harmless cannot hide a "Deletes files" tag. They are a heads-up,
//   not a sandbox: a command Aiden can't fully read gets a tag saying so.
//
// The main process (and the `aiden serve` daemon) builds the reading when an
// approval is asked, because only it knows the workspace folder. Renderers and
// the Aiden Remote card (`approval:plain-words`) re-validate what they receive.

export type CommandTagTone = "calm" | "risk";

export interface CommandTag {
  label: string;
  tone: CommandTagTone;
}

export interface CommandReading {
  /** The model's plain-words description, one line. Absent when the call gave none. */
  explanation?: string;
  /** Aiden's own tags, risky ones first. */
  tags: CommandTag[];
}

export const COMMAND_READING_LIMITS = {
  explanation: 400,
  tags: 8,
  tagLabel: 80,
  /** Longest file name a calm tag spells out. */
  name: 40,
  /** Commands longer than this are not read; the card says so instead. */
  command: 16_000,
} as const;

// Bidi overrides and zero-width characters can make shown text read
// differently from what it is; the description never needs them.
const HIDDEN_CHARACTERS = new RegExp(
  `[${([[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]] as const)
    .map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`)
    .join("")}]`,
  "gu",
);

function clip(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The model's description as the card shows it: one trimmed line, bounded, or undefined. */
export function commandExplanation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(HIDDEN_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return line ? clip(line, COMMAND_READING_LIMITS.explanation) : undefined;
}

// ---------------------------------------------------------------------------
// A small, conservative reading of POSIX shell text
// ---------------------------------------------------------------------------

interface ParsedShell {
  /** Simple commands in order, as their words (quotes removed). */
  commands: Array<{ words: string[]; pipedFrom: boolean }>;
  /** Files written by `>`/`>>` (and `&>`), with whether they append. */
  writes: Array<{ path: string; append: boolean }>;
  /** `$( … )`, backtick and `<( … )` bodies, read separately. */
  substitutions: string[];
  /** False when quotes or substitutions are left open. */
  complete: boolean;
}

const OPERATOR_START = new Set([";", "&", "|", "\n", "(", ")"]);

/** Finds the `)` that closes a `$(` or `<(` opened just before `start`, quote-aware. */
function closingParen(text: string, start: number): number {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\\") {
      index += 1;
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return -1;
      index = end;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) return -1;
      index = end;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseShell(text: string): ParsedShell {
  const parsed: ParsedShell = { commands: [], writes: [], substitutions: [], complete: true };
  let words: string[] = [];
  let word: string | null = null;
  let pipedFrom = false;
  let pendingRedirect: { kind: "write"; append: boolean } | { kind: "read" } | { kind: "heredoc" } | undefined;
  const heredocs: string[] = [];

  const endWord = () => {
    if (word === null) return;
    const value = word;
    word = null;
    if (pendingRedirect) {
      const redirect = pendingRedirect;
      pendingRedirect = undefined;
      if (redirect.kind === "write" && !value.startsWith("&")) parsed.writes.push({ path: value, append: redirect.append });
      if (redirect.kind === "heredoc") heredocs.push(value.replace(/^-/u, ""));
      return;
    }
    words.push(value);
  };
  const endCommand = (pipeNext: boolean) => {
    endWord();
    if (words.length > 0) parsed.commands.push({ words, pipedFrom });
    words = [];
    pipedFrom = pipeNext;
  };
  const append = (value: string) => {
    word = (word ?? "") + value;
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "\\") {
      if (next === "\n") index += 2;
      else {
        if (next !== undefined) append(next);
        index += 2;
      }
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) {
        parsed.complete = false;
        append(text.slice(index + 1));
        break;
      }
      append(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = "";
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\" && end + 1 < text.length) {
          value += text[end + 1];
          end += 2;
          continue;
        }
        if (text[end] === "$" && text[end + 1] === "(") {
          const close = closingParen(text, end + 2);
          if (close < 0) {
            parsed.complete = false;
            end = text.length;
            break;
          }
          parsed.substitutions.push(text.slice(end + 2, close));
          value += "$(…)";
          end = close + 1;
          continue;
        }
        if (text[end] === "`") {
          const close = text.indexOf("`", end + 1);
          if (close < 0) {
            parsed.complete = false;
            end = text.length;
            break;
          }
          parsed.substitutions.push(text.slice(end + 1, close));
          value += "`…`";
          end = close + 1;
          continue;
        }
        value += text[end];
        end += 1;
      }
      if (end >= text.length) parsed.complete = false;
      append(value);
      index = end + 1;
      continue;
    }
    if ((char === "$" || char === "<" || char === ">") && next === "(" && (char === "$" || word === null)) {
      const close = closingParen(text, index + 2);
      if (close < 0) {
        parsed.complete = false;
        break;
      }
      parsed.substitutions.push(text.slice(index + 2, close));
      append(char === "$" ? "$(…)" : "<(…)");
      index = close + 1;
      continue;
    }
    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) {
        parsed.complete = false;
        break;
      }
      parsed.substitutions.push(text.slice(index + 1, close));
      append("`…`");
      index = close + 1;
      continue;
    }
    if (char === "#" && word === null) {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      index += 1;
      continue;
    }
    if (char === ">" || char === "<" || (char === "&" && next === ">")) {
      // A bare file descriptor before the operator ("2>") is not a word.
      if (word !== null && /^\d+$/u.test(word)) word = null;
      endWord();
      if (char === "<") {
        if (next === "<" && text[index + 2] === "<") {
          pendingRedirect = { kind: "read" };
          index += 3;
        } else if (next === "<") {
          pendingRedirect = { kind: "heredoc" };
          index += 2;
        } else {
          pendingRedirect = { kind: "read" };
          index += next === "&" ? 2 : 1;
        }
        continue;
      }
      let cursor = char === "&" ? index + 2 : index + 1;
      let appendMode = false;
      if (text[cursor] === ">") {
        appendMode = true;
        cursor += 1;
      } else if (text[cursor] === "|") {
        cursor += 1;
      }
      if (text[cursor] === "&") {
        // `>&2`: a descriptor, not a file.
        cursor += 1;
        while (cursor < text.length && /[\d-]/u.test(text[cursor]!)) cursor += 1;
        index = cursor;
        continue;
      }
      pendingRedirect = { kind: "write", append: appendMode };
      index = cursor;
      continue;
    }
    if (OPERATOR_START.has(char)) {
      if (char === "|") {
        if (next === "|") {
          endCommand(false);
          index += 2;
        } else {
          endCommand(true);
          index += next === "&" ? 2 : 1;
        }
        continue;
      }
      if (char === "&" && next === "&") {
        endCommand(false);
        index += 2;
        continue;
      }
      endCommand(false);
      if (char === "\n" && heredocs.length > 0) {
        // Skip each here-document's body, which is data, not commands.
        let cursor = index + 1;
        for (const delimiter of heredocs.splice(0)) {
          let found = false;
          while (cursor <= text.length) {
            const lineEnd = text.indexOf("\n", cursor);
            const line = text.slice(cursor, lineEnd < 0 ? text.length : lineEnd);
            cursor = lineEnd < 0 ? text.length + 1 : lineEnd + 1;
            if (line.trim() === delimiter) {
              found = true;
              break;
            }
          }
          if (!found) parsed.complete = false;
        }
        index = cursor;
        continue;
      }
      index += 1;
      continue;
    }
    append(char);
    index += 1;
  }
  if (heredocs.length > 0) parsed.complete = false;
  endCommand(false);
  return parsed;
}

// ---------------------------------------------------------------------------
// Reading the commands
// ---------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([
  ...SHELLS, "python", "python2", "python3", "node", "nodejs", "ruby", "perl", "php", "deno", "bun", "tsx", "ts-node", "osascript",
]);
const SCRIPT_RUNNERS: Record<string, string> = {
  python: "Python", python2: "Python", python3: "Python", node: "Node", nodejs: "Node", ruby: "Ruby", perl: "Perl", php: "PHP",
  deno: "Deno", bun: "Bun", tsx: "Node", "ts-node": "Node", sh: "the shell", bash: "the shell", zsh: "the shell", dash: "the shell",
};
const FETCHERS = new Set(["curl", "wget"]);
const NETWORK_COMMANDS = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "netcat", "telnet", "http", "https", "xh", "ping", "dig", "nslookup",
  "host", "npx", "bunx", "pnpx", "gh",
]);
const NETWORK_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  git: new Set(["push", "pull", "fetch", "clone", "ls-remote", "submodule", "remote"]),
  npm: new Set(["install", "i", "add", "ci", "publish", "update", "upgrade", "exec", "create", "init", "login", "unpublish", "dist-tag"]),
  pnpm: new Set(["install", "i", "add", "update", "up", "upgrade", "publish", "dlx", "create"]),
  yarn: new Set(["install", "add", "upgrade", "up", "publish", "dlx", "create"]),
  bun: new Set(["install", "i", "add", "update", "upgrade", "publish", "create", "x"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  uv: new Set(["add", "sync", "pip", "tool", "lock"]),
  pipx: new Set(["install", "run", "upgrade"]),
  poetry: new Set(["install", "add", "update", "publish"]),
  brew: new Set(["install", "upgrade", "update", "tap", "reinstall", "fetch"]),
  gem: new Set(["install", "update", "push"]),
  cargo: new Set(["install", "add", "update", "publish", "fetch"]),
  go: new Set(["get", "install", "mod"]),
  docker: new Set(["pull", "push", "login"]),
  apt: new Set(["install", "update", "upgrade"]),
  "apt-get": new Set(["install", "update", "upgrade"]),
  softwareupdate: new Set(["--install", "-i", "--download", "-d", "--list", "-l"]),
};
const DELETERS = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash"]);
const STOPPERS = new Set(["kill", "pkill", "killall"]);
const LAUNCHCTL_STOPS = new Set(["unload", "stop", "remove", "bootout", "kill", "disable"]);
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const ADMIN = new Set(["sudo", "doas", "su", "pkexec"]);
const PERMISSIONS = new Set(["chmod", "chown", "chgrp", "chflags"]);
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];
const DEVICE_FILES = /^\/dev\/(null|zero|stdin|stdout|stderr|tty|u?random|fd\/\d+)$/u;

/** Words that only start another command: `sudo env FOO=1 nohup npm test`. */
function stripWrappers(words: readonly string[], seen: Set<string>): string[] {
  let rest = [...words];
  for (;;) {
    while (rest.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0]!)) rest = rest.slice(1);
    const name = baseName(rest[0] ?? "");
    if (ADMIN.has(name)) {
      seen.add("admin");
      rest = rest.slice(1);
      // sudo's own options, and the user an `-u` names.
      while (rest[0]?.startsWith("-")) rest = /^-[ugCDhpRrTt]$/u.test(rest[0]) ? rest.slice(2) : rest.slice(1);
      continue;
    }
    if (name === "env") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = /^-[uSC]$/u.test(rest[0]) ? rest.slice(2) : rest.slice(1);
      continue;
    }
    if (["nohup", "time", "command", "exec", "builtin", "caffeinate", "stdbuf", "unbuffer", "noglob"].includes(name)) {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = rest.slice(1);
      continue;
    }
    if (name === "nice" || name === "ionice") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = /^-[nc]$/u.test(rest[0]) ? rest.slice(2) : rest.slice(1);
      continue;
    }
    if (name === "timeout" || name === "gtimeout") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = /^-[sk]$/u.test(rest[0]) ? rest.slice(2) : rest.slice(1);
      rest = rest.slice(1);
      continue;
    }
    if (name === "xargs") {
      rest = rest.slice(1);
      while (rest[0]?.startsWith("-")) rest = /^-[nIiLPdsEa]$/u.test(rest[0]) ? rest.slice(2) : rest.slice(1);
      continue;
    }
    return rest;
  }
}

function baseName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function shownName(path: string): string {
  const name = baseName(path).replace(HIDDEN_CHARACTERS, "") || path;
  return clip(name, COMMAND_READING_LIMITS.name);
}

/** The words after the first `-c` of a shell (`bash -lc "…"`), or undefined. */
function shellScript(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-") || arg === "--") return undefined;
    if (/^-[a-z]*c[a-z]*$/u.test(arg)) return args[index + 1];
  }
  return undefined;
}

/** The script file an interpreter runs, when it runs one (not `-c`, `-e`, `-m` or stdin). */
function scriptFile(args: readonly string[]): string | undefined {
  for (const arg of args) {
    if (arg === "-" || /^-[a-zA-Z]*[cemr]$/u.test(arg) || arg === "--eval" || arg === "--print") return undefined;
    if (arg.startsWith("-")) continue;
    return /[./]/u.test(arg) ? arg : undefined;
  }
  return undefined;
}

interface Reader {
  root?: string;
  home?: string;
  found: Set<string>;
  calm: Map<string, true>;
  depth: number;
}

/** A path the command reaches outside the workspace folder (and outside temp folders). */
function outsideProject(word: string, reader: Reader): boolean {
  let path = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
  if (path.includes("://")) return false;
  // A home path is the person's own files, even when the home folder itself sits under a temp root.
  let fromHome = false;
  if (path === "~" || path.startsWith("~/") || path.startsWith("~")) {
    if (!reader.home) return true;
    path = path === "~" ? reader.home : path.startsWith("~/") ? `${reader.home}${path.slice(1)}` : path;
    if (path.startsWith("~")) return true;
    fromHome = true;
  } else if (/^\$\{?HOME\}?(\/|$)/u.test(path)) {
    if (!reader.home) return true;
    path = path.replace(/^\$\{?HOME\}?/u, reader.home);
    fromHome = true;
  }
  if (path === ".." || path.startsWith("../")) return true;
  if (!path.startsWith("/")) return false;
  if (DEVICE_FILES.test(path)) return false;
  if (!fromHome && TEMP_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return false;
  const root = reader.root?.replace(/\/+$/u, "");
  if (root && (path === root || path.startsWith(`${root}/`))) {
    // `/project/../elsewhere` climbs back out.
    return path.slice(root.length).split("/").includes("..");
  }
  return true;
}

function readCommands(text: string, reader: Reader): void {
  if (reader.depth > 4) {
    reader.found.add("unread");
    return;
  }
  const parsed = parseShell(text);
  if (!parsed.complete) reader.found.add("unread");
  const nested = { ...reader, depth: reader.depth + 1 };
  for (const substitution of parsed.substitutions) readCommands(substitution, nested);
  for (const write of parsed.writes) {
    if (DEVICE_FILES.test(write.path)) continue;
    if (outsideProject(write.path, reader)) reader.found.add("outside");
    reader.calm.set(`${write.append ? "Edits" : "Writes"} ${shownName(write.path)}`, true);
  }
  // A fetch earlier in a pipeline, and whether it reaches a shell.
  let fetchInPipeline = false;
  const fetchSubstitution = parsed.substitutions.some((body) =>
    parseShell(body).commands.some(({ words }) => FETCHERS.has(baseName(stripWrappers(words, new Set())[0] ?? ""))),
  );
  for (const { words: raw, pipedFrom } of parsed.commands) {
    if (!pipedFrom) fetchInPipeline = false;
    const words = stripWrappers(raw, reader.found);
    if (words.length === 0) continue;
    const name = baseName(words[0]!);
    const args = words.slice(1);
    for (const arg of args) if (outsideProject(arg, reader)) reader.found.add("outside");
    if (words[0]!.startsWith("~") || words[0]!.startsWith("..")) reader.found.add("outside");
    // What runs is only known when it runs: `$CMD`, `$(…)`, or `eval "$(…)"`.
    if (/[$`]/u.test(words[0]!)) reader.found.add(fetchSubstitution ? "downloaded" : "unread");

    if (INTERPRETERS.has(name) && ((pipedFrom && fetchInPipeline && !scriptFile(args)) || fetchSubstitution)) {
      reader.found.add("downloaded");
    }
    if (FETCHERS.has(name)) fetchInPipeline = true;

    if (NETWORK_COMMANDS.has(name)) reader.found.add("internet");
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (subcommand && NETWORK_SUBCOMMANDS[name]?.has(subcommand)) reader.found.add("internet");
    if ((name === "softwareupdate") && args.some((arg) => NETWORK_SUBCOMMANDS.softwareupdate!.has(arg))) reader.found.add("internet");
    if (name === "yarn" && !subcommand) reader.found.add("internet");
    if ((name === "python" || name === "python3") && args[0] === "-m" && (args[1] === "pip" || args[1] === "ensurepip") && args.includes("install")) {
      reader.found.add("internet");
    }
    if (name === "rsync" && args.some((arg) => arg.startsWith("rsync://") || /^[\w.-]+@?[\w.-]*:/u.test(arg))) reader.found.add("internet");
    if (name === "rsync" && args.some((arg) => arg.startsWith("--delete"))) reader.found.add("deletes");

    if (DELETERS.has(name)) reader.found.add("deletes");
    if (name === "git" && (subcommand === "clean" || subcommand === "rm")) reader.found.add("deletes");
    if (name === "find") {
      if (args.includes("-delete")) reader.found.add("deletes");
      const exec = args.findIndex((arg) => arg === "-exec" || arg === "-execdir" || arg === "-ok");
      if (exec >= 0) {
        const end = args.findIndex((arg, index) => index > exec && (arg === ";" || arg === "+"));
        const inner = args.slice(exec + 1, end < 0 ? undefined : end);
        readWords(inner, nested);
      }
    }
    if (STOPPERS.has(name)) reader.found.add("stops");
    if (name === "launchctl" && subcommand && LAUNCHCTL_STOPS.has(subcommand)) reader.found.add("stops");
    if (POWER.has(name)) reader.found.add("power");
    if (name === "osascript") {
      const script = args.join(" ");
      if (/administrator privileges/iu.test(script)) reader.found.add("admin");
      if (/\bto quit\b|\bquit app\b/iu.test(script)) reader.found.add("stops");
    }
    if (PERMISSIONS.has(name)) reader.calm.set("Changes file permissions", true);

    if (SHELLS.has(name) || name === "eval") {
      const script = name === "eval" ? args.join(" ") : shellScript(args);
      if (script !== undefined) readCommands(script, nested);
    }

    // Calm steps, named the way the person sees the files.
    const operands = args.filter((arg) => !arg.startsWith("-"));
    if (name === "mkdir") for (const folder of operands) reader.calm.set(`Makes folder ${shownName(folder)}`, true);
    if (name === "touch") for (const file of operands) reader.calm.set(`Creates ${shownName(file)}`, true);
    if (name === "mv") reader.calm.set("Moves or renames files", true);
    if (name === "cp" || name === "ditto") reader.calm.set("Copies files", true);
    if ((name === "sed" || name === "gsed") && args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg === "--in-place" || /^-[a-zA-Z]*i/u.test(arg))) {
      const file = operands[operands.length - 1];
      if (file && operands.length >= 2) reader.calm.set(`Edits ${shownName(file)}`, true);
    }
    if (name === "perl" && args.some((arg) => /^-[a-zA-Z]*i/u.test(arg))) {
      const file = operands[operands.length - 1];
      if (file && operands.length >= 2) reader.calm.set(`Edits ${shownName(file)}`, true);
    }
    if (name === "tee") {
      const appending = args.includes("-a") || args.includes("--append");
      for (const file of operands) {
        if (DEVICE_FILES.test(file)) continue;
        reader.calm.set(`${appending ? "Edits" : "Writes"} ${shownName(file)}`, true);
      }
    }
    if (SCRIPT_RUNNERS[name]) {
      const file = scriptFile(args);
      if (file) reader.calm.set(`Runs ${shownName(file)} with ${SCRIPT_RUNNERS[name]}`, true);
    }
  }
}

function readWords(words: readonly string[], reader: Reader): void {
  // Already split: quote each word so it is read back as one.
  readCommands(words.map((word) => `'${word.replace(/'/gu, "'\\''")}'`).join(" "), reader);
}

const RISK_LABELS: Array<[string, string]> = [
  ["unread", "Aiden can’t read all of this command"],
  ["downloaded", "Runs a script from the internet"],
  ["deletes", "Deletes files"],
  ["admin", "Needs admin rights"],
  ["outside", "Uses files outside this project"],
  ["internet", "Uses the internet"],
  ["stops", "Stops programs"],
  ["power", "Shuts down or restarts the computer"],
];

/**
 * Aiden's own tags for a shell command: what it would do that the person
 * should know, read from the command text alone. Risky tags come first and are
 * never dropped; calm ones fill what room is left.
 */
export function commandTags(command: string, options: { workspaceRoot?: string; home?: string } = {}): CommandTag[] {
  const reader: Reader = {
    ...(options.workspaceRoot ? { root: options.workspaceRoot } : {}),
    ...(options.home ? { home: options.home.replace(/\/+$/u, "") } : {}),
    found: new Set(),
    calm: new Map(),
    depth: 0,
  };
  if (command.length > COMMAND_READING_LIMITS.command) reader.found.add("unread");
  else readCommands(command, reader);
  const risky = RISK_LABELS.filter(([key]) => reader.found.has(key)).map(([, label]) => ({ label, tone: "risk" as const }));
  const room = Math.max(0, COMMAND_READING_LIMITS.tags - risky.length);
  const calm = [...reader.calm.keys()].slice(0, room).map((label) => ({ label: clip(label, COMMAND_READING_LIMITS.tagLabel), tone: "calm" as const }));
  return [...risky, ...calm];
}

/** The plain-words reading for one approval: the model's description and Aiden's tags. */
export function commandReading(
  command: string,
  description: unknown,
  options: { workspaceRoot?: string; home?: string } = {},
): CommandReading {
  const explanation = commandExplanation(description);
  return { ...(explanation ? { explanation } : {}), tags: commandTags(command, options) };
}

/**
 * The reading for a tool call that needs approval, when the call runs a shell
 * command (`run_command`). Anything else has none.
 */
export function commandReadingForCall(
  toolName: string,
  args: unknown,
  options: { workspaceRoot?: string; home?: string } = {},
): CommandReading | undefined {
  if (toolName !== "run_command" || typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const { command, description } = args as Record<string, unknown>;
  if (typeof command !== "string" || !command.trim()) return undefined;
  return commandReading(command, description, options);
}

/** Validates a reading received over IPC or from a journal. Anything malformed is dropped, never repaired. */
export function parseCommandReading(value: unknown): CommandReading | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "explanation" && key !== "tags")) return undefined;
  if (!Array.isArray(record.tags) || record.tags.length > COMMAND_READING_LIMITS.tags) return undefined;
  const tags: CommandTag[] = [];
  for (const entry of record.tags as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const { label, tone, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return undefined;
    if (typeof label !== "string" || !label.trim() || [...label].length > COMMAND_READING_LIMITS.tagLabel) return undefined;
    if (tone !== "calm" && tone !== "risk") return undefined;
    tags.push({ label, tone });
  }
  if (record.explanation !== undefined) {
    const explanation = commandExplanation(record.explanation);
    if (!explanation || explanation !== record.explanation) return undefined;
    return { explanation, tags };
  }
  return { tags };
}
