// Contract for creating a managed worktree when a draft's first message is sent.
//
// Shared by main (which validates everything again) and the renderer draft and
// branch menu. Kept free of Node and Electron imports so both sides can use it.

/** Prefix of every branch name Aiden picks automatically. */
export const AUTO_WORKTREE_BRANCH_PREFIX = "aiden/";
/** Slug used when the first message has no usable words. */
export const AUTO_WORKTREE_FALLBACK_SLUG = "new-chat";
/** Longest slug taken from the first message, before any `-2` suffix. */
export const AUTO_WORKTREE_SLUG_MAX_LENGTH = 40;
export const WORKTREE_REF_MAX_LENGTH = 200;

/**
 * Sent with the first message when the draft chose New worktree. Nothing
 * touches disk before this request.
 */
export interface FirstMessageWorktreeRequest {
  /** The draft's workspace. Must equal the request's `workspaceId`. */
  sourceWorkspaceId: string;
  /** Local branch (`main`), remote-tracking branch (`origin/main`), or `HEAD`. */
  baseRef: string;
  /** Fetch the base branch from its upstream remote first. */
  fromOrigin: boolean;
  /** Explicit branch name. Omitted means Auto (`aiden/<slug of the message>`). */
  branchName?: string;
  /** The draft id. At most one worktree is ever created per key. */
  idempotencyKey: string;
}

/**
 * How the base was chosen:
 * - `local`: from origin was not requested.
 * - `fetched`: the base branch was fetched from `remote` and the worktree starts at `<remote>/<branch>`.
 * - `no-upstream`: from origin was requested, but the base has no upstream
 *   remote, so the local base was used.
 */
export type FirstMessageWorktreeBaseSource = "local" | "fetched" | "no-upstream";

export interface FirstMessageWorktreeInfo {
  /** The new worktree workspace the chat is saved in. */
  workspaceId: string;
  branch: string;
  /** The base ref as requested. */
  baseRef: string;
  /** The ref the worktree actually started from, e.g. `origin/main` or `main`. */
  startPoint: string;
  /** Full commit the worktree started at. */
  baseCommit: string;
  baseSource: FirstMessageWorktreeBaseSource;
  /** True when a retry returned the worktree an earlier attempt created. */
  reused: boolean;
}

export type FirstMessageWorktreeResult<C> =
  | { ok: true; chat: C; worktree: FirstMessageWorktreeInfo }
  | {
      ok: false;
      /** The chat was not saved; the draft can Retry or run in this checkout instead. */
      code: "worktree-failed";
      /** Short user-facing sentence. */
      reason: string;
      /** Git's message, with the workspace and home folders redacted. */
      detail?: string;
    }
  | {
      ok: false;
      /**
       * This draft already created a worktree with a different base, origin
       * setting or branch name. Nothing was created or saved; the existing
       * worktree is kept for this draft.
       */
      code: "worktree-settings-changed";
      reason: string;
      /**
       * The existing worktree, with the settings its attempt was sent with:
       * sending again with `baseRef`, `fromOrigin` and `branchName` uses it.
       */
      worktree: {
        workspaceId: string;
        branch: string;
        baseRef: string;
        fromOrigin: boolean;
        /** The explicit name that attempt asked for; omitted for Auto. */
        branchName?: string;
      };
    };

export type FirstMessageWorktreePhase = "fetching" | "creating" | "ready";

/** Sent only to the document that sent the first message. */
export interface FirstMessageWorktreeProgress {
  /** The draft id (`idempotencyKey`). */
  draftId: string;
  phase: FirstMessageWorktreePhase;
  /** Set once the branch name is resolved (`creating`, `ready`). */
  branch?: string;
  /** `origin/main` while fetching, the start point afterwards. */
  startPoint?: string;
}

/** What the branch menu (`git:branches`) knows about the repository. */
export interface DraftWorktreeRepositoryState {
  branches: readonly string[];
  remoteBranches?: readonly string[];
  current?: string;
  defaultBranch?: string;
  hasRemote?: boolean;
  unborn?: boolean;
}

/**
 * Where a new worktree starts unless the person picks: the remembered base
 * while it still exists, else the repository's default branch, else the
 * current branch. From origin defaults to on when a remote exists. Undefined
 * when the repository has no commit to start from. Desktop drafts and
 * phones (which never pick a base) share this rule.
 */
export function resolveWorktreeDefaults(
  repository: DraftWorktreeRepositoryState,
  remembered: { baseRef?: string; fromOrigin?: boolean } = {},
): { baseRef: string; fromOrigin: boolean } | undefined {
  if (repository.unborn) return undefined;
  const exists = (ref: string | undefined): ref is string =>
    ref !== undefined && (repository.branches.includes(ref) || (repository.remoteBranches ?? []).includes(ref));
  const baseRef = [remembered.baseRef, repository.defaultBranch, repository.current, repository.branches[0]]
    .find(exists);
  if (!baseRef) return undefined;
  const hasRemote = repository.hasRemote ?? (repository.remoteBranches?.length ?? 0) > 0;
  return { baseRef, fromOrigin: hasRemote && (remembered.fromOrigin ?? true) };
}

const FORBIDDEN_CHARACTERS = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

/** Control characters, space, DEL, and the characters Git reserves for revision syntax. */
function hasForbiddenCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f || FORBIDDEN_CHARACTERS.has(character)) return true;
  }
  return false;
}

/**
 * Git's branch-name rules (`git check-ref-format --branch`), without running
 * Git. Main still lets Git validate the final name before creating anything.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > WORKTREE_REF_MAX_LENGTH) return false;
  if (name === "@" || name.startsWith("-")) return false;
  if (hasForbiddenCharacter(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  for (const component of name.split("/")) {
    if (!component || component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  return true;
}

/** `Fix the Login bug!` → `fix-the-login-bug`. Words are kept whole where possible. */
export function worktreeBranchSlug(seed: string, maxLength = AUTO_WORKTREE_SLUG_MAX_LENGTH): string {
  const words = seed
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length <= maxLength) {
      slug = next;
      continue;
    }
    // A first word longer than the limit is cut; later words are dropped whole.
    if (!slug) slug = word.slice(0, maxLength);
    break;
  }
  return slug || AUTO_WORKTREE_FALLBACK_SLUG;
}

/** The Auto branch name for a first message, before uniqueness. */
export function autoWorktreeBranchName(seed: string): string {
  return `${AUTO_WORKTREE_BRANCH_PREFIX}${worktreeBranchSlug(seed)}`;
}

/**
 * Two branch names collide when they are equal (ignoring case, as macOS stores
 * loose refs on a case-insensitive disk) or one is a folder of the other
 * (`aiden` blocks `aiden/x`).
 */
function branchNamesCollide(left: string, right: string): boolean {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * `name`, or `name-2`, `name-3`, … — the first that collides with none of
 * `existing`. Undefined when no free name is found within `maxAttempts`.
 */
export function uniqueBranchName(
  name: string,
  existing: Iterable<string>,
  maxAttempts = 100,
): string | undefined {
  const taken = [...existing];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    if (!isValidBranchName(candidate)) return undefined;
    if (!taken.some((other) => branchNamesCollide(candidate, other))) return candidate;
  }
  return undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const REQUEST_KEYS = new Set(["sourceWorkspaceId", "baseRef", "fromOrigin", "branchName", "idempotencyKey"]);

/** Validate the untrusted `worktree` field of a first-message request. */
export function parseFirstMessageWorktreeRequest(value: unknown): FirstMessageWorktreeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid worktree request.");
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key) && !REQUEST_KEYS.has(key)) {
      throw new Error("Invalid worktree request fields.");
    }
  }
  const { sourceWorkspaceId, baseRef, fromOrigin, branchName, idempotencyKey } = record;
  if (typeof sourceWorkspaceId !== "string" || !WORKSPACE_ID.test(sourceWorkspaceId)) {
    throw new Error("Invalid worktree source workspace.");
  }
  if (typeof baseRef !== "string" || (baseRef !== "HEAD" && !isValidBranchName(baseRef))) {
    throw new Error("Choose a valid base branch for the new worktree.");
  }
  if (typeof fromOrigin !== "boolean") throw new Error("Invalid worktree origin setting.");
  if (branchName !== undefined && (typeof branchName !== "string" || !isValidBranchName(branchName))) {
    throw new Error("Enter a valid Git branch name.");
  }
  if (typeof idempotencyKey !== "string" || !UUID.test(idempotencyKey)) {
    throw new Error("Invalid worktree idempotency key.");
  }
  return {
    sourceWorkspaceId,
    baseRef,
    fromOrigin,
    ...(branchName === undefined ? {} : { branchName }),
    idempotencyKey: idempotencyKey.toLowerCase(),
  };
}
