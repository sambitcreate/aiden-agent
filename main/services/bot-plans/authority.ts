import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BOT_LOCKED_RULES, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { BOT_PLAN_MAX_MS } from "../../../renderer/shared/bot-plans.js";
import { botAccessAuthorizationOf, type BotAccessAuthorization } from "../../../renderer/shared/bot-access-requests.js";
import { coveredByBotLocations, type BotAccessResolution } from "../bot-runtime/bot-access-target.js";
import { BotAccessRequestStaleError } from "../bot-runtime/bot-access-requests.js";
import type { BotRuntimeEffectiveAuthority } from "../bot-runtime-authority.js";
import type { BotFileToolLocation } from "../bot-file-tool-router.js";
import type { BotRunAccess } from "../bot-runtime/bot-run-access.js";
import type { BotAdmission } from "../bot-runtime/bot-tool-assembly.js";
import type { BotToolCall } from "../bot-runtime/tool-adapter.js";
import type { BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import type { BotPlanAccessPort } from "./ports.js";
import { botPlanProposalFingerprint, botPlanRuleFingerprint, validateBotPlanProposal, type BotPlanProposal, type BotPlanValidation } from "./validate.js";

export interface BotPlanAuthorityDeps {
  admit(botId: string): Promise<BotAdmission>;
  facts(botId: string, admission: BotAdmission): Promise<BotToolFacts>;
  rules(botId: string): Promise<readonly BotRule[]>;
  /** Fixed locations only. Never include run.access or run.saved aliases. */
  locations(admission: BotAdmission): Promise<readonly BotFileToolLocation[]>;
  resolveTarget(requested: string): Promise<BotAccessResolution>;
  runAccess: BotRunAccess;
  now?(): number;
  homeDirectory?(): string;
}
export interface BotPlanAuthority {
  validate(botId: string, input: unknown, call?: BotToolCall): Promise<BotPlanValidation>;
  revalidate(botId: string, capturedProposal: BotPlanProposal): Promise<void>;
  access: BotPlanAccessPort;
  revokeAccess(botId: string, planId: string): void;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function effectiveRules(rules: readonly BotRule[]): BotRule[] {
  const locked = new Set(BOT_LOCKED_RULES.map((r) => r.id));
  const ordinary = rules.filter((r) => !locked.has(r.id));
  if (new Set(ordinary.map((r) => r.id)).size !== ordinary.length) throw stale();
  return [...ordinary, ...BOT_LOCKED_RULES];
}
/** Full authority, including inventory/provider/tool effects, and every effective rule. */
export function botPlanBindingRevision(authority: Readonly<BotRuntimeEffectiveAuthority>, rules: readonly BotRule[]): string {
  const refs = effectiveRules(rules).map((r) => ({ id: r.id, fingerprint: botPlanRuleFingerprint(r) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash("sha256").update(canonical({ authority, rules: refs })).digest("hex");
}
function stale(): BotAccessRequestStaleError { return new BotAccessRequestStaleError("This Bot's plan authorization changed. Propose a new plan."); }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function ownerIds(value: readonly string[] | undefined): string[] | undefined {
  if (!value?.length || value.length > 256 || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 256 || /[\p{Cc}\p{Cf}]/u.test(id)) || new Set(value).size !== value.length) return undefined;
  return [...value];
}
function sameIds(left: readonly string[], right: readonly string[]): boolean { return canonical([...left].sort()) === canonical([...right].sort()); }
function assertLive(admission: BotAdmission, botId: string, call?: BotToolCall) {
  if (admission.authority.botId !== botId || admission.signal.aborted || call?.signal.aborted) throw stale();
}
interface Folder { root: string; identity: { device: string; inode: string } }

export function createBotPlanAuthority(deps: BotPlanAuthorityDeps): BotPlanAuthority {
  const now = deps.now ?? Date.now;
  async function folderOf(requested: string): Promise<Folder | undefined> {
    if (!requested || requested === "whole_mac" || Buffer.byteLength(requested) > 4096 || /[\p{Cc}\p{Cf}]/u.test(requested)) return undefined;
    const home = (deps.homeDirectory ?? os.homedir)();
    const expanded = requested === "~" ? home : requested.startsWith("~/") ? path.join(home, requested.slice(2)) : requested;
    if (!path.isAbsolute(expanded)) return undefined;
    try {
      let root = await fs.realpath(expanded), stat = await fs.stat(root, { bigint: true });
      if (!stat.isDirectory()) { root = path.dirname(root); stat = await fs.stat(root, { bigint: true }); }
      if (!stat.isDirectory() || root === path.parse(root).root) return undefined;
      return { root, identity: { device: String(stat.dev), inode: String(stat.ino) } };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return undefined;
    }
  }
  async function fixedLocations(admission: BotAdmission): Promise<BotFileToolLocation[]> {
    const locations = await deps.locations(admission), fixed: BotFileToolLocation[] = [];
    for (const location of locations) {
      if (location.id === "run.access" || location.id === "run.saved") throw stale();
      const root = await fs.realpath(location.root), stat = await fs.stat(root, { bigint: true });
      if (!stat.isDirectory() || (location.expectedIdentity && (location.expectedIdentity.device !== String(stat.dev) || location.expectedIdentity.inode !== String(stat.ino)))) throw stale();
      fixed.push({ ...location, root });
    }
    return fixed;
  }
  function authorization(admission: BotAdmission, target: Extract<BotAccessResolution, { kind: "folder" }>, ids: readonly string[]): BotAccessAuthorization {
    return { policyRevision: admission.authority.botPolicy.revision, requestIds: [...ids], target: "folder", root: target.root,
      identity: { device: target.device, inode: target.inode }, choices: ["not_now", "once"],
      ...(target.always.kind === "existing" ? { rootId: target.always.rootId } : {}),
      ...(target.inventoryRevision === undefined ? {} : { inventoryRevision: target.inventoryRevision }) };
  }
  function matchesTarget(auth: BotAccessAuthorization, target: BotAccessResolution): boolean {
    return target.kind === "folder" && target.root === auth.root && target.device === auth.identity?.device && target.inode === auth.identity?.inode && target.inventoryRevision === auth.inventoryRevision &&
      (target.always.kind === "existing" ? target.always.rootId : undefined) === auth.rootId;
  }
  async function scope(admission: BotAdmission, fixed: readonly BotFileToolLocation[], requested: string, access: "read" | "write", ids?: readonly string[]): Promise<Awaited<ReturnType<BotPlanAccessPort["scopeOf"]>>> {
    const folder = await folderOf(requested);
    if (!folder) return { kind: "invalid" };
    // Fixed own-home access is authoritative even though B rejects private
    // storage as a source of NEW grants. The ordinary file router still fences it.
    if (coveredByBotLocations(folder.root, fixed, access)) return { kind: "inside" };
    if (admission.authority.accessMode !== "custom" || admission.authority.files.mode !== "scoped" || !ownerIds(ids)) return { kind: "invalid" };
    const target = await deps.resolveTarget(folder.root);
    if (target.kind !== "folder" || target.root !== folder.root || target.device !== folder.identity.device || target.inode !== folder.identity.inode) return { kind: "invalid" };
    const captured = botAccessAuthorizationOf(authorization(admission, target, ids!));
    return captured ? { kind: "outside", authorization: captured } : { kind: "invalid" };
  }
  async function finalFence(botId: string, admission: BotAdmission, expectedBinding: string, call?: BotToolCall) {
    await call?.assertRunActive?.();
    await admission.revalidateBeforeEffect();
    // Read rules after all other awaited fences. Signals and the full binding
    // are checked synchronously after this final read, before returning authority.
    const rules = await deps.rules(botId);
    assertLive(admission, botId, call);
    if (botPlanBindingRevision(admission.authority, rules) !== expectedBinding) throw stale();
  }
  async function validate(botId: string, input: unknown, call?: BotToolCall, originalIds?: readonly string[]): Promise<BotPlanValidation> {
    const normalized = structuredClone(input);
    await call?.assertRunActive?.();
    if (call?.signal.aborted) throw stale();
    const admission = await deps.admit(botId);
    try {
      assertLive(admission, botId, call);
      const facts = await deps.facts(botId, admission), rules = effectiveRules(await deps.rules(botId)), fixed = await fixedLocations(admission);
      if (canonical(facts.authority) !== canonical(admission.authority)) throw stale();
      const bindingRevision = botPlanBindingRevision(admission.authority, rules);
      const ids = originalIds === undefined ? ownerIds(await call?.runInputIds?.()) : ownerIds(originalIds);
      // Canonicalize only file values; retain every key so the core's strict
      // shape validator still rejects extra or malformed input unchanged.
      if (record(normalized) && Array.isArray(normalized.covers)) for (const item of normalized.covers) {
        if (record(item) && typeof item.files === "string") { const folder = await folderOf(item.files.trim()); if (folder) item.files = folder.root; }
      }
      const result = await validateBotPlanProposal(normalized, { botId, facts, rules, policyRevision: admission.authority.botPolicy.revision, bindingRevision,
        access: { ...access, scopeOf: async (id, requested, required) => id === botId ? scope(admission, fixed, requested, required, ids) : { kind: "invalid" } } });
      if (result.ok && result.proposal.authorization.folder) {
        const auth = result.proposal.authorization.folder;
        if (!matchesTarget(auth, await deps.resolveTarget(auth.root))) throw stale();
      }
      await finalFence(botId, admission, bindingRevision, call);
      assertLive(admission, botId, call);
      return result;
    } finally { admission.release(); }
  }
  const revokeAccess = (botId: string, planId: string) => deps.runAccess.revokeOwner(botId, { kind: "plan", id: planId });
  const access: BotPlanAccessPort = {
    async scopeOf(botId, requested, required) {
      const admission = await deps.admit(botId);
      try {
        assertLive(admission, botId);
        const rules = await deps.rules(botId), binding = botPlanBindingRevision(admission.authority, rules), fixed = await fixedLocations(admission);
        const result = await scope(admission, fixed, requested, required);
        await finalFence(botId, admission, binding);
        assertLive(admission, botId);
        return result;
      } finally { admission.release(); }
    },
    async allowOnce(botId, input) {
      const grant = structuredClone(input);
      const auth = botAccessAuthorizationOf(grant.authorization), ids = ownerIds(grant.requestIds);
      if (!auth || auth.target !== "folder" || !ids || !sameIds(auth.requestIds, ids) || grant.path !== auth.root ||
          !/^[A-Za-z0-9-]{1,64}$/u.test(grant.planId) || (grant.access !== "read" && grant.access !== "write") || !Number.isFinite(grant.expiresAt) || now() >= grant.expiresAt) throw stale();
      const admission = await deps.admit(botId);
      try {
        assertLive(admission, botId);
        if (admission.authority.accessMode !== "custom" || admission.authority.files.mode !== "scoped" || admission.authority.botPolicy.revision !== auth.policyRevision) throw stale();
        const fixed = await fixedLocations(admission);
        if (coveredByBotLocations(auth.root, fixed, grant.access) || !matchesTarget(auth, await deps.resolveTarget(auth.root))) throw stale();
        const folder = await folderOf(auth.root);
        if (!folder || folder.root !== auth.root || canonical(folder.identity) !== canonical(auth.identity)) throw stale();
        await admission.revalidateBeforeEffect();
        // B's root inventory can change independently of this Bot's binding
        // while the awaited authority fence runs. Read its final target after
        // that await; then synchronously check the live leases and time.
        if (!matchesTarget(auth, await deps.resolveTarget(auth.root))) throw stale();
        // No awaited I/O between the final admission/time check and grant.
        assertLive(admission, botId);
        const grantedAt = now(), expiresAt = Math.min(grant.expiresAt, grantedAt + BOT_PLAN_MAX_MS);
        if (!Number.isFinite(grantedAt) || grantedAt < 0 || grantedAt >= expiresAt || admission.authority.botPolicy.revision !== auth.policyRevision) throw stale();
        deps.runAccess.grant(botId, { requestIds: [...auth.requestIds], target: "folder", key: auth.root, root: auth.root, label: path.basename(auth.root), identity: { ...auth.identity! }, policyRevision: auth.policyRevision,
          access: grant.access, owner: { kind: "plan", id: grant.planId }, grantedAt, expiresAt });
      } finally { admission.release(); }
    },
    revokePlan: revokeAccess,
  };
  return {
    validate: (botId, input, call) => validate(botId, input, call),
    async revalidate(botId, capturedProposal) {
      const captured = structuredClone(capturedProposal), fingerprint = botPlanProposalFingerprint(captured);
      if (captured.authorization.proposalFingerprint !== fingerprint) throw stale();
      const covers = captured.items.map((item) => {
        switch (item.kind) {
          case "connector": return { connector: item.app, action: item.action, tools: item.tools.map((tool) => tool.modelName), max: item.max };
          case "site": return { site: item.host, action: "browse", max: item.max };
          case "files": return { files: item.path, action: item.access };
          case "shell": return { shell: "bot_home" };
          case "rule": return { rule: item.ruleId, max: item.max };
        }
      });
      const result = await validate(botId, { title: captured.title, why: captured.why, steps: captured.steps.map((text) => ({ text })), covers }, undefined, captured.authorization.folder?.requestIds);
      if (!result.ok || result.proposal.authorization.proposalFingerprint !== fingerprint) throw stale();
    },
    access,
    revokeAccess,
  };
}
