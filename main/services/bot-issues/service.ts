// "Needs you" issues: the host raises one for a person, the chat shows it,
// the person settles it (plan F2).
//
// One raise is one issue: the same open `dedupeKey` returns the issue already
// stored instead of a second card or banner, and finishes whichever side
// effect (the chat entry, the delivery) a failed earlier raise never wrote.
// Raising a ninth open issue settles the oldest as `superseded`, so a Bot can
// never queue more than `BOT_ISSUE_LIMITS.openPerBot` decisions for the
// person. Every raise and settlement appends a durable entry to the Bot's
// conversation, so the card is the transcript's own history, and every new
// issue also leaves through the Bot delivery funnel (`class: "issue"`), so the
// Mac banner and Telegram agree with the chat.

import { randomUUID } from "node:crypto";
import {
  BOT_ISSUE_ENTRY_KIND,
  BOT_ISSUE_LIMITS,
  BOT_ISSUE_STATUS_ENTRY_KIND,
  botIssueOf,
  type BotIssue,
  type BotIssueAction,
  type BotIssueResolution,
  type BotIssueStatusEntryData,
} from "../../../renderer/shared/bot-issues.js";
import type { BotDeliveryFunnel } from "../bot-delivery/funnel.js";
import type { BotIssueStore, StoredBotIssue } from "./store.js";
import { BotAccessRequestStaleError } from "../bot-runtime/bot-access-requests.js";
import { BotFolderGrantReplayStaleError } from "../bot-folder-grant-journal.js";

export type BotIssueActResult = "done" | "not_open" | "invalid";

/** What the routine service said when a card asked it to turn a routine back on. */
export type BotIssueResumeResult = "resumed" | "missing";

export interface BotIssueService {
  /** The open issue already stored for this key, or a new one. */
  raise(input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">): Promise<BotIssue>;
  /** Settles the open issue under this key; false when there is none. */
  resolve(botId: string, dedupeKey: string, resolution: BotIssueResolution): Promise<boolean>;
  act(botId: string, issueId: string, action: BotIssueAction): Promise<BotIssueActResult>;
  list(botId: string, options?: { open?: boolean }): Promise<BotIssue[]>;
  /** A Bot's issues changed (raise, settle); the sidebar re-reads that Bot. */
  onChange(listener: (botId: string) => void): () => void;
  forgetBot(botId: string): Promise<void>;
}

export interface BotIssueServiceActions {
  /** Absent hosts fail closed; only the desktop main wiring supplies persistent grants. */
  allowFolder?(botId: string, access: { folderPath: string; rootId?: string; authorization: import("../../../renderer/shared/bot-access-requests.js").BotAccessAuthorization }, operationId: string): Promise<"added" | "already_allowed">;
  /** Turn the Bot's routine back on through the routine service's own write. */
  resumeRoutine(botId: string, id: string): Promise<BotIssueResumeResult>;
  stopRun(botId: string): Promise<void>;
  /** Accept the wait for a stalled run; Plan A has no watchdog to snooze yet. */
  snoozeStall(botId: string): void;
  /** Open the Bot's settings for the person; the renderer navigates. */
  openSettings(botId: string, section: string): void;
}

export interface BotIssueServiceDependencies {
  store: BotIssueStore;
  /** `runtime.appendEntry`; no submission, so a paused Bot still shows the card. */
  appendEntry(botId: string, kind: string, data: unknown): Promise<void>;
  funnel: Pick<BotDeliveryFunnel, "deliver">;
  actions: BotIssueServiceActions;
  now(): number;
  /** Reports background transcript repair failures without failing issue reads. */
  onError?(error: unknown): void;
}

/** Trimmed, at most `limit` characters (code points, never mid-surrogate). */
function bound(text: string, limit: number): string {
  const trimmed = text.trim();
  const points = [...trimmed];
  if (points.length <= limit) return trimmed;
  return `${points.slice(0, limit - 1).join("").trimEnd()}…`;
}

function sameAction(left: BotIssueAction, right: BotIssueAction): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "open_settings" && right.kind === "open_settings") return left.section === right.section;
  if (left.kind === "resume_routine" && right.kind === "resume_routine") return left.routineId === right.routineId;
  return true;
}

function isOpen(issue: BotIssue): boolean {
  return issue.resolvedAt === undefined;
}

/** Run request ids do not alter authority for a future-task-only issue. */
function accessIdentity(issue: Pick<BotIssue, "access">): string {
  const access = issue.access, auth = access?.authorization;
  return JSON.stringify([access?.folderPath, access?.rootId, auth?.policyRevision, auth?.target,
    auth?.root, auth?.identity?.device, auth?.identity?.inode, auth?.rootId,
    auth?.inventoryRevision, auth?.choices]);
}

/** The issue as the chat card, the entry and every other reader sees it. */
function published(stored: StoredBotIssue): BotIssue {
  return {
    id: stored.id,
    botId: stored.botId,
    kind: stored.kind,
    dedupeKey: stored.dedupeKey,
    title: stored.title,
    body: stored.body,
    ...(stored.routineId === undefined ? {} : { routineId: stored.routineId }),
    actions: stored.actions,
    createdAt: stored.createdAt,
    ...(stored.resolvedAt === undefined ? {} : { resolvedAt: stored.resolvedAt }),
    ...(stored.resolution === undefined ? {} : { resolution: stored.resolution }),
  };
}

/**
 * The stored row for a new issue. Everything a reader validates is required
 * here too: a row the store would drop on the next read must never be written,
 * because it would never dedupe and every repeat raise would become a new card.
 */
function buildIssue(
  input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">,
  id: string,
  at: number,
): StoredBotIssue {
  if (typeof input.title !== "string" || typeof input.body !== "string" || !Array.isArray(input.actions)) {
    throw new Error("This issue can’t be stored.");
  }
  const issue: StoredBotIssue = {
    id,
    botId: input.botId,
    kind: input.kind,
    dedupeKey: input.dedupeKey,
    // A title is one line; a body may carry a line break, so both are only
    // trimmed and capped, never reflowed.
    title: bound(input.title.replace(/\s+/gu, " "), BOT_ISSUE_LIMITS.titleChars) || "Needs you",
    body: bound(input.body, BOT_ISSUE_LIMITS.bodyChars),
    ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
    ...(input.access === undefined ? {} : { access: structuredClone(input.access) }),
    actions: input.actions.slice(0, 2),
    createdAt: at,
  };
  if (botIssueOf(issue, input.botId) === null) throw new Error("This issue can’t be stored.");
  if (issue.kind !== "access_needed" && issue.actions.some((action) => action.kind === "dismiss_access")) throw new Error("Only access issues can offer Not now.");
  if (issue.actions.some((action) => action.kind === "allow_folder") && !issue.access?.folderPath) throw new Error("Only a persistable folder can offer Allow this folder.");
  return issue;
}

/** The issue the person can still answer, or the settlement they already gave. */
function statusEntry(issue: BotIssue): BotIssueStatusEntryData & { effectId: string } {
  return {
    // Host-only transaction identity. Public status readers whitelist fields.
    effectId: `bot-issue-status:${JSON.stringify([issue.id, issue.resolution ?? "dismissed", issue.resolvedAt])}`,
    issueId: issue.id,
    resolution: issue.resolution ?? "dismissed",
    ...(issue.resolvedAt === undefined ? {} : { resolvedAt: issue.resolvedAt }),
  };
}

export function createBotIssueService(dependencies: BotIssueServiceDependencies): BotIssueService {
  const listeners = new Set<(botId: string) => void>();

  /**
   * The raise still writing for a Bot and key. The stored row is durable before
   * its chat entry and banner are, so a second raise in that window reads the
   * row with the side-effect flags still unset and would repeat both. It waits
   * for the attempt already running instead. The entry leaves the map when that
   * attempt settles, so a later raise can still repair a failure.
   */
  const raising = new Map<string, { identity: string; attempt: Promise<BotIssue> }>();
  // Folder effects are journaled by the application service. Keep the card
  // open until that commit succeeds, so a process exit before the effect can
  // never leave a falsely fixed issue. A restart can retry the same issue id.
  const allowingFolders = new Set<string>();
  const repairing = new Map<string, Promise<void>>();
  const raiseKeyOf = (botId: string, dedupeKey: string) => `${botId}\u0000${dedupeKey}`;

  const notify = (botId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(botId);
      } catch {
        // A listener's failure never changes the issue.
      }
    }
  };

  /** Record which side effects of a raise already landed; a retry sends the rest. */
  function remember(
    botId: string,
    issueId: string,
    patch: Pick<StoredBotIssue, "entryAppended" | "delivered" | "statusAppended">,
  ): Promise<void> {
    return dependencies.store.change(botId, (issues) => ({
      issues: issues.map((row) => (row.id === issueId ? { ...row, ...patch } : row)),
      result: undefined,
    }));
  }

  function repairStatuses(botId: string, issueId?: string): Promise<void> {
    // Serialize transcript effects, but an unrelated failed attempt is never a
    // prerequisite for this settlement. Re-read after the previous attempt so
    // concurrent repairs cannot append a status whose marker already landed.
    const active = repairing.get(botId);
    const attempt = (active ?? Promise.resolve()).catch(() => undefined).then(async () => {
      for (const row of await dependencies.store.read(botId)) {
        if (isOpen(row) || row.statusAppended !== false || (issueId !== undefined && row.id !== issueId)) continue;
        await dependencies.appendEntry(botId, BOT_ISSUE_STATUS_ENTRY_KIND, statusEntry(row));
        await remember(botId, row.id, { statusAppended: true });
        notify(botId);
      }
    });
    repairing.set(botId, attempt);
    const clear = () => { if (repairing.get(botId) === attempt) repairing.delete(botId); };
    void attempt.then(clear, clear);
    return attempt;
  }

  function repairStatusesInBackground(botId: string): void {
    // Reads must never wait behind the session serializer. A durable marker
    // keeps failed appends available for the next read or mutation to retry.
    if (repairing.has(botId)) return;
    void repairStatuses(botId).catch((error: unknown) => {
      try { dependencies.onError?.(error); } catch { /* Reporting cannot change the issue. */ }
    });
  }

  /** Settle one stored issue by key; false when it is no longer open. */
  async function settle(botId: string, dedupeKey: string, resolution: BotIssueResolution, issueId?: string): Promise<boolean> {
    const settled = await dependencies.store.change(botId, (issues) => {
      const index = issues.findIndex((issue) => isOpen(issue) && issue.dedupeKey === dedupeKey && (issueId === undefined || issue.id === issueId));
      if (index < 0) return { issues, result: undefined };
      const next = [...issues];
      next[index] = { ...issues[index]!, resolvedAt: dependencies.now(), resolution, statusAppended: false };
      return { issues: next, result: next[index]! };
    });
    if (settled === undefined) return false;
    if (settled.kind === "access_needed") notify(botId);
    await repairStatuses(botId, settled.id);
    return true;
  }

  /**
   * Take one issue off the person's list by id before its action runs. Only the
   * caller that wins this write runs the host action, and the settlement names
   * this issue, never whatever row later reuses its key.
   */
  function claim(
    botId: string,
    issueId: string,
    action: BotIssueAction,
    resolution: BotIssueResolution,
  ): Promise<StoredBotIssue | "not_open" | "invalid"> {
    return dependencies.store.change<StoredBotIssue | "not_open" | "invalid">(botId, (issues) => {
      const index = issues.findIndex((row) => row.id === issueId);
      const issue = index < 0 ? undefined : issues[index];
      if (!issue || !isOpen(issue)) return { issues, result: "not_open" };
      // Only what this issue offers is answerable: a stale card's other
      // action, or another issue's, never runs anything.
      if (!issue.actions.some((offered) => sameAction(offered, action))) {
        return { issues, result: "invalid" };
      }
      if (action.kind === "allow_folder" && (!issue.access?.folderPath || !dependencies.actions.allowFolder || issue.access.authorization.target !== "folder" || !issue.access.authorization.choices.includes("always"))) return { issues, result: "invalid" };
      const next = [...issues];
      next[index] = { ...issue, resolvedAt: dependencies.now(), resolution, ...(action.kind === "dismiss_access" ? { statusAppended: false } : {}) };
      return { issues: next, result: next[index]! };
    });
  }

  /** Put our own claim back when its host action failed, so the card stays answerable. */
  function release(botId: string, claimed: StoredBotIssue): Promise<void> {
    return dependencies.store.change(botId, (issues) => ({
      issues: issues.map((row) => {
        if (row.id !== claimed.id || row.resolvedAt !== claimed.resolvedAt || row.resolution !== claimed.resolution) {
          return row;
        }
        const reopened: StoredBotIssue = { ...row };
        delete reopened.resolvedAt;
        delete reopened.resolution;
        return reopened;
      }),
      result: undefined,
    }));
  }

  /** Change how our claim settled (a routine that no longer exists is dismissed). */
  function resettle(
    botId: string,
    claimed: StoredBotIssue,
    resolution: BotIssueResolution,
  ): Promise<StoredBotIssue> {
    return dependencies.store.change(botId, (issues) => {
      const index = issues.findIndex((row) => row.id === claimed.id && row.resolvedAt === claimed.resolvedAt);
      if (index < 0) return { issues, result: claimed };
      const next = [...issues];
      next[index] = { ...issues[index]!, resolution };
      return { issues: next, result: next[index]! };
    });
  }

  /** Write the new issue, then every side effect it has not landed yet. */
  async function deliverRaise(
    input: Omit<BotIssue, "id" | "createdAt" | "resolvedAt" | "resolution">,
  ): Promise<BotIssue> {
    const raised = await dependencies.store.change(input.botId, (issues) => {
      const existing = issues.find((issue) => isOpen(issue) && issue.dedupeKey === input.dedupeKey);
      if (existing && (input.kind !== "access_needed" || accessIdentity(existing) === accessIdentity(input))) return { issues, result: { issue: existing, created: false, superseded: undefined } };

      const at = dependencies.now();
      const issue = buildIssue(input, randomUUID(), at);
      const open = issues.filter(isOpen);
      // The ninth open issue settles the oldest: the person always has at
      // most eight decisions, and the card they lose says why it left.
      const oldest = existing ?? (
        open.length < BOT_ISSUE_LIMITS.openPerBot
          ? undefined
          : [...open].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]);
      const superseded =
        oldest === undefined ? undefined : { ...oldest, resolvedAt: at, resolution: "superseded" as const, statusAppended: false };
      return {
        issues: [issue, ...(superseded === undefined ? issues : issues.map((row) => (row.id === superseded.id ? superseded : row)))],
        result: { issue, created: true, superseded },
      };
    });

    const issue = raised.issue;
    // The issue is durable before its chat entry and banner are: a raise that
    // failed halfway is repaired here, one missing side effect at a time.
    if (issue.entryAppended !== true) {
      await dependencies.appendEntry(input.botId, BOT_ISSUE_ENTRY_KIND, published(issue));
      await remember(input.botId, issue.id, { entryAppended: true });
      notify(input.botId);
    }
    if (issue.delivered !== true) {
      await dependencies.funnel.deliver({
        botId: input.botId,
        class: "issue",
        ...(issue.kind === "access_needed" ? { requiredCapability: "bot:access-requests" as const } : {}),
        dedupeKey: `issue:${issue.id}`,
        title: issue.title,
        body: issue.body,
        status: "info",
      });
      await remember(input.botId, issue.id, { delivered: true });
    }
    repairStatusesInBackground(input.botId);
    return published(issue);
  }

  return {
    raise(input) {
      const key = raiseKeyOf(input.botId, input.dedupeKey);
      const inFlight = raising.get(key);
      const identity = input.kind === "access_needed" ? accessIdentity(input) : "ordinary";
      if (inFlight?.identity === identity) return inFlight.attempt;
      const attempt = inFlight ? inFlight.attempt.catch(() => undefined).then(() => deliverRaise(input)) : deliverRaise(input);
      const pending = { identity, attempt };
      raising.set(key, pending);
      const clear = () => {
        if (raising.get(key) === pending) raising.delete(key);
      };
      void attempt.then(clear, clear);
      return attempt;
    },

    resolve(botId, dedupeKey, resolution) {
      // A raise after this resolve is a new problem: it must not join an
      // attempt that is about to deliver the issue being settled.
      raising.delete(raiseKeyOf(botId, dedupeKey));
      return settle(botId, dedupeKey, resolution);
    },

    async act(botId, issueId, action) {
      if (action.kind === "allow_folder" || action.kind === "dismiss_access") {
        const key = JSON.stringify([botId, issueId]);
        if (allowingFolders.has(key)) return "not_open";
        allowingFolders.add(key);
        try {
          repairStatusesInBackground(botId);
          const issue = (await dependencies.store.read(botId)).find((row) => row.id === issueId);
          if (!issue || !isOpen(issue)) return "not_open";
          if (action.kind === "dismiss_access") {
            if (issue.kind !== "access_needed") return "invalid";
            const dismissed = await claim(botId, issueId, action, "dismissed");
            if (dismissed === "not_open" || dismissed === "invalid") return dismissed;
            notify(botId);
            await repairStatuses(botId, dismissed.id);
            return "done";
          }
          const access = issue.access;
          if (!issue.actions.some((offered) => sameAction(offered, action)) || !access?.folderPath || !dependencies.actions.allowFolder || access.authorization.target !== "folder" || !access.authorization.choices.includes("always")) return "invalid";
          try { await dependencies.actions.allowFolder(botId, { folderPath: access.folderPath, ...(access.rootId ? { rootId: access.rootId } : {}), authorization: access.authorization }, issue.id); }
          catch (error) {
            if (error instanceof BotFolderGrantReplayStaleError) {
              await settle(botId, issue.dedupeKey, "superseded", issue.id);
              return "not_open";
            }
            if (error instanceof BotAccessRequestStaleError) await settle(botId, issue.dedupeKey, "superseded", issue.id);
            throw error;
          }
          const fixed = await dependencies.store.change(botId, (issues) => {
            const current = issues.find((row) => row.id === issueId);
            if (!current || !isOpen(current)) return { issues, result: undefined };
            const settled = { ...current, resolvedAt: dependencies.now(), resolution: "fixed" as const, statusAppended: false };
            return { issues: issues.map((row) => row.id === issueId ? settled : row), result: settled };
          });
          notify(botId);
          if (fixed) await repairStatuses(botId, fixed.id);
          return "done";
        } finally { allowingFolders.delete(key); }
      }
      // Opening a surface is not a fix and changes no Bot state, so these two
      // answer the card without settling it (and without a claim to release).
      if (action.kind === "open_settings" || action.kind === "open_chat") {
        const issue = (await dependencies.store.read(botId)).find((row) => row.id === issueId);
        if (!issue || !isOpen(issue)) return "not_open";
        if (!issue.actions.some((offered) => sameAction(offered, action))) return "invalid";
        if (action.kind === "open_settings") dependencies.actions.openSettings(botId, action.section);
        return "done";
      }

      const claimed = await claim(
        botId,
        issueId,
        action,
        action.kind === "keep_waiting" ? "dismissed" : "fixed",
      );
      if (claimed === "not_open" || claimed === "invalid") return claimed;

      let resolution: BotIssueResolution = claimed.resolution ?? "fixed";
      try {
        switch (action.kind) {
          case "resume_routine": {
            // A routine deleted while its card was open is gone, not broken:
            // the person pressed the only sensible answer, so the card settles.
            if ((await dependencies.actions.resumeRoutine(botId, action.routineId)) === "missing") {
              resolution = "dismissed";
            }
            break;
          }
          case "stop_run":
            await dependencies.actions.stopRun(botId);
            break;
          case "keep_waiting":
            dependencies.actions.snoozeStall(botId);
            break;
        }
      } catch (error) {
        await release(botId, claimed);
        throw error;
      }

      const settled = resolution === claimed.resolution ? claimed : await resettle(botId, claimed, resolution);
      await remember(botId, settled.id, { statusAppended: false });
      await repairStatuses(settled.botId);
      notify(botId);
      return "done";
    },

    async list(botId, options) {
      repairStatusesInBackground(botId);
      const issues = await dependencies.store.read(botId);
      return (options?.open ? issues.filter(isOpen) : issues).map(published);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    forgetBot(botId) {
      return dependencies.store.forgetBot(botId);
    },
  };
}

/**
 * Settle the open issues that asked about a routine the person deleted. The
 * routine is gone, so its cards can never be answered; they leave as
 * `dismissed` instead of waiting forever for "Needs you".
 */
export async function resolveDeletedRoutineIssues(
  service: Pick<BotIssueService, "list" | "resolve">,
  botId: string,
  routineId: string,
): Promise<number> {
  const open = await service.list(botId, { open: true });
  let settled = 0;
  for (const issue of open) {
    if (issue.routineId !== routineId) continue;
    if (await service.resolve(botId, issue.dedupeKey, "dismissed")) settled += 1;
  }
  return settled;
}
