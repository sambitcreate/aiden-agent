/**
 * Where a workspace artifact action may put page data, program by program.
 *
 * A `{{param}}` may sit only in a slot these tables list: the value of a
 * named option (`git commit -m {{msg}}`, `gh pr list --search {{q}}`) or an
 * operand position (`cat {{file}}`, `git switch {{branch}}`). Every other
 * position is refused, and so is any option the table does not know, since
 * an unknown option could change what the other words mean. Each slot has a
 * rule its value must pass on every run:
 *
 * - `text`: any text, though not starting with "-" unless the slot is a
 *   separate-word option value the program always takes as the value
 *   (`dash`), where git, grep, rg, jq and gh read even `--amend` as text;
 * - `number`: a whole number;
 * - `ref`: a branch or tag name as `git check-ref-format` allows one, which
 *   git cannot read as a force, delete, mapping, glob or path;
 * - `rev`: a git revision (`HEAD~2`, `main..feature`, `v1.0^`): like `ref`,
 *   but with revision syntax, and still no `:`, which would read a file from
 *   the repository root, no glob and no leading `.` or `/`;
 * - `target`: a gh number or name that does not point at another repository
 *   or a URL (gh repo view and list take no operand from page data, since it
 *   names the repository or owner);
 * - a GitHub search (`--search`) is text without a `repo:`, `org:` or
 *   `user:` qualifier, which would search past this repository;
 * - `path`: a file inside the workspace (also `test -e {{file}}` and test's
 *   other file operators, which would tell whether an outside path exists). In git it also has no `:` and no
 *   `* ? [`, which git reads as pathspec magic (`:/`, `:(top)`) or a glob
 *   that reaches past the workspace when it is a folder inside a repository.
 *
 * Pure and Electron-free; `workspace-artifact-template.ts` uses it.
 */

export type SlotRule = "text" | "number" | "ref" | "rev" | "path" | "target";

export interface Slot {
  rule: SlotRule;
  /** A value may start with "-": the program takes this word as the option's value whatever it holds. */
  dash?: boolean;
  /** A ref git push, fetch or pull sends or asks for: a value under `refs/` is refused too, since it could name any ref. */
  remote?: boolean;
  /**
   * A file joined after `REV:` in git (`git show HEAD:{{file}}`), which git
   * reads from the commit, not the disk. The checked plan writes `REV:./…`,
   * so git takes the path from the workspace rather than the repository root.
   */
  blob?: boolean;
  /**
   * A branch git reads as files when no branch has that name (`git checkout
   * {{branch}}` with a file name would discard its edits). The checked plan
   * adds `--` after it when the template has none, so git reads it as a
   * branch only.
   */
  refOnly?: boolean;
  /**
   * A GitHub search (`gh pr list --search {{q}}`): no `repo:`, `org:` or
   * `user:` qualifier, which would widen the search past this repository.
   */
  search?: boolean;
  /** A stash git stash show, apply, pop or drop reads: `stash@{n}` or `n` is allowed as well as a ref name. */
  stash?: boolean;
}

/** An option's value: a slot, a refusal clause ("which reads a file from anywhere"), or null when it takes no page data. */
type ValueEntry = Slot | string | null;

/**
 * What an operand may be: a slot, or a refusal (`as the remote git fetch
 * connects to`). `near(-1)` is the word before it and `near(1)` the word
 * after, undefined at either end or where a word holds a placeholder.
 */
type OperandRule = (
  index: number,
  afterDashes: boolean,
  has: (...names: string[]) => boolean,
  near: (offset: number) => string | undefined,
) => Slot | string;

export interface SlotSpec {
  /** How refusals name the command: "git commit", "gh pr list", "grep". */
  name: string;
  /** Short options that take no value, as letters. */
  flags?: string;
  /** Long options that take no value, without the leading `--`. */
  long?: readonly string[];
  /** Options that take a value, keyed by every spelling (`"-n --max-count"`). */
  values?: Readonly<Record<string, ValueEntry>>;
  /** `-5` means a count (`head -5`, `git log -1`). */
  digits?: boolean;
  /** The program reads no options: every word is an operand (`echo`, `printf`, `test`). */
  plain?: boolean;
  /** gh: a literal `--` is refused. */
  gh?: boolean;
  operand?: OperandRule;
  /** The operand forms, for messages ("files in the workspace"). */
  operandForms?: string;
  /** Verbs that must come first and be written literally (`git stash push`). */
  verbs?: Readonly<Record<string, SlotSpec>>;
  /** The verb used when the first word is an option or there is none (`git stash -m x` is `push`). */
  implicitVerb?: string;
}

const T: Slot = { rule: "text" };
const TD: Slot = { rule: "text", dash: true };
const SEARCH: Slot = { rule: "text", dash: true, search: true };
const N: Slot = { rule: "number" };
const R: Slot = { rule: "ref" };
const RO: Slot = { rule: "ref", refOnly: true };
const RR: Slot = { rule: "ref", remote: true };
const STASH: Slot = { rule: "ref", stash: true };
const V: Slot = { rule: "rev" };
const P: Slot = { rule: "path" };
const G: Slot = { rule: "target" };

const READS_ANY_FILE = "which reads a file from anywhere";
const WRITES_FILE = "which names a file to write";
const RUNS_PROGRAM = "which names a program to run";

// ---------------------------------------------------------------------------
// Plain programs.

const files = (forms = "files in the workspace") => ({ operand: () => P, operandForms: forms });
const text = { operand: () => T, operandForms: "text" };
const plain = (name: string): SlotSpec => ({ name, plain: true, ...text });

/** grep, rg and git grep: the first operand is the pattern unless -e or -f gave it; the rest are files. */
const searchOperands: Pick<SlotSpec, "operand" | "operandForms"> = {
  operand: (index, _afterDashes, has) => (index > 0 || has("-e", "-f") ? P : T),
  operandForms: "the pattern as text (when no -e or -f gives it), then files in the workspace",
};

/** test's operators whose operand is a file (`test -e {{file}}`); a value there could ask whether an outside path exists. */
const TEST_FILE_OPERATORS = new Set(["-e", "-f", "-d", "-r", "-w", "-x", "-s", "-L", "-h", "-b", "-c", "-p", "-S", "-g", "-u", "-k", "-O", "-G", "-N"]);
/** test's operators that compare two files (`test {{a}} -nt notes.md`). */
const TEST_FILE_PAIRS = new Set(["-nt", "-ot", "-ef"]);

const PROGRAM_SPECS: Readonly<Record<string, SlotSpec>> = {
  ls: { name: "ls", flags: "1aAlhrtSRdFGipcu", long: ["all", "almost-all", "human-readable", "recursive", "reverse"], ...files() },
  cat: { name: "cat", flags: "nbsvetuAET", ...files() },
  head: { name: "head", flags: "qv", digits: true, values: { "-n --lines": N, "-c --bytes": N }, ...files() },
  tail: { name: "tail", flags: "fFqrv", digits: true, values: { "-n --lines": N, "-c --bytes": N }, ...files() },
  wc: { name: "wc", flags: "lwcmL", long: ["lines", "words", "bytes", "chars", "max-line-length"], ...files() },
  grep: {
    name: "grep",
    flags: "rRnicLlwvFEGqhHosxzZbUaIP",
    long: [
      "recursive", "line-number", "ignore-case", "count", "files-with-matches", "files-without-match", "word-regexp", "invert-match", "fixed-strings",
      "extended-regexp", "basic-regexp", "quiet", "silent", "no-filename", "with-filename", "only-matching", "no-messages", "line-regexp", "null", "text",
      "color", "colour",
    ],
    values: {
      "-e --regexp": TD,
      "-f --file": P,
      "-m --max-count": N,
      "-A --after-context": N,
      "-B --before-context": N,
      "-C --context": N,
      "--include": T,
      "--exclude": T,
      "--exclude-dir": T,
    },
    ...searchOperands,
  },
  rg: {
    name: "rg",
    flags: "iSsnNlcvwxFUuHhLq0pzaPbo.I",
    long: [
      "json", "hidden", "no-ignore", "files", "count", "count-matches", "ignore-case", "smart-case", "case-sensitive", "fixed-strings", "line-number",
      "no-line-number", "files-with-matches", "files-without-match", "invert-match", "word-regexp", "line-regexp", "follow", "no-heading", "heading",
      "vimgrep", "only-matching", "multiline", "text", "unrestricted", "with-filename", "no-filename", "stats", "quiet", "trim", "column", "no-messages",
      "null", "pcre2", "search-zip", "byte-offset", "no-config",
    ],
    values: {
      "-e --regexp": TD,
      "-f --file": P,
      "-g --glob": T,
      "--iglob": T,
      "-t --type": T,
      "-T --type-not": T,
      "-m --max-count": N,
      "-A --after-context": N,
      "-B --before-context": N,
      "-C --context": N,
      "-d --max-depth": N,
      "-M --max-columns": N,
      "--color --colour": null,
      "--sort": null,
      "--sortr": null,
    },
    ...searchOperands,
  },
  sort: {
    name: "sort",
    flags: "bdfgiMhnRrsucCmzV",
    values: { "-k --key": T, "-t --field-separator": T, "-o --output": WRITES_FILE, "-T --temporary-directory": WRITES_FILE, "-S --buffer-size": null },
    ...files(),
  },
  uniq: {
    name: "uniq",
    flags: "cdiu",
    values: { "-f --skip-fields": N, "-s --skip-chars": N, "-w --check-chars": N },
    operand: (index) => (index === 0 ? P : "as the file uniq writes"),
    operandForms: "the one file it reads, in the workspace",
  },
  cut: {
    name: "cut",
    flags: "sn",
    long: ["complement", "only-delimited"],
    values: { "-f --fields": T, "-b --bytes": T, "-c --characters": T, "-d --delimiter": T, "--output-delimiter": T },
    ...files(),
  },
  tr: { name: "tr", flags: "cdsC", ...text },
  echo: plain("echo"),
  printf: plain("printf"),
  test: {
    name: "test",
    plain: true,
    operand: (_index, _afterDashes, _has, near) =>
      TEST_FILE_OPERATORS.has(near(-1) ?? "") || TEST_FILE_PAIRS.has(near(-1) ?? "") || TEST_FILE_PAIRS.has(near(1) ?? "") ? P : T,
    operandForms: "text, or a file in the workspace after -e, -f, -d and the other file tests",
  },
  true: plain("true"),
  false: plain("false"),
  date: { name: "date", flags: "uRj", values: { "-d --date": T, "-r --reference": READS_ANY_FILE, "-f --file": READS_ANY_FILE }, ...text },
  basename: { name: "basename", flags: "az", long: ["multiple", "zero"], values: { "-s --suffix": T }, ...text },
  dirname: { name: "dirname", flags: "z", long: ["zero"], ...text },
};

// ---------------------------------------------------------------------------
// git, by subcommand.

const refs = (forms = "branch or tag names") => ({ operand: () => R, operandForms: forms });
const revs = (forms: string) => ({ operand: () => V, operandForms: forms });
const LOG_LONG = [
  "oneline", "graph", "all", "decorate", "no-decorate", "stat", "shortstat", "numstat", "name-only", "name-status", "patch", "no-patch", "no-merges",
  "merges", "first-parent", "reverse", "follow", "abbrev-commit", "date-order", "topo-order", "author-date-order", "no-color", "raw", "full-history",
  "left-right", "cherry-pick", "cherry-mark", "regexp-ignore-case", "all-match", "invert-grep", "fixed-strings", "extended-regexp", "basic-regexp",
  "perl-regexp", "source", "tags", "branches", "remotes", "summary", "color",
];
const LOG_VALUES: Record<string, ValueEntry> = {
  "-n --max-count": N,
  "--skip": N,
  "--author": T,
  "--committer": T,
  "--grep": T,
  "--since": T,
  "--after": T,
  "--until": T,
  "--before": T,
  "-S": T,
  "-G": T,
  "-L": null,
  "-O": READS_ANY_FILE,
  "--format": null,
  "--pretty": null,
  "--date": null,
};
const logLike = (name: string): SlotSpec => ({
  name,
  flags: "pcmsuziEFP",
  long: LOG_LONG,
  values: LOG_VALUES,
  digits: true,
  operand: (_index, afterDashes) => (afterDashes ? P : V),
  operandForms: "revisions, and files in the workspace after --",
});

/** fetch and pull: the first operand is the remote, which can be a URL, a path or a transport that runs a command. */
const remoteOperands = (sub: string): Pick<SlotSpec, "operand" | "operandForms"> => ({
  operand: (index, _afterDashes, has) => {
    if (has("--multiple", "--all")) return `as an operand of git ${sub} with --multiple or --all, where every operand is a remote to connect to`;
    return index === 0 ? `as the remote git ${sub} connects to (write it literally, such as origin)` : RR;
  },
  operandForms: "branch names after a literal remote (git " + sub + " origin {{branch}})",
});
const FETCH_LONG = [
  "quiet", "verbose", "prune", "prune-tags", "tags", "no-tags", "force", "append", "all", "multiple", "dry-run", "atomic", "update-head-ok", "keep",
  "progress", "unshallow", "recurse-submodules", "no-recurse-submodules", "set-upstream", "ipv4", "ipv6", "write-fetch-head", "no-write-fetch-head",
];
const FETCH_VALUES: Record<string, ValueEntry> = {
  "--depth": N,
  "--deepen": N,
  "-j --jobs": N,
  "--refmap": "which maps fetched refs onto local ones",
  "-o --server-option": null,
  "--shallow-since": null,
  "--shallow-exclude": null,
  "--negotiation-tip": null,
  "--filter": null,
  "--upload-pack": RUNS_PROGRAM,
};
/** git branch and tag filters that take a commit (`--merged main`); each also turns on list mode. */
const REACH_FILTERS: Record<string, ValueEntry> = { "--merged": R, "--no-merged": R, "--contains": R, "--no-contains": R };
const REACH_FILTER_NAMES = Object.keys(REACH_FILTERS);
/**
 * A pattern git branch or tag lists by (`--list 'feat/*'`): text, with no
 * leading "-". Only in list mode with none of the options that create,
 * delete, rename or retarget a ref, where an operand is a name instead.
 */
const LIST_PATTERN = T;
const BRANCH_CHANGES = [
  "-d", "-D", "-m", "-M", "-c", "-C", "-f", "-t", "-u", "--delete", "--move", "--copy", "--force", "--track", "--no-track", "--set-upstream-to",
  "--unset-upstream",
];
const TAG_CHANGES = ["-a", "-d", "-f", "-m", "-F", "-u", "--annotate", "--delete", "--force", "--message", "--file", "--local-user"];
const PICK_VALUES: Record<string, ValueEntry> = { "-m --mainline": N, "-X --strategy-option": RUNS_PROGRAM, "--strategy": RUNS_PROGRAM };

const GIT_SPECS: Readonly<Record<string, SlotSpec>> = {
  status: {
    name: "git status",
    flags: "sbuvz",
    long: ["short", "branch", "porcelain", "long", "ignored", "untracked-files", "ahead-behind", "no-ahead-behind", "renames", "no-renames", "show-stash"],
    ...files(),
  },
  log: logLike("git log"),
  show: logLike("git show"),
  diff: {
    name: "git diff",
    flags: "pusbwRazMC",
    long: [
      "stat", "shortstat", "numstat", "name-only", "name-status", "cached", "staged", "patch", "no-patch", "no-color", "quiet", "exit-code",
      "ignore-all-space", "ignore-space-change", "text", "minimal", "histogram", "patience", "color", "word-diff", "merge-base", "find-renames",
      "find-copies",
    ],
    values: { "-O": READS_ANY_FILE, "--output": WRITES_FILE, "-U --unified": N, "--diff-filter": null },
    ...files("revisions or files in the workspace"),
  },
  branch: {
    name: "git branch",
    flags: "avrdDmMcClfqt",
    long: ["list", "all", "remotes", "verbose", "delete", "move", "copy", "force", "quiet", "show-current", "track", "no-track", "unset-upstream"],
    values: { "-u --set-upstream-to": R, ...REACH_FILTERS, "--sort": null },
    operand: (_index, _afterDashes, has) =>
      has("-l", "--list", "-v", "--verbose", ...REACH_FILTER_NAMES) && !has(...BRANCH_CHANGES) ? LIST_PATTERN : R,
    operandForms: "branch names, or a pattern (text) with --list, -v, --merged or --contains",
  },
  switch: {
    name: "git switch",
    flags: "dfqmt",
    long: ["detach", "discard-changes", "force", "merge", "quiet", "track", "no-track", "guess", "no-guess"],
    values: { "-c --create": R, "-C --force-create": R, "--orphan": R },
    ...refs(),
  },
  checkout: {
    name: "git checkout",
    flags: "qfmt",
    long: ["quiet", "force", "merge", "detach", "track", "no-track", "ours", "theirs"],
    values: { "-b": R, "-B": R, "--orphan": R },
    operand: (index, afterDashes) => (index === 0 && !afterDashes ? RO : P),
    operandForms: "a branch first, then files in the workspace",
  },
  fetch: { name: "git fetch", flags: "qvpPtfanu46", long: FETCH_LONG, values: FETCH_VALUES, ...remoteOperands("fetch") },
  pull: {
    name: "git pull",
    flags: "qvrnf46",
    long: [
      "quiet", "verbose", "rebase", "no-rebase", "ff", "no-ff", "ff-only", "squash", "no-squash", "commit", "no-commit", "autostash", "no-autostash",
      "stat", "no-stat", "all", "prune", "tags", "no-tags", "force", "dry-run", "unshallow",
    ],
    values: { ...FETCH_VALUES, "-s --strategy": RUNS_PROGRAM, "-X --strategy-option": RUNS_PROGRAM },
    ...remoteOperands("pull"),
  },
  push: {
    name: "git push",
    flags: "qvfnud46",
    long: [
      "quiet", "verbose", "force", "force-with-lease", "dry-run", "set-upstream", "delete", "tags", "follow-tags", "no-verify", "atomic", "porcelain",
      "progress", "no-progress", "force-if-includes",
    ],
    values: { "--repo": "which names the remote to connect to", "--receive-pack": RUNS_PROGRAM, "--exec": RUNS_PROGRAM, "-o --push-option": null },
    operand: (index) => (index === 0 ? "as the remote git push connects to (write it literally, such as origin)" : RR),
    operandForms: "branch names after a literal remote (git push origin {{branch}})",
  },
  add: { name: "git add", flags: "AnvfuN", long: ["all", "update", "dry-run", "force", "verbose", "intent-to-add", "ignore-errors", "renormalize"], ...files() },
  restore: {
    name: "git restore",
    flags: "SWq",
    long: ["staged", "worktree", "quiet", "ours", "theirs", "merge", "ignore-unmerged"],
    values: { "-s --source": V },
    ...files(),
  },
  commit: {
    name: "git commit",
    flags: "aqvns",
    long: [
      "all", "amend", "no-edit", "allow-empty", "allow-empty-message", "quiet", "verbose", "no-verify", "signoff", "only", "include", "dry-run", "short",
      "porcelain", "no-status",
    ],
    values: {
      "-m --message": TD,
      "-F --file": READS_ANY_FILE,
      "-t --template": READS_ANY_FILE,
      "-C --reuse-message": null,
      "-c --reedit-message": null,
      "--author": null,
      "--date": null,
      "--fixup": null,
      "--squash": null,
      "--trailer": null,
      "--cleanup": null,
    },
    ...files(),
  },
  reset: {
    name: "git reset",
    flags: "q",
    long: ["soft", "mixed", "hard", "keep", "merge", "quiet"],
    operand: (index, afterDashes) => (index === 0 && !afterDashes ? V : P),
    operandForms: "a commit first, then files in the workspace",
  },
  tag: {
    name: "git tag",
    flags: "adlfn",
    long: ["annotate", "delete", "list", "force"],
    values: { "-m --message": TD, "-F --file": READS_ANY_FILE, "-u --local-user": null, ...REACH_FILTERS, "--sort": null },
    operand: (_index, _afterDashes, has) => (has("-l", "--list", "-n", ...REACH_FILTER_NAMES) && !has(...TAG_CHANGES) ? LIST_PATTERN : R),
    operandForms: "tag names, or a pattern (text) with -l/--list, -n, --merged or --contains",
  },
  stash: {
    name: "git stash",
    implicitVerb: "push",
    verbs: {
      push: {
        name: "git stash push",
        flags: "ukaqS",
        long: ["keep-index", "no-keep-index", "include-untracked", "all", "quiet", "staged"],
        values: { "-m --message": TD, "--pathspec-from-file": READS_ANY_FILE },
        ...files(),
      },
      ...Object.fromEntries(
        ["show", "apply", "pop", "drop"].map((verb) => [
          verb,
          {
            name: `git stash ${verb}`,
            flags: verb === "show" ? "qp" : "q",
            long: ["index", "quiet", "stat", "patch", "name-only", "include-untracked"],
            operand: (index: number) => (index === 0 ? STASH : `as a second argument to git stash ${verb}`),
            operandForms: "one stash name (stash@{n}, n, or a branch or tag name)",
          } satisfies SlotSpec,
        ]),
      ),
      branch: { name: "git stash branch", ...refs("a branch name, then a stash name") },
      list: { name: "git stash list" },
    },
  },
  worktree: {
    name: "git worktree",
    verbs: {
      list: { name: "git worktree list" },
      add: {
        name: "git worktree add",
        flags: "fq",
        long: ["force", "detach", "checkout", "no-checkout", "lock", "quiet", "track", "no-track", "guess-remote", "orphan"],
        values: { "-b": R, "-B": R, "--reason": null },
        operand: () => "as the path or commit git worktree add uses (write it literally; a {{param}} may follow -b or -B)",
      },
      remove: { name: "git worktree remove", flags: "f", long: ["force"] },
    },
  },
  remote: { name: "git remote", flags: "v", long: ["verbose"] },
  "rev-parse": {
    name: "git rev-parse",
    flags: "q",
    long: [
      "verify", "quiet", "short", "abbrev-ref", "symbolic", "symbolic-full-name", "show-toplevel", "git-dir", "absolute-git-dir", "is-inside-work-tree",
      "is-bare-repository", "show-prefix", "show-cdup", "all", "branches", "tags", "remotes",
    ],
    ...text,
  },
  merge: {
    name: "git merge",
    flags: "qvn",
    long: [
      "no-ff", "ff", "ff-only", "squash", "no-squash", "commit", "no-commit", "no-edit", "abort", "continue", "quit", "quiet", "verbose", "stat",
      "no-stat", "autostash", "no-autostash", "allow-unrelated-histories", "no-verify",
    ],
    values: { "-m --message": TD, "-s --strategy": RUNS_PROGRAM, "-X --strategy-option": RUNS_PROGRAM, "-F --file": READS_ANY_FILE },
    ...refs(),
  },
  rebase: {
    name: "git rebase",
    flags: "qv",
    long: ["abort", "continue", "skip", "quit", "autostash", "no-autostash", "quiet", "verbose", "keep-empty", "root", "autosquash", "no-autosquash", "update-refs", "no-update-refs"],
    values: { "--onto": R, "-x --exec": RUNS_PROGRAM, "-s --strategy": RUNS_PROGRAM, "-X --strategy-option": RUNS_PROGRAM },
    ...refs(),
  },
  "cherry-pick": {
    name: "git cherry-pick",
    flags: "nsx",
    long: ["no-commit", "signoff", "abort", "continue", "skip", "quit", "ff", "allow-empty", "keep-redundant-commits"],
    values: PICK_VALUES,
    ...revs("commits"),
  },
  revert: {
    name: "git revert",
    flags: "ns",
    long: ["no-commit", "signoff", "abort", "continue", "skip", "quit", "no-edit"],
    values: PICK_VALUES,
    ...revs("commits"),
  },
  grep: {
    name: "git grep",
    flags: "inwvlLcEFGPhHIoqzrapW",
    long: [
      "cached", "untracked", "ignore-case", "word-regexp", "invert-match", "files-with-matches", "files-without-match", "count", "extended-regexp",
      "fixed-strings", "basic-regexp", "perl-regexp", "line-number", "column", "full-name", "heading", "break", "show-function", "function-context",
      "only-matching", "quiet", "null", "text", "and", "or", "not", "all-match", "recurse-submodules", "exclude-standard", "no-exclude-standard",
      "recursive", "no-recursive",
    ],
    values: {
      "-e": TD,
      "-f": P,
      "-m --max-count": N,
      "-A --after-context": N,
      "-B --before-context": N,
      "-C --context": N,
      "--max-depth": N,
      "--threads": N,
    },
    ...searchOperands,
  },
  blame: {
    name: "git blame",
    flags: "selwptfncbCM",
    long: ["porcelain", "line-porcelain", "incremental", "root", "show-stats", "show-name", "show-number", "show-email", "minimal"],
    values: { "-L": T, "--contents": READS_ANY_FILE, "-S": READS_ANY_FILE, "--ignore-revs-file": READS_ANY_FILE, "--date": null },
    ...files("a revision or files in the workspace"),
  },
  "ls-files": {
    name: "git ls-files",
    flags: "cdmoisukztv",
    long: [
      "cached", "deleted", "modified", "others", "ignored", "stage", "unmerged", "killed", "directory", "no-empty-directory", "full-name", "error-unmatch",
      "exclude-standard", "eol", "recurse-submodules",
    ],
    values: { "-x --exclude": T, "-X --exclude-from": READS_ANY_FILE, "--exclude-per-directory": READS_ANY_FILE, "--with-tree": null, "--format": null },
    ...files(),
  },
};

// ---------------------------------------------------------------------------
// gh, by group and verb. pflag takes the word after a value option as its
// value whatever it holds, so those values may start with "-".

const GH_REPO: Record<string, ValueEntry> = { "-R --repo": "which points the command at another repository" };
const GH_EXPORT: Record<string, ValueEntry> = {
  "--json": null,
  "-q --jq": "which runs a jq program that can read the environment",
  "-t --template": "which runs a template that can read the environment",
};
const GH_BODY_FILE: Record<string, ValueEntry> = { "-F --body-file": "which reads a file from anywhere and posts it" };
const one = (name: string): Pick<SlotSpec, "operand" | "operandForms"> => ({
  operand: (index) => (index === 0 ? G : `as a second argument to ${name}`),
  operandForms: "a number, branch or name",
});
const none = (name: string): Pick<SlotSpec, "operand"> => ({ operand: () => `as an argument to ${name}, which takes none` });
/** gh repo view and list: the operand names a repository or owner, so a value could read any repository or organisation. */
const repository = (name: string): Pick<SlotSpec, "operand"> => ({
  operand: () => `as the repository or owner ${name} reads, which could name any repository or organisation (write it literally, or leave it out for this repository)`,
});
const gh = (name: string, spec: Omit<SlotSpec, "name" | "gh">, operands: "one" | "none" | "repository" = "one"): SlotSpec => ({
  name,
  gh: true,
  ...spec,
  long: [...(spec.long ?? []), "help"],
  ...(operands === "one" ? one(name) : operands === "none" ? none(name) : repository(name)),
});
const SEARCHES: Record<string, ValueEntry> = { "-S --search": SEARCH, "-l --label": TD, "-a --assignee": TD, "-A --author": TD, "-s --state": T, "--app": T, "-L --limit": N };
const COMMENT: Record<string, ValueEntry> = { ...GH_REPO, "-b --body": TD, ...GH_BODY_FILE };
const COMMENT_LONG = ["web", "edit-last", "create-if-none", "delete-last", "yes"];
const editValues = (extra: Record<string, ValueEntry>): Record<string, ValueEntry> => ({
  ...GH_REPO,
  "-t --title": TD,
  "-b --body": TD,
  ...GH_BODY_FILE,
  "--add-label": TD,
  "--remove-label": TD,
  "--add-assignee": TD,
  "--remove-assignee": TD,
  "--add-project": TD,
  "--remove-project": TD,
  "-m --milestone": TD,
  ...extra,
});
const createValues = (extra: Record<string, ValueEntry>): Record<string, ValueEntry> => ({
  ...GH_REPO,
  "-t --title": TD,
  "-b --body": TD,
  "-l --label": TD,
  "-a --assignee": TD,
  "-m --milestone": TD,
  "-p --project": TD,
  ...GH_BODY_FILE,
  "-T --template": "which reads a template file",
  "--recover": "which reads a file from anywhere",
  ...extra,
});

const GH_SPECS: Readonly<Record<string, SlotSpec>> = {
  "pr view": gh("gh pr view", { flags: "wc", long: ["web", "comments"], values: { ...GH_REPO, ...GH_EXPORT } }),
  "pr list": gh(
    "gh pr list",
    { flags: "wd", long: ["web", "draft"], values: { ...GH_REPO, ...GH_EXPORT, ...SEARCHES, "-B --base": R, "-H --head": R } },
    "none",
  ),
  "pr status": gh("gh pr status", { flags: "c", long: ["conflict-status"], values: { ...GH_REPO, ...GH_EXPORT } }, "none"),
  "pr diff": gh("gh pr diff", { flags: "w", long: ["name-only", "patch", "web"], values: { ...GH_REPO, "--color": null } }),
  "pr checks": gh("gh pr checks", { flags: "w", long: ["watch", "fail-fast", "required", "web"], values: { ...GH_REPO, ...GH_EXPORT, "-i --interval": N } }),
  "pr checkout": gh("gh pr checkout", { flags: "f", long: ["force", "detach", "recurse-submodules"], values: { ...GH_REPO, "-b --branch": R } }),
  "pr create": gh(
    "gh pr create",
    {
      flags: "dfw",
      long: ["draft", "fill", "fill-first", "fill-verbose", "web", "no-maintainer-edit", "dry-run"],
      values: createValues({ "-r --reviewer": TD, "-B --base": R, "-H --head": R }),
    },
    "none",
  ),
  "pr edit": gh("gh pr edit", { values: editValues({ "-B --base": R, "--add-reviewer": TD, "--remove-reviewer": TD }) }),
  "pr ready": gh("gh pr ready", { long: ["undo"], values: GH_REPO }),
  "pr merge": gh("gh pr merge", {
    flags: "msrd",
    long: ["merge", "squash", "rebase", "delete-branch", "auto", "disable-auto", "admin"],
    values: { ...GH_REPO, "-t --subject": TD, "-b --body": TD, ...GH_BODY_FILE, "--match-head-commit": T, "-A --author-email": null },
  }),
  "pr comment": gh("gh pr comment", { flags: "w", long: COMMENT_LONG, values: COMMENT }),
  "pr review": gh("gh pr review", { flags: "arc", long: ["approve", "request-changes", "comment"], values: COMMENT }),
  "pr close": gh("gh pr close", { flags: "d", long: ["delete-branch"], values: { ...GH_REPO, "-c --comment": TD } }),
  "pr reopen": gh("gh pr reopen", { values: { ...GH_REPO, "-c --comment": TD } }),
  "issue view": gh("gh issue view", { flags: "wc", long: ["web", "comments"], values: { ...GH_REPO, ...GH_EXPORT } }),
  "issue list": gh(
    "gh issue list",
    { flags: "w", long: ["web"], values: { ...GH_REPO, ...GH_EXPORT, ...SEARCHES, "--mention": TD, "-m --milestone": TD } },
    "none",
  ),
  "issue status": gh("gh issue status", { values: { ...GH_REPO, ...GH_EXPORT } }, "none"),
  "issue create": gh("gh issue create", { flags: "w", long: ["web"], values: createValues({}) }, "none"),
  "issue edit": gh("gh issue edit", { long: ["remove-milestone"], values: editValues({}) }),
  "issue comment": gh("gh issue comment", { flags: "w", long: COMMENT_LONG, values: COMMENT }),
  "issue close": gh("gh issue close", { values: { ...GH_REPO, "-c --comment": TD, "-r --reason": T } }),
  "issue reopen": gh("gh issue reopen", { values: { ...GH_REPO, "-c --comment": TD } }),
  "run view": gh("gh run view", {
    flags: "vw",
    long: ["verbose", "log", "log-failed", "exit-status", "web"],
    values: { ...GH_REPO, ...GH_EXPORT, "-j --job": N, "-a --attempt": N },
  }),
  "run list": gh(
    "gh run list",
    {
      flags: "a",
      long: ["all"],
      values: { ...GH_REPO, ...GH_EXPORT, "-L --limit": N, "-b --branch": R, "-w --workflow": T, "-u --user": T, "-s --status": T, "-e --event": T, "-c --commit": T, "--created": T },
    },
    "none",
  ),
  "run watch": gh("gh run watch", { long: ["exit-status", "compact"], values: { ...GH_REPO, "-i --interval": N } }),
  "run rerun": gh("gh run rerun", { flags: "d", long: ["failed", "debug"], values: { ...GH_REPO, "-j --job": N } }),
  "run cancel": gh("gh run cancel", { values: GH_REPO }),
  "repo view": gh("gh repo view", { flags: "w", long: ["web"], values: { ...GH_EXPORT, "-b --branch": R } }, "repository"),
  "repo list": gh(
    "gh repo list",
    { long: ["fork", "source", "archived", "no-archived"], values: { ...GH_EXPORT, "-L --limit": N, "-l --language": T, "--topic": T, "--visibility": T } },
    "repository",
  ),
  "release view": gh("gh release view", { flags: "w", long: ["web"], values: { ...GH_REPO, ...GH_EXPORT } }),
  "release list": gh(
    "gh release list",
    { long: ["exclude-drafts", "exclude-pre-releases"], values: { ...GH_REPO, ...GH_EXPORT, "-L --limit": N, "-O --order": T } },
    "none",
  ),
  "label list": gh(
    "gh label list",
    { flags: "w", long: ["web"], values: { ...GH_REPO, ...GH_EXPORT, "-S --search": SEARCH, "-L --limit": N, "--sort": T, "--order": T } },
    "none",
  ),
  "workflow view": gh("gh workflow view", { flags: "wy", long: ["web", "yaml"], values: { ...GH_REPO, "-r --ref": R } }),
  "workflow list": gh("gh workflow list", { flags: "a", long: ["all"], values: { ...GH_REPO, ...GH_EXPORT, "-L --limit": N } }, "none"),
  browse: gh("gh browse", {
    flags: "cnprsw",
    long: ["commit", "no-browser", "projects", "releases", "settings", "wiki", "actions"],
    values: { ...GH_REPO, "-b --branch": R },
  }),
  status: gh("gh status", { values: { "-e --exclude": T, "-o --org": T } }, "none"),
};

// ---------------------------------------------------------------------------
// Lookup and the walk.

/** The table for a plain program, a git subcommand or a gh command (`"pr view"`, `"browse"`). */
export function programSlotSpec(program: string): SlotSpec | undefined {
  return Object.prototype.hasOwnProperty.call(PROGRAM_SPECS, program) ? PROGRAM_SPECS[program] : undefined;
}
export function gitSlotSpec(subcommand: string): SlotSpec | undefined {
  return Object.prototype.hasOwnProperty.call(GIT_SPECS, subcommand) ? GIT_SPECS[subcommand] : undefined;
}
export function ghSlotSpec(command: string): SlotSpec | undefined {
  return Object.prototype.hasOwnProperty.call(GH_SPECS, command) ? GH_SPECS[command] : undefined;
}

interface CompiledValue {
  entry: ValueEntry;
  /** Every spelling of the option, so `has("-e")` also sees `--regexp`. */
  names: readonly string[];
}

const compiledValues = new WeakMap<SlotSpec, Map<string, CompiledValue>>();
function valuesOf(spec: SlotSpec): Map<string, CompiledValue> {
  let map = compiledValues.get(spec);
  if (!map) {
    map = new Map();
    for (const [key, entry] of Object.entries(spec.values ?? {})) {
      const names = key.split(" ");
      for (const name of names) map.set(name, { entry, names });
    }
    compiledValues.set(spec, map);
  }
  return map;
}

type Position =
  | { kind: "option" }
  | { kind: "value"; option: string; entry: ValueEntry }
  | { kind: "operand"; index: number; afterDashes: boolean };

/** `args` are the command's words, `undefined` where a word holds a placeholder. */
type Args = readonly (string | undefined)[];

/**
 * Reads `args` from `from` the way the program would: past each option the
 * table knows and the value of those that take one, counting operands, with
 * everything after a literal `--` an operand. Refuses an option the table
 * does not know, wherever it is, since it could change what the rest mean.
 */
function walk(spec: SlotSpec, args: Args, from: number): { positions: Map<number, Position>; has: Set<string> } | { problem: string } {
  const values = valuesOf(spec);
  const positions = new Map<number, Position>();
  const has = new Set<string>();
  const unknown = (option: string) => ({
    problem: `to ${spec.name} with ${option}, an option Aiden does not check there (remove it; the rest of the command still works). ${checkedOptions(spec)}`,
  });
  let ended = false;
  let operand = 0;
  for (let index = from; index < args.length; index += 1) {
    const arg = args[index];
    if (!ended && !spec.plain && arg === "--") {
      if (spec.gh) return { problem: `to ${spec.name} with a literal --` };
      ended = true;
      positions.set(index, { kind: "option" });
      continue;
    }
    if (ended || spec.plain || arg === undefined || arg === "-" || !arg.startsWith("-")) {
      positions.set(index, { kind: "operand", index: operand, afterDashes: ended });
      operand += 1;
      continue;
    }
    positions.set(index, { kind: "option" });
    if (spec.digits && /^-\d+$/u.test(arg)) continue;
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals < 0 ? arg : arg.slice(0, equals);
      const valued = values.get(name);
      if (valued) {
        for (const spelling of valued.names) has.add(spelling);
        if (equals < 0 && index + 1 < args.length) {
          positions.set(index + 1, { kind: "value", option: name, entry: valued.entry });
          index += 1;
        }
        continue;
      }
      if (spec.long?.includes(name.slice(2))) {
        has.add(name);
        continue;
      }
      return unknown(name);
    }
    const letters = [...arg.slice(1)];
    for (let at = 0; at < letters.length; at += 1) {
      const name = `-${letters[at]!}`;
      const valued = values.get(name);
      if (valued) {
        for (const spelling of valued.names) has.add(spelling);
        // Last in the word, it takes the next word; otherwise the rest of this one.
        if (at === letters.length - 1 && index + 1 < args.length) {
          positions.set(index + 1, { kind: "value", option: name, entry: valued.entry });
          index += 1;
        }
        break;
      }
      if (!spec.flags?.includes(letters[at]!)) return unknown(name);
      has.add(name);
    }
  }
  return { positions, has };
}

export type SlotLookup = { slot: Slot } | { problem: string };

/**
 * The slot of the placeholder word at `at`, reading `args` from `from` with
 * `spec`, or where it sits when no slot is there ("after --refmap, which …").
 * Verbs (`git stash push`) are read first and must be literal.
 */
export function locateSlot(spec: SlotSpec, args: Args, from: number, at: number): SlotLookup {
  if (spec.verbs) {
    const verb = args[from];
    const verbs = Object.keys(spec.verbs).join(", ");
    if (verb === undefined && from < args.length) return { problem: `as the ${spec.name} verb. Write the verb literally: ${verbs}.` };
    if (verb !== undefined && Object.prototype.hasOwnProperty.call(spec.verbs, verb)) return locateSlot(spec.verbs[verb]!, args, from + 1, at);
    if (spec.implicitVerb && (verb === undefined || verb.startsWith("-"))) return locateSlot(spec.verbs[spec.implicitVerb]!, args, from, at);
    return { problem: `to ${spec.name} ${verb ?? ""}, a verb Aiden does not check. ${spec.name} takes page data only after a literal verb: ${verbs}.` };
  }
  const found = locateIn(spec, args, from, at);
  return "problem" in found ? { problem: `${found.problem}. ${allowedSlotForms(spec)}` } : found;
}

function locateIn(spec: SlotSpec, args: Args, from: number, at: number): SlotLookup {
  const read = walk(spec, args, from);
  if ("problem" in read) return read;
  const position = read.positions.get(at);
  if (!position || position.kind === "option") return { problem: `as an option of ${spec.name}` };
  if (position.kind === "value") {
    const { entry, option } = position;
    if (entry === null) return { problem: `after ${option}` };
    if (typeof entry === "string") return { problem: `after ${option}, ${entry}` };
    return { slot: entry };
  }
  const has = (...names: string[]) => names.some((name) => read.has.has(name));
  const near = (offset: number) => args[at + offset];
  const rule = spec.operand ? spec.operand(position.index, position.afterDashes, has, near) : `as an argument to ${spec.name}`;
  return typeof rule === "string" ? { problem: rule } : { slot: rule };
}

const JQ_FLAGS = "nrjascCMSeRh";
const JQ_LONG = [
  "null-input", "raw-output", "join-output", "ascii-output", "slurp", "compact-output", "color-output", "monochrome-output", "sort-keys", "exit-status",
  "raw-input", "seq", "stream", "tab", "raw-output0", "help",
];
const JQ_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const JQ_FILTER = "as a jq filter or file";

/**
 * jq's slot: only the value after `--arg NAME` or `--argjson NAME`, with a
 * literal variable name. A filter can read any file (`input`, `$__loc__`)
 * and the options that load modules or files (`-L`, `-f`, `--rawfile`,
 * `--slurpfile`) or turn operands into values (`--args`) are refused.
 */
export function jqSlot(args: Args, at: number): SlotLookup {
  const found = jqSlotIn(args, at);
  return "problem" in found ? { problem: `${found.problem}. ${JQ_SLOT_FORMS}` } : found;
}

function jqSlotIn(args: Args, at: number): SlotLookup {
  let slot: SlotLookup = { problem: JQ_FILTER };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "-" || !arg.startsWith("-")) continue;
    if (arg === "--arg" || arg === "--argjson") {
      const name = args[index + 1];
      if (name === undefined || !JQ_VARIABLE.test(name)) return { problem: `as a jq ${arg} name, or after one that is not a literal variable name` };
      if (index + 2 === at) slot = { slot: TD };
      index += 2;
      continue;
    }
    if (arg === "--indent") {
      if (index + 1 === at) slot = { slot: N };
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      if (!JQ_LONG.includes(arg.slice(2))) return { problem: `to jq with ${arg}, an option Aiden does not check there` };
      continue;
    }
    const letter = [...arg.slice(1)].find((char) => !JQ_FLAGS.includes(char));
    if (letter !== undefined) return { problem: `to jq with -${letter}, an option Aiden does not check there` };
  }
  return slot;
}

const RULE_TEXT: Record<SlotRule, string> = {
  text: "text",
  number: "a whole number",
  ref: "a branch or tag name",
  rev: "a revision",
  path: "a file in the workspace",
  target: "a number, branch or name",
};

function describe(slot: Slot): string {
  if (slot.stash) return "a stash name (stash@{n} or n) or a branch or tag name";
  return slot.dash ? `${RULE_TEXT[slot.rule]}, which may start with -` : RULE_TEXT[slot.rule];
}

const LISTED_OPTIONS = 24;

/** The options Aiden reads for a command, for a refusal of one it does not: "Options it checks: -p, --stat, … and 12 more". */
function checkedOptions(spec: SlotSpec): string {
  const names = [
    ...[...(spec.flags ?? "")].map((letter) => `-${letter}`),
    ...(spec.long ?? []).map((name) => `--${name}`),
    ...Object.keys(spec.values ?? {}).flatMap((key) => key.split(" ")),
  ];
  if (names.length === 0) return `${spec.name} takes no options here`;
  const shown = names.slice(0, LISTED_OPTIONS).join(", ");
  return `Options it checks: ${shown}${names.length > LISTED_OPTIONS ? ` and ${names.length - LISTED_OPTIONS} more` : ""}`;
}

/** The forms a command takes page data in, for a refusal: "git commit takes page data only as: -m/--message {{x}} (text, …); operands: …". */
function allowedSlotForms(spec: SlotSpec): string {
  if (spec.verbs) return `${spec.name} takes page data only after a literal verb (${Object.keys(spec.verbs).join(", ")}).`;
  const forms: string[] = [];
  for (const [key, entry] of Object.entries(spec.values ?? {})) {
    if (entry !== null && typeof entry === "object") forms.push(`${key.split(" ").join("/")} {{x}} (${describe(entry)})`);
  }
  if (spec.operandForms) forms.push(`operands: ${spec.operandForms}`);
  return forms.length ? `${spec.name} takes page data only as: ${forms.join("; ")}.` : `${spec.name} takes no page data.`;
}

const JQ_SLOT_FORMS = "jq takes page data only as --arg NAME {{x}} or --argjson NAME {{x}}, read in the filter as $NAME.";
