/**
 * Reads, lints and caches an app's DESIGN.md (spec §6.9, R3, S44).
 *
 * The file is resolved inside the workspace's real path, sized with `lstat`
 * (over 64 KiB is `too-large` and never linted), then read with 2a's bounded,
 * no-follow read, so a swap between the two fails closed as `unreadable`. The
 * lint runs in the worker; Aiden adds the two checks 0.4.0 lacks (duplicate
 * sections, unresolved token-group references). Results are cached by real
 * path and content hash, so an unchanged file is linted once per run.
 */
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../../../shared/path-containment.js";
import { countBucket } from "../../analytics/analytics-sanitize.js";
import { readBounded } from "../app-server/app-detect.js";
import {
  runDesignMdWorker,
  type DesignMdExportFormat,
  type DesignMdFinding,
  type DesignMdLintResult,
  type LintFailureStatus,
} from "./lint-client.js";
import type { DesignMdSource, LocatedDesignMd } from "./locate.js";
import { canonicalSection } from "./sections.js";

export const DESIGN_MD_MAX_BYTES = 65_536;
const MAX_TOKENS = 300;
const MAX_VALUE_CHARS = 200;
const MAX_MESSAGE_CHARS = 300;
const DEFAULT_MAX_ENTRIES = 16;
const UNRESOLVED_REF = /^\{[^}]+\}$/;

export type DesignMdToken = { path: string; kind: string; value: string };
export type DesignMdSummary = { errors: number; warnings: number; infos: number };

type FileFields = { path: string; source: DesignMdSource };
export type DesignMdOkState = FileFields & {
  status: "ok";
  hash: string;
  summary: DesignMdSummary;
  findings: DesignMdFinding[];
  sections: string[];
  omitted: { section: string; reason?: string }[];
  tokens: DesignMdToken[];
  truncated: boolean;
};
export type DesignMdState =
  | DesignMdOkState
  | { status: "missing"; searched: string[] }
  | { status: "invalid"; reason: "outside-workspace" | "unsafe-path" }
  | (FileFields & { status: "too-large"; size: number })
  | (FileFields & { status: "unreadable" })
  | (FileFields & { status: LintFailureStatus });

/** A lint of text that isn't a file yet: no path, no cache, no event. */
export type DesignMdContentState =
  | Omit<DesignMdOkState, "path" | "source">
  | { status: "too-large"; size: number }
  | { status: LintFailureStatus };

export type DesignMdExportState =
  | (FileFields & { status: "ok"; text: string })
  | (FileFields & { status: "error"; errors: string[] })
  | Exclude<DesignMdState, DesignMdOkState>;

type ReportEvent = (
  event: "design_md_linted",
  props: { errors_bucket: ReturnType<typeof countBucket>; warnings_bucket: ReturnType<typeof countBucket> },
) => void;

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Aiden's own findings, added to the library's and counted in the summary. Pure. */
export function withAidenFindings(result: DesignMdLintResult): DesignMdLintResult {
  const added: DesignMdFinding[] = [];
  const counts = new Map<string, number>();
  for (const section of result.sections) {
    const name = canonicalSection(section.trim());
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      added.push({
        severity: "warning",
        rule: "aiden/duplicate-section",
        path: "sections",
        message: `Section "${name}" appears ${count} times.`,
      });
    }
  }
  for (const [key, value] of result.symbols) {
    const ref = "unresolved" in value ? value.unresolved : undefined;
    if (ref !== undefined && UNRESOLVED_REF.test(ref)) {
      added.push({
        severity: "warning",
        rule: "aiden/unresolved-ref",
        path: key,
        message: `${key} refers to ${ref}, which doesn't resolve, so the token is left out.`,
      });
    }
  }
  return {
    ...result,
    findings: [...result.findings, ...added],
    summary: { ...result.summary, warnings: result.summary.warnings + added.length },
  };
}

function okState(result: DesignMdLintResult, hash: string): Omit<DesignMdOkState, "path" | "source"> {
  const withAiden = withAidenFindings(result);
  const tokens = withAiden.symbols
    .flatMap(([key, value]): DesignMdToken[] =>
      "unresolved" in value ? [] : [{ path: cut(key, MAX_VALUE_CHARS), kind: value.kind, value: cut(value.text, MAX_VALUE_CHARS) }],
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    status: "ok",
    hash,
    summary: withAiden.summary,
    findings: withAiden.findings.map((finding) => ({ ...finding, message: cut(finding.message, MAX_MESSAGE_CHARS) })),
    sections: withAiden.sections,
    omitted: withAiden.omitted,
    tokens: tokens.slice(0, MAX_TOKENS),
    truncated: tokens.length > MAX_TOKENS,
  };
}

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Loaded =
  | { ok: true; realPath: string; content: string; hash: string; file: FileFields }
  | { ok: false; state: Exclude<DesignMdState, DesignMdOkState> };

type CacheEntry = { hash: string; state: Omit<DesignMdState, "path" | "source">; reported: boolean };

export class DesignMdReader {
  private readonly run: typeof runDesignMdWorker;
  private readonly report: ReportEvent;
  private readonly log: (message: string) => void;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly exports = new Map<string, DesignMdExportState>();

  constructor(
    deps: {
      run?: typeof runDesignMdWorker;
      report?: ReportEvent | ((event: string, props: unknown) => void);
      log?: (message: string) => void;
      maxEntries?: number;
    } = {},
  ) {
    this.run = deps.run ?? runDesignMdWorker;
    this.report = (deps.report as ReportEvent | undefined) ?? (() => undefined);
    this.log = deps.log ?? (() => undefined);
    this.maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  private async load(workspaceRoot: string, located: LocatedDesignMd): Promise<Loaded> {
    if ("missing" in located) return { ok: false, state: { status: "missing", searched: [...located.searched] } };
    if ("invalid" in located) return { ok: false, state: { status: "invalid", reason: located.invalid } };
    const file: FileFields = { path: located.path, source: located.source };
    let realRoot: string;
    let realPath: string;
    try {
      realRoot = await realpath(workspaceRoot);
      realPath = await realpath(path.join(realRoot, ...located.path.split("/")));
    } catch {
      return { ok: false, state: { status: "unreadable", ...file } };
    }
    if (!isPathInside(realRoot, realPath)) return { ok: false, state: { status: "invalid", reason: "outside-workspace" } };
    try {
      const info = await lstat(realPath);
      if (!info.isFile()) return { ok: false, state: { status: "unreadable", ...file } };
      if (info.size > DESIGN_MD_MAX_BYTES) return { ok: false, state: { status: "too-large", ...file, size: info.size } };
    } catch {
      return { ok: false, state: { status: "unreadable", ...file } };
    }
    // The bounded no-follow read is the last check: a swap or growth since lstat is refused.
    const text = await readBounded(realPath, DESIGN_MD_MAX_BYTES);
    if (text === null) return { ok: false, state: { status: "unreadable", ...file } };
    const content = stripBom(text);
    return { ok: true, realPath, content, hash: sha256(content), file };
  }

  private remember(realPath: string, entry: CacheEntry): void {
    this.cache.delete(realPath);
    this.cache.set(realPath, entry);
    while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
  }

  private async lint(content: string, hash: string, signal?: AbortSignal) {
    const outcome = await this.run({ op: "lint", content }, { signal });
    if (outcome.ok) return okState(outcome.result, hash);
    if (outcome.status === "lint-failed") this.log("The DESIGN.md linter failed on a file.");
    return { status: outcome.status };
  }

  /** R3: the state of the DESIGN.md that `located` names. */
  async read(
    workspaceRoot: string,
    located: LocatedDesignMd,
    options: { report?: boolean; signal?: AbortSignal } = {},
  ): Promise<DesignMdState> {
    const loaded = await this.load(workspaceRoot, located);
    if (!loaded.ok) return loaded.state;
    const { realPath, content, hash, file } = loaded;
    let entry = this.cache.get(realPath);
    if (entry?.hash !== hash) {
      const state = await this.lint(content, hash, options.signal);
      entry = { hash, state, reported: false };
      if (state.status === "ok" || state.status === "timed-out" || state.status === "lint-failed") {
        this.remember(realPath, entry);
      }
    } else {
      this.remember(realPath, entry);
    }
    const state = { ...entry.state, ...file } as DesignMdState;
    if (options.report !== false && state.status === "ok" && !entry.reported) {
      entry.reported = true;
      this.report("design_md_linted", {
        errors_bucket: countBucket(state.summary.errors),
        warnings_bucket: countBucket(state.summary.warnings),
      });
    }
    return state;
  }

  /** Lints text as given, under the same cap and deadline; never cached or reported. */
  async lintContent(content: string, signal?: AbortSignal): Promise<DesignMdContentState> {
    const text = stripBom(content);
    const size = Buffer.byteLength(text);
    if (size > DESIGN_MD_MAX_BYTES) return { status: "too-large", size };
    return (await this.lint(text, sha256(text), signal)) as DesignMdContentState;
  }

  /** One worker call that lints and emits; cached by content hash and format. */
  async export(
    workspaceRoot: string,
    located: LocatedDesignMd,
    format: DesignMdExportFormat,
    signal?: AbortSignal,
  ): Promise<DesignMdExportState> {
    const loaded = await this.load(workspaceRoot, located);
    if (!loaded.ok) return loaded.state;
    const key = `${loaded.hash}:${format}`;
    const cached = this.exports.get(key);
    if (cached) return { ...cached, ...loaded.file } as DesignMdExportState;
    const outcome = await this.run({ op: "export", content: loaded.content, format }, { signal });
    let state: DesignMdExportState;
    if (!outcome.ok) {
      if (outcome.status === "lint-failed") this.log("The DESIGN.md linter failed on an export.");
      state = { status: outcome.status, ...loaded.file };
      if (outcome.status === "busy" || outcome.status === "linter-unavailable") return state;
    } else if (outcome.result.success && typeof outcome.result.text === "string") {
      state = { status: "ok", text: outcome.result.text, ...loaded.file };
    } else {
      state = { status: "error", errors: (outcome.result.errors ?? []).map((error) => cut(error, MAX_MESSAGE_CHARS)), ...loaded.file };
    }
    this.exports.delete(key);
    this.exports.set(key, state);
    while (this.exports.size > this.maxEntries) this.exports.delete(this.exports.keys().next().value!);
    return state;
  }
}
