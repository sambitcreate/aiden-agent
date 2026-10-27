// "Needs you" issues: the host raises one for a person, the chat shows it,
// the person settles it (plan F2).
//
// One raise is one issue: the same open `dedupeKey` returns the issue already
// stored instead of a second card or banner. Raising a ninth open issue
// settles the oldest as `superseded`, so a Bot can never queue more than
// `BOT_ISSUE_LIMITS.openPerBot` decisions for the person. Every raise and
// settlement appends a durable entry to the Bot's conversation, so the card is
// the transcript's own history, and every new issue also leaves through the
// Bot delivery funnel (`class: "issue"`), so the Mac banner and Telegram agree
// with the chat.

import { randomUUID } from "node:crypto";
import {
  BOT_ISSUE_ENTRY_KIND,
  BOT_ISSUE_LIMITS,
  BOT_ISSUE_STATUS_ENTRY_KIND,
  type BotIssue,
  type BotIssueAction,
  type BotIssueResolution,
  type BotIssueStatusEntryData,
} from "../../../renderer/shared/bot-issues.js";
import type { BotDeliveryFunnel } from "../bot-delivery/funnel.js";
import type { BotIssueStore } from "./store.js";

export type BotIssueActResult = "done" | "not_open" | "invalid";

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
  /** Turn the Bot's routine back on through the routine service's own write. */
  resumeRoutine(botId: string, id: string): Promise<void>;
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
  funnel: BotDeliveryFunnel;
  actions: BotIssueServiceActions;
  now(): number;
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

/** The issue the person can still answer, or the settlement they already gave. */
function statusEntry(issue: BotIssue): BotIssueStatusEntryData {
  return {
    issueId: issue.id,
    resolution: issue.resolution ?? "dismissed",
    ...(issue.resolvedAt === undefined ? {} : { resolvedAt: issue.resolvedAt }),
  };
}

export function createBotIssueService(dependencies: BotIssueServiceDependencies): BotIssueService {
  const listeners = new Set<(botId: string) => void>();

  const notify = (botId: string) => {
    for (const listener of [...listeners]) {
      try {
        listener(botId);
      } catch {
        // A listener's failure never changes the issue.
      }
    }
  };

  /** Settle one stored issue by key; false when it is no longer open. */
  async function settle(botId: string, dedupeKey: string, resolution: BotIssueResolution): Promise<boolean> {
    const settled = await dependencies.store.change(botId, (issues) => {
      const index = issues.findIndex((issue) => isOpen(issue) && issue.dedupeKey === dedupeKey);
      if (index < 0) return { issues, result: undefined };
      const next = [...issues];
      next[index] = { ...issues[index]!, resolvedAt: dependencies.now(), resolution };
      return { issues: next, result: next[index]! };
    });
    if (settled === undefined) return false;
    await dependencies.appendEntry(botId, BOT_ISSUE_STATUS_ENTRY_KIND, statusEntry(settled));
    notify(botId);
    return true;
  }

  return {
    async raise(input) {
      // A title is one line; a body may carry a line break, so both are only
      // trimmed and capped, never reflowed.
      const title = bound(input.title.replace(/\s+/gu, " "), BOT_ISSUE_LIMITS.titleChars) || "Needs you";
      const body = bound(input.body, BOT_ISSUE_LIMITS.bodyChars);
      const raised = await dependencies.store.change(input.botId, (issues) => {
        const existing = issues.find((issue) => isOpen(issue) && issue.dedupeKey === input.dedupeKey);
        if (existing) return { issues, result: { issue: existing, created: false, superseded: undefined } };

        const at = dependencies.now();
        const issue: BotIssue = {
          id: randomUUID(),
          botId: input.botId,
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          title,
          body,
          ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
          actions: input.actions.slice(0, 2),
          createdAt: at,
        };
        const open = issues.filter(isOpen);
        // The ninth open issue settles the oldest: the person always has at
        // most eight decisions, and the card they lose says why it left.
        const oldest =
          open.length < BOT_ISSUE_LIMITS.openPerBot
            ? undefined
            : [...open].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
        const superseded =
          oldest === undefined ? undefined : { ...oldest, resolvedAt: at, resolution: "superseded" as const };
        return {
          issues: [issue, ...(superseded === undefined ? issues : issues.map((row) => (row.id === superseded.id ? superseded : row)))],
          result: { issue, created: true, superseded },
        };
      });

      if (!raised.created) return raised.issue;
      if (raised.superseded) {
        await dependencies.appendEntry(input.botId, BOT_ISSUE_STATUS_ENTRY_KIND, statusEntry(raised.superseded));
      }
      await dependencies.appendEntry(input.botId, BOT_ISSUE_ENTRY_KIND, raised.issue);
      notify(input.botId);
      await dependencies.funnel.deliver({
        botId: input.botId,
        class: "issue",
        dedupeKey: `issue:${raised.issue.id}`,
        title: raised.issue.title,
        body: raised.issue.body,
        status: "info",
      });
      return raised.issue;
    },

    resolve(botId, dedupeKey, resolution) {
      return settle(botId, dedupeKey, resolution);
    },

    async act(botId, issueId, action) {
      const issue = (await dependencies.store.read(botId)).find((row) => row.id === issueId);
      if (!issue || !isOpen(issue)) return "not_open";
      // Only what this issue offers is answerable: a stale card's other
      // action, or another issue's, never runs anything.
      if (!issue.actions.some((offered) => sameAction(offered, action))) return "invalid";
      switch (action.kind) {
        case "resume_routine":
          await dependencies.actions.resumeRoutine(botId, action.routineId);
          await settle(botId, issue.dedupeKey, "fixed");
          return "done";
        case "stop_run":
          await dependencies.actions.stopRun(botId);
          await settle(botId, issue.dedupeKey, "fixed");
          return "done";
        case "keep_waiting":
          dependencies.actions.snoozeStall(botId);
          await settle(botId, issue.dedupeKey, "dismissed");
          return "done";
        case "open_settings":
          // Opening settings is not a fix: the issue stays until its condition
          // clears (or the person keeps waiting), so the card never lies.
          dependencies.actions.openSettings(botId, action.section);
          return "done";
        case "open_chat":
          // The surface opened the Bot's conversation; nothing to record.
          return "done";
      }
    },

    async list(botId, options) {
      const issues = await dependencies.store.read(botId);
      return options?.open ? issues.filter(isOpen) : issues;
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
