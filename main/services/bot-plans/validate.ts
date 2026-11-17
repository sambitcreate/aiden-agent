import { createHash } from "node:crypto";
import { BOT_PLAN_LIMITS, type BotPlanItem } from "../../../renderer/shared/bot-plans.js";
import { botToolApp } from "../../../renderer/shared/bot-activity.js";
import { BOT_LOCKED_RULES, botRuleLabel, normalizeBotRuleText, type BotRule } from "../../../renderer/shared/bot-rules.js";
import { withoutBotHandoffControls } from "../../../renderer/shared/bot-handoffs.js";
import { botAccessAuthorizationOf } from "../../../renderer/shared/bot-access-requests.js";
import { localComputerNoun } from "../../../renderer/shared/computer-noun.js";
import { describeMcpAction } from "../bot-rules/mcp-action.js";
import { isPaymentHost } from "../bot-rules/words.js";
import { COMPUTER_USE_TOOL_NAME } from "../computer-use/tool.js";
import type { BotToolFacts } from "../bot-runtime/bot-tool-policy.js";
import type { BotPlanAccessPort, BotPlanAuthorization } from "./ports.js";

export interface BotPlanProposal {
  title: string; why: string; steps: string[]; items: BotPlanItem[]; authorization: BotPlanAuthorization;
}
export type BotPlanValidation = { ok: true; proposal: BotPlanProposal } | { ok: false; problems: string[] };
export interface BotPlanValidationContext {
  botId: string; facts: BotToolFacts; policyRevision: string; bindingRevision: string;
  rules: readonly BotRule[]; access?: BotPlanAccessPort;
}

/** Object key order is irrelevant; array order is part of the approved identity. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/** Share this with call-time Ask first rule references; an edited rule never inherits approval. */
export function botPlanRuleFingerprint(rule: BotRule): string {
  return hash({ id: rule.id, behavior: rule.behavior, locked: rule.locked, actionClass: rule.actionClass,
    text: rule.text === undefined ? undefined : normalizeBotRuleText(withoutBotHandoffControls(rule.text)) });
}

export function botPlanProposalFingerprint(proposal: BotPlanProposal): string {
  const { proposalFingerprint: _own, ...authorization } = proposal.authorization;
  return hash({ title: proposal.title, why: proposal.why, steps: proposal.steps, items: proposal.items, authorization });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
function clean(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const text = withoutBotHandoffControls(v).replace(/\s+/gu, " ").trim();
  return text.length > 0 && [...text].length <= max ? text : undefined;
}

export async function validateBotPlanProposal(input: unknown, context: BotPlanValidationContext): Promise<BotPlanValidation> {
  const problems: string[] = [];
  if (!object(input) || !keys(input, ["title", "why", "steps", "covers"])) return { ok: false, problems: ["Use only title, why, steps and covers."] };
  const title = clean(input.title, BOT_PLAN_LIMITS.titleChars), why = clean(input.why, BOT_PLAN_LIMITS.whyChars);
  if (!title) problems.push("Give the plan a title of up to 80 characters.");
  if (!why) problems.push("Give a reason of up to 300 characters.");
  const steps: string[] = [];
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > BOT_PLAN_LIMITS.steps) problems.push("Use 1 to 10 steps.");
  else for (const step of input.steps) {
    const text = object(step) && keys(step, ["text"]) ? clean(step.text, BOT_PLAN_LIMITS.stepChars) : undefined;
    if (text) steps.push(text); else problems.push("Each step needs only text, up to 200 characters.");
  }
  if (!Array.isArray(input.covers) || !input.covers.length || input.covers.length > BOT_PLAN_LIMITS.covers) return { ok: false, problems: [...problems, "Use 1 to 8 coverage items."] };
  if (!context.policyRevision || !context.bindingRevision) problems.push("The Bot's current authorization is unavailable.");
  const items: BotPlanItem[] = [];
  const rules: { id: string; fingerprint: string }[] = [];
  let folder: BotPlanAuthorization["folder"];
  let outside = 0;
  for (const [index, raw] of input.covers.entries()) {
    const id = `i${index + 1}`;
    if (!object(raw)) { problems.push(`Item ${index + 1} isn't a coverage item.`); continue; }
    const count = (): number | undefined => {
      if (raw.max === undefined) return BOT_PLAN_LIMITS.defaultMax;
      if (!Number.isInteger(raw.max) || (raw.max as number) < 1 || (raw.max as number) > BOT_PLAN_LIMITS.maxCeiling) {
        problems.push(`Item ${index + 1} needs a limit from 1 to 25.`); return undefined;
      }
      return raw.max as number;
    };
    if ("connector" in raw) {
      if (!keys(raw, ["connector", "action", "tools", "max"]) || !clean(raw.connector, BOT_PLAN_LIMITS.actionChars) || !clean(raw.action, BOT_PLAN_LIMITS.actionChars) || !Array.isArray(raw.tools) || !raw.tools.length || raw.tools.length > BOT_PLAN_LIMITS.toolsPerItem || raw.tools.some((t) => typeof t !== "string" || !t || t.length > 256) || new Set(raw.tools).size !== raw.tools.length) {
        problems.push(`Item ${index + 1} needs a connector, action and 1 to 5 exact tool names.`); continue;
      }
      const max = count();
      const tools: Extract<BotPlanItem, { kind: "connector" }>["tools"] = [];
      for (const name of raw.tools as string[]) {
        if (name === COMPUTER_USE_TOOL_NAME) { problems.push("Computer Use on the person's Mac always asks on its own card."); continue; }
        try {
          const grant = (await context.facts.mcpTools()).get(name);
          if (!grant) { problems.push(`${name} isn't a granted connected-app tool.`); continue; }
          if (grant.effect !== "mutating") { problems.push(`${name} doesn't need approval; leave it out.`); continue; }
          const action = await describeMcpAction(name, {}, context.facts);
          if (action?.surface !== "mcp" || !action.serverId || !action.remoteName) { problems.push(`${name} isn't a granted connected-app tool.`); continue; }
          tools.push({ modelName: name, serverId: action.serverId, remoteName: action.remoteName, title: clean(action.annotations?.title, 200) ?? action.remoteName });
        } catch { problems.push(`${name}'s current tool binding couldn't be verified.`); }
      }
      if (new Set(tools.map((t) => t.serverId)).size > 1) problems.push("A connector item must name tools from one connection.");
      if (max !== undefined && tools.length === raw.tools.length) items.push({ id, kind: "connector", app: botToolApp(tools[0]!.modelName) ?? clean(raw.connector, BOT_PLAN_LIMITS.actionChars)!, action: clean(raw.action, BOT_PLAN_LIMITS.actionChars)!, tools, max });
    } else if ("site" in raw) {
      if (!keys(raw, ["site", "action", "max"]) || typeof raw.site !== "string" || raw.site.length > 2048 || raw.action !== "browse") { problems.push(`Item ${index + 1} needs a site and action browse.`); continue; }
      const max = count();
      let host: string | undefined;
      try {
        const url = new URL(raw.site.includes("://") ? raw.site : `https://${raw.site}`);
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.hostname.length <= 253 && /^[a-z0-9.-]+$/u.test(url.hostname) && url.hostname.includes(".") && !url.hostname.endsWith(".")) host = url.hostname.toLowerCase();
      } catch { /* Invalid sites never match. */ }
      if (!host) problems.push(`${raw.site} isn't a site hostname.`);
      else if (isPaymentHost(host)) problems.push("Payments always go to the person.");
      else if (!context.facts.authority.otherCapabilities.some((c) => c.kind === "browser")) problems.push("The browser is off for this Bot.");
      else if (max !== undefined) items.push({ id, kind: "site", host, max });
    } else if ("files" in raw) {
      if (!keys(raw, ["files", "action"]) || typeof raw.files !== "string" || !raw.files.trim() || raw.files.includes("\0") || Buffer.byteLength(raw.files) > 4096 || (raw.action !== "read" && raw.action !== "write")) { problems.push(`Item ${index + 1} needs a folder and read or write access.`); continue; }
      const requested = raw.files.trim();
      if (requested === "/" || requested === "whole_mac") { problems.push(`Ask for the whole ${localComputerNoun(process.platform)} with request_access on its own.`); continue; }
      try {
        const scope = await context.access?.scopeOf(context.botId, requested, raw.action);
        if (scope?.kind === "inside") items.push({ id, kind: "files", path: requested, access: raw.action, grant: false });
        else if (scope?.kind === "outside") {
          const captured = botAccessAuthorizationOf(scope.authorization);
          if (!captured || captured.target !== "folder") problems.push(`${requested} isn't a folder this Bot can use.`);
          else {
            outside++;
            if (outside > 1) problems.push("A plan can open one folder outside this Bot's access.");
            else { folder = captured; items.push({ id, kind: "files", path: captured.root, access: raw.action, grant: true }); }
          }
        } else problems.push(`${requested} isn't a folder this Bot can use.`);
      } catch { problems.push(`${requested} isn't a folder this Bot can use.`); }
    } else if ("shell" in raw) {
      if (!keys(raw, ["shell"]) || raw.shell !== "bot_home") problems.push("Commands can be declared only in the Bot's own folder.");
      else if (!context.facts.authority.shell.enabled) problems.push("The shell is off for this Bot.");
      else items.push({ id, kind: "shell" });
    } else if ("rule" in raw) {
      if (!keys(raw, ["rule", "max"]) || !clean(raw.rule, 200)) { problems.push(`Item ${index + 1} needs an exact rule id or label.`); continue; }
      const max = count(), name = clean(raw.rule, 200)!;
      const rule = [...BOT_LOCKED_RULES, ...context.rules].find((r) => r.id === name || botRuleLabel(r).toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"));
      if (!rule) problems.push(`${name} isn't one of this Bot's rules.`);
      else if (rule.locked || BOT_LOCKED_RULES.some((r) => r.id === rule.id)) problems.push("Passwords, codes and money always go to the person.");
      else if (rule.behavior !== "ask") problems.push(`${botRuleLabel(rule)} hands steps to the person; a plan can't cover it.`);
      else if (max !== undefined) {
        const fingerprint = botPlanRuleFingerprint(rule);
        rules.push({ id: rule.id, fingerprint });
        items.push({ id, kind: "rule", ruleId: rule.id, ruleFingerprint: fingerprint, label: botRuleLabel(rule), max });
      }
    } else problems.push(`Item ${index + 1} isn't a recognized coverage item.`);
  }
  if (problems.length) return { ok: false, problems };
  const proposal: BotPlanProposal = { title: title!, why: why!, steps, items, authorization: {
    policyRevision: context.policyRevision, bindingRevision: context.bindingRevision, proposalFingerprint: "", rules,
    ...(folder ? { folder } : {}),
  } };
  proposal.authorization.proposalFingerprint = botPlanProposalFingerprint(proposal);
  return { ok: true, proposal: freeze(proposal) };
}
