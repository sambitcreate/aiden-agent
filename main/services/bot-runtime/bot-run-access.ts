import {
  BOT_RUN_ACCESS_LOCATION_ID,
  BOT_RUN_ACCESS_LOCATION_LABEL,
} from "../../../renderer/shared/bot-access-requests.js";
import type { BotFileToolLocation } from "../bot-file-tool-router.js";
import type { BotSessionState } from "./bot-session-service.js";
import path from "node:path";
import { botRunUnattended } from "./bot-tool-policy.js";
import { BotAccessRequestStaleError } from "./bot-access-requests.js";

export const BOT_RUN_ACCESS_MAX_AGE_MS = 60 * 60_000;
export const BOT_RUN_SAVED_LOCATION_ID = "run.saved";
export const BOT_RUN_SAVED_LOCATION_LABEL = "Folder approved in this task";
export interface BotRunAccessOwner {
  signal: AbortSignal;
  deadline: number;
}
export interface BotRunAccessCurrentCall { signal: AbortSignal; validate(): Promise<void> }
export interface BotRunAccessGrant {
  requestIds: readonly string[];
  target: "folder" | "whole_mac";
  key: string;
  root: string;
  label: string;
  identity?: { device: string; inode: string };
  policyRevision: string;
  access: "read" | "write";
  owner: { kind: "access" | "plan"; id: string };
  expiresAt: number;
  grantedAt: number;
}
export interface BotRunAccess {
  grant(botId: string, grant: BotRunAccessGrant): void;
  /** Host-only: record the exact validated Always publication, never a fresh capability read or memo. */
  recordPublication(botId: string, grant: BotRunAccessGrant, owner: BotRunAccessOwner): void;
  savedLocation(botId: string, requestIds: readonly (string | undefined)[], policyRevision: string, current: BotRunAccessCurrentCall): Promise<BotFileToolLocation | undefined>;
  location(
    botId: string,
    requestIds: readonly (string | undefined)[],
    policyRevision: string,
  ): BotFileToolLocation | undefined;
  decline(botId: string, requestIds: readonly string[], key: string): void;
  declined(botId: string, requestIds: readonly (string | undefined)[], key: string): boolean;
  revokeOwner(botId: string, owner: { kind: "access" | "plan"; id: string }): void;
  clearBot(botId: string): void;
  /** App shutdown also clears interrupted runs, which emit no terminal state. */
  clearAll(): void;
}
const joined = (left: readonly string[], right: readonly (string | undefined)[]) =>
  left.some((id) => right.includes(id));
export function createBotRunAccess(deps: { now(): number }): BotRunAccess {
  const grants = new Map<string, BotRunAccessGrant[]>();
  const publications = new Map<string, { grant: BotRunAccessGrant; owner: BotRunAccessOwner }>();
  const declines = new Map<string, { requestIds: readonly string[]; key: string }[]>();
  const checkedGrant = (grant: BotRunAccessGrant): BotRunAccessGrant => {
      if (
        !grant.requestIds.length ||
        !Number.isFinite(grant.grantedAt) ||
        !Number.isFinite(grant.expiresAt)
      )
        throw new Error("A run grant needs an owner and a bounded lifetime.");
      if (
        grant.requestIds.some((id) => typeof id !== "string" || !id.trim()) ||
        !grant.owner.id ||
        !["access", "plan"].includes(grant.owner.kind) ||
        !["read", "write"].includes(grant.access) ||
        !grant.policyRevision ||
        !path.isAbsolute(grant.root) ||
        (grant.target === "whole_mac"
          ? grant.root !== "/" || grant.key !== "whole_mac"
          : grant.root === "/" ||
            grant.key !== grant.root ||
            !grant.identity ||
            !/^(?:0|[1-9][0-9]*)$/u.test(grant.identity.device) ||
            !/^(?:0|[1-9][0-9]*)$/u.test(grant.identity.inode))
      )
        throw new Error("A run grant needs its exact target, pinned identity, policy and owner.");
      const copy = structuredClone(grant);
      copy.expiresAt = Math.min(copy.expiresAt, copy.grantedAt + BOT_RUN_ACCESS_MAX_AGE_MS);
      return copy;
  };
  return {
    grant(botId, grant) {
      const copy = checkedGrant(grant);
      grants.set(botId, [
        ...(grants.get(botId) ?? []).filter((old) => !joined(old.requestIds, grant.requestIds)),
        copy,
      ]);
    },
    recordPublication(botId, grant, owner) {
      const copy = checkedGrant(grant);
      if (copy.target !== "folder" || copy.owner.kind !== "access" || copy.access !== "write" ||
        owner.signal.aborted || !Number.isFinite(owner.deadline))
        throw new Error("A saved task location needs a live validated folder publication.");
      copy.expiresAt = Math.min(copy.expiresAt, owner.deadline);
      publications.set(botId, { grant: copy, owner: { signal: owner.signal, deadline: owner.deadline } });
    },
    async savedLocation(botId, requestIds, policyRevision, current) {
      const record = publications.get(botId);
      if (!record) return undefined;
      const { grant, owner } = record;
      const valid = () => grant.policyRevision === policyRevision && !owner.signal.aborted && !current.signal.aborted &&
        deps.now() >= grant.grantedAt && deps.now() < Math.min(grant.expiresAt, owner.deadline);
      if (!valid()) { publications.delete(botId); return undefined; }
      if (!joined(grant.requestIds, requestIds)) return undefined;
      try { await current.validate(); } catch (error) {
        if (error instanceof BotAccessRequestStaleError || !valid()) {
          if (publications.get(botId) === record) publications.delete(botId);
          return undefined;
        }
        // An operational read failure denies this call, without revoking the
        // original publication. The next call must validate it again.
        throw error;
      }
      if (publications.get(botId) !== record) return undefined;
      if (!valid()) { publications.delete(botId); return undefined; }
      return { id: BOT_RUN_SAVED_LOCATION_ID, label: BOT_RUN_SAVED_LOCATION_LABEL, root: grant.root,
        access: grant.access, expectedIdentity: { ...grant.identity! } };
    },
    location(botId, requestIds, policyRevision) {
      const now = deps.now();
      const valid = (grants.get(botId) ?? []).filter(
        (grant) =>
          grant.policyRevision === policyRevision &&
          now >= grant.grantedAt &&
          now < grant.expiresAt &&
          now - grant.grantedAt < BOT_RUN_ACCESS_MAX_AGE_MS,
      );
      grants.set(botId, valid);
      const unattended = botRunUnattended(requestIds);
      // Access cards authorize a person's task and joined person steers only.
      // Explicit plan-owned grants have their own permit enforcement and may
      // intentionally authorize a Bot turn after the person approves its plan.
      const grant = valid.find((candidate) => joined(candidate.requestIds, requestIds) &&
        (candidate.owner.kind === "plan" || !unattended));
      return grant
        ? {
            id: BOT_RUN_ACCESS_LOCATION_ID,
            label: BOT_RUN_ACCESS_LOCATION_LABEL,
            root: grant.root,
            access: grant.access,
            ...(grant.identity ? { expectedIdentity: { ...grant.identity } } : {}),
          }
        : undefined;
    },
    decline(botId, requestIds, key) {
      const records = declines.get(botId) ?? [];
      if (!records.some((entry) => entry.key === key && joined(entry.requestIds, requestIds)))
        records.push({ requestIds: [...requestIds], key });
      declines.set(botId, records);
    },
    declined: (botId, requestIds, key) =>
      (declines.get(botId) ?? []).some(
        (entry) => entry.key === key && joined(entry.requestIds, requestIds),
      ),
    revokeOwner(botId, owner) {
      const publication = publications.get(botId);
      if (publication?.grant.owner.kind === owner.kind && publication.grant.owner.id === owner.id) publications.delete(botId);
      grants.set(
        botId,
        (grants.get(botId) ?? []).filter(
          (grant) => grant.owner.kind !== owner.kind || grant.owner.id !== owner.id,
        ),
      );
    },
    clearBot(botId) {
      grants.delete(botId);
      publications.delete(botId);
      declines.delete(botId);
    },
    clearAll() {
      grants.clear();
      publications.clear();
      declines.clear();
    },
  };
}
export function botRunEnded(state: BotSessionState): boolean {
  return (
    state.kind !== "running" &&
    state.kind !== "interrupted" &&
    !(state.kind === "paused" && state.interrupted !== undefined)
  );
}
