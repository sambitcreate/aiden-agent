import {
  SLASH_COMMANDS,
  SLASH_LIMITS,
  type SkillCatalogEntry,
  type SkillInvocationV1,
  type SkillSource,
  type SlashCommandDefinition,
} from "../shared/slash-commands";

export interface SelectedSkillInvocation {
  workspaceId: string;
  invocation: SkillInvocationV1;
}

export interface SelectedSkillComposerState {
  selected?: SelectedSkillInvocation;
  revision: number;
}

export type SelectedSkillComposerAction =
  | { type: "select"; selected: SelectedSkillInvocation }
  | { type: "remove" }
  | { type: "send-succeeded"; submittedRevision: number };

/** Keeps a skill attached to exactly one accepted message, without erasing a replacement. */
export function selectedSkillComposerReducer(
  state: SelectedSkillComposerState,
  action: SelectedSkillComposerAction,
): SelectedSkillComposerState {
  if (action.type === "select") {
    return { selected: action.selected, revision: state.revision + 1 };
  }
  if (action.type === "remove") {
    return { selected: undefined, revision: state.revision + 1 };
  }
  if (action.submittedRevision !== state.revision) return state;
  return { selected: undefined, revision: state.revision + 1 };
}

export type SelectedSkillStatus =
  | { state: "valid"; entry: SkillCatalogEntry }
  | { state: "checking"; reason: string }
  | { state: "invalid"; reason: string };

export function selectedSkillStatus(
  selected: SelectedSkillInvocation,
  currentWorkspaceId: string | undefined,
  catalog: readonly SkillCatalogEntry[] | undefined,
  catalogState: "loading" | "error" | "ready",
): SelectedSkillStatus {
  if (!currentWorkspaceId || selected.workspaceId !== currentWorkspaceId) {
    return { state: "invalid", reason: "This skill belongs to a different workspace." };
  }
  if (catalogState === "error") {
    return { state: "invalid", reason: "This skill could not be verified. Remove or replace it." };
  }
  if (catalogState === "loading") {
    return { state: "checking", reason: "Checking skill availability…" };
  }
  const exact = catalog?.find((entry) => entry.invocationId === selected.invocation.invocationId);
  if (exact?.available) return { state: "valid", entry: exact };
  if (exact) {
    return {
      state: "invalid",
      reason: exact.unavailableReason ?? "This skill is currently unavailable.",
    };
  }
  return { state: "invalid", reason: "This skill changed or is no longer available." };
}

export function successfulSendAttachmentRemainder<T extends { id: string }>(
  current: readonly T[],
  submitted: readonly T[],
  unchanged: boolean,
): T[] {
  if (unchanged) return [];
  const submittedIds = new Set(submitted.map((attachment) => attachment.id));
  return current.filter((attachment) => !submittedIds.has(attachment.id));
}

export interface SlashSessionTracker {
  epoch: number;
  active: boolean;
  token?: string;
  dismissedEpoch?: number;
}

export interface SlashTriggerInput {
  draft: string;
  selectionStart: number;
  selectionEnd: number;
  composing: boolean;
  tracker?: SlashSessionTracker;
}

export interface SlashSession {
  kind: "command" | "skill";
  trigger: "/" | "$";
  tokenStart: number;
  tokenEnd: number;
  token: string;
  query: string;
  /** Exact text after the token; action adapters decide whether an argument may trim it. */
  argument: string;
  sessionKey: string;
}

export type SlashResult =
  | { kind: "command"; id: string; command: SlashCommandDefinition; score: number }
  | { kind: "skill"; id: string; skill: SkillCatalogEntry; score: number };

export function moveSlashSelectionId(
  ids: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const currentIndex = currentId === undefined ? -1 : ids.indexOf(currentId);
  if (currentIndex < 0) return direction === 1 ? ids[0] : ids[ids.length - 1];
  return ids[(currentIndex + direction + ids.length) % ids.length];
}

export function pageSlashSelectionId(
  ids: readonly string[],
  currentId: string | undefined,
  direction: 1 | -1,
  pageSize = 8,
): string | undefined {
  if (ids.length === 0) return undefined;
  const currentIndex = currentId === undefined ? -1 : ids.indexOf(currentId);
  if (currentIndex < 0) return direction === 1 ? ids[0] : ids[ids.length - 1];
  const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + direction * pageSize));
  return ids[nextIndex];
}

function selectableSlashResultIds(
  results: readonly SlashResult[],
  selectable: (result: SlashResult) => boolean,
): string[] {
  const ids: string[] = [];
  for (const result of results) {
    if (selectable(result)) ids.push(result.id);
  }
  return ids;
}

export function moveSlashSelection(
  results: readonly SlashResult[],
  currentId: string | undefined,
  direction: 1 | -1,
  selectable: (result: SlashResult) => boolean,
): string | undefined {
  return moveSlashSelectionId(selectableSlashResultIds(results, selectable), currentId, direction);
}

export function pageSlashSelection(
  results: readonly SlashResult[],
  currentId: string | undefined,
  direction: 1 | -1,
  selectable: (result: SlashResult) => boolean,
  pageSize = 8,
): string | undefined {
  return pageSlashSelectionId(
    selectableSlashResultIds(results, selectable),
    currentId,
    direction,
    pageSize,
  );
}

function firstToken(
  draft: string,
): { start: number; end: number; token: string; trigger: "/" | "$" } | null {
  const start = draft.search(/\S/u);
  if (start < 0 || (draft[start] !== "/" && draft[start] !== "$")) return null;
  const relativeEnd = draft.slice(start).search(/\s/u);
  const end = relativeEnd < 0 ? draft.length : start + relativeEnd;
  return { start, end, token: draft.slice(start, end), trigger: draft[start] };
}

export function updateSlashSessionTracker(
  previous: SlashSessionTracker | undefined,
  draft: string,
): SlashSessionTracker {
  const prior = previous ?? { epoch: 0, active: false };
  const parsed = firstToken(draft);
  if (!parsed) return { ...prior, active: false, token: undefined };
  if (!prior.active || prior.token !== parsed.token) {
    return { epoch: prior.epoch + 1, active: true, token: parsed.token };
  }
  return { ...prior, active: true, token: parsed.token };
}

export function slashActionCommitIsCurrent(
  expected: {
    draft: string;
    epoch: number;
    interactionRevision: number;
    blocked: boolean;
  },
  current: {
    draft: string;
    epoch: number;
    interactionRevision: number;
    blocked: boolean;
  },
): boolean {
  return (
    expected.draft === current.draft &&
    expected.epoch === current.epoch &&
    expected.interactionRevision === current.interactionRevision &&
    expected.blocked === current.blocked
  );
}

/** Session actions may own focus or navigation while still preserving the exact draft. */
export function slashActionDraftCommitIsCurrent(
  expected: { draft: string; epoch: number },
  current: { draft: string; epoch: number },
): boolean {
  return expected.draft === current.draft && expected.epoch === current.epoch;
}

export function slashTabAcceptsSelection(selectableCount: number, actionPending: boolean): boolean {
  return selectableCount === 1 && !actionPending;
}

export function slashPalettePresenceState(input: {
  present: boolean;
  retained: boolean;
  immediate: boolean;
  reduceMotion: boolean;
}): "visible" | "exiting" | "hidden" {
  if (input.present) return "visible";
  if (input.immediate || input.reduceMotion || !input.retained) return "hidden";
  return "exiting";
}

export function dismissSlashSession(tracker: SlashSessionTracker): SlashSessionTracker {
  return { ...tracker, dismissedEpoch: tracker.epoch };
}

export function slashSessionKey(epoch: number, token: string): string {
  return `${epoch}:${token}`;
}

export function deriveSlashSession(input: SlashTriggerInput): SlashSession | null {
  if (input.composing || input.selectionStart !== input.selectionEnd) return null;
  const parsed = firstToken(input.draft);
  if (!parsed) return null;
  if (input.selectionStart < parsed.start || input.selectionStart > parsed.end) return null;
  const query = parsed.token.slice(1);
  if (Array.from(query).length > SLASH_LIMITS.queryCharacters) return null;
  const tracker = input.tracker ?? updateSlashSessionTracker(undefined, input.draft);
  if (!tracker.active || tracker.token !== parsed.token) return null;
  if (tracker.dismissedEpoch === tracker.epoch) return null;
  return {
    kind: parsed.trigger === "/" ? "command" : "skill",
    trigger: parsed.trigger,
    tokenStart: parsed.start,
    tokenEnd: parsed.end,
    token: parsed.token,
    query,
    argument: input.draft.slice(parsed.end),
    sessionKey: slashSessionKey(tracker.epoch, parsed.token),
  };
}

/** Remove exactly the trigger token; whitespace and message formatting remain byte-for-byte intact. */
export function consumeSlashToken(draft: string, session: SlashSession): string {
  if (draft.slice(session.tokenStart, session.tokenEnd) !== session.token) return draft;
  return `${draft.slice(0, session.tokenStart)}${draft.slice(session.tokenEnd)}`;
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function compareStable(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fuzzySubsequence(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const needleCharacters = Array.from(needle);
  let index = 0;
  for (const character of haystack) {
    if (character === needleCharacters[index]) index += 1;
    if (index === needleCharacters.length) return true;
  }
  return false;
}

function scoreFields(
  query: string,
  primary: string,
  aliases: readonly string[],
  searchable: readonly string[],
): number | null {
  if (!query) return 100;
  if (primary === query) return 1_000;
  if (aliases.includes(query)) return 950;
  if (primary.startsWith(query)) return 850;
  if (aliases.some((alias) => alias.startsWith(query))) return 800;
  const words = searchable.flatMap((value) =>
    normalized(value)
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  if (words.some((word) => word.startsWith(query))) return 700;
  const joined = searchable.map(normalized).join(" ");
  if (joined.includes(query)) return 600;
  if (fuzzySubsequence(joined, query)) return 400;
  return null;
}

const SOURCE_ORDER: Record<SkillSource, number> = {
  configured: 0,
  workspace: 1,
  global: 2,
};

export function rankSlashResults(
  queryInput: string,
  skills: readonly SkillCatalogEntry[],
  kind: SlashSession["kind"],
  commands: readonly SlashCommandDefinition[] = SLASH_COMMANDS,
): { results: SlashResult[]; truncated: boolean } {
  if (
    Array.from(queryInput).length > SLASH_LIMITS.queryCharacters ||
    (kind === "skill" && skills.length > SLASH_LIMITS.catalogEntries)
  ) {
    throw new RangeError("Slash command input exceeds its bounded contract.");
  }
  const query = normalized(queryInput);
  const results: SlashResult[] = [];
  if (kind === "command") {
    for (const command of commands) {
      const score = scoreFields(query, normalized(command.name), command.aliases.map(normalized), [
        command.name,
        ...command.aliases,
        command.title,
        command.description,
        ...command.keywords,
      ]);
      if (score !== null) {
        results.push({
          kind: "command",
          id: `slash-option-command-${command.name}`,
          command,
          score,
        });
      }
    }
  } else {
    for (const skill of skills) {
      const score = scoreFields(
        query,
        normalized(skill.name),
        [],
        [skill.name, skill.description, skill.source],
      );
      if (score !== null) {
        results.push({
          kind: "skill",
          id: `slash-option-skill-${skill.invocationId}`,
          skill,
          score,
        });
      }
    }
  }
  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.kind !== right.kind) return left.kind === "command" ? -1 : 1;
    if (left.kind === "command" && right.kind === "command") {
      return compareStable(left.command.name, right.command.name);
    }
    if (left.kind === "skill" && right.kind === "skill") {
      return (
        SOURCE_ORDER[left.skill.source] - SOURCE_ORDER[right.skill.source] ||
        compareStable(normalized(left.skill.name), normalized(right.skill.name)) ||
        compareStable(left.skill.invocationId, right.skill.invocationId)
      );
    }
    return 0;
  });
  return {
    results: results.slice(0, SLASH_LIMITS.visibleResults),
    truncated: results.length > SLASH_LIMITS.visibleResults,
  };
}
