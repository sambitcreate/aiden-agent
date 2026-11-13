// The rules page's one list (docs/plans/bot-ux-simplification.md §3.5, §7):
// the page's own rules plus every grant Aiden kept from before it, each still
// stored where it always was. Nothing is copied between stores or owners:
//
//   a workspace's remembered exact command or file    Always allow, that workspace
//   a Bot's "Always allow for {Bot}" (allow list)      Always allow, that Bot
//   a Bot's custom rule                               Always ask, that Bot, in words
//   a Bot's built-in rule set to Hand off to me        Always ask with Do it myself
//   a folder a Bot may change                          Mac grants, that Bot
//   "Allowed in this workspace" on a Mac card          Mac grants, that workspace
//   "Allowed in this chat" on a Bot's Mac card         Mac grants, that Bot's chat
//
// A legacy row answers only for its original owner because its old store
// still answers for it, and Remove goes through that store, so the allow
// list's receipts, tombstones and tallies keep protecting it (a removed entry
// is never restored by a replayed decision).

import {
  BOT_LOCKED_RULES,
  botRuleLabel,
  botRuleRefusalText,
  type BotRuleChange,
  type BotRulesUpdateResult,
  type BotRulesView,
} from "../../../renderer/shared/bot-rules.js";
import {
  approvalRuleDecisionsFor,
  approvalRuleKindLabel,
  describeApprovalRuleTarget,
  type ApprovalRule,
  type ApprovalRuleAddInput,
  type ApprovalRuleChangeInput,
  type ApprovalRulePickerOption,
  type ApprovalRuleRow,
  type ApprovalRuleRowRef,
  type ApprovalRuleTarget,
  type ApprovalRulesView,
} from "../../../renderer/shared/approval-rules.js";
import {
  MAC_GRANT_LABELS,
  workspaceApprovalPolicy,
  type ApprovalWorkspaceFields,
  type MacGrantClass,
} from "../../../renderer/shared/approval-mode.js";
import {
  describeToolApprovalRule,
  type BotAllowedEntry,
  type BotApprovalRuleView,
  type ToolApprovalRuleView,
} from "../../../renderer/shared/tool-approval-scope.js";
import { ApprovalRulesUnreadableError, type ApprovalRuleBook } from "./store.js";

export interface ApprovalRulesPageBot {
  id: string;
  name: string;
}

export interface ApprovalRulesPageWorkspace extends ApprovalWorkspaceFields {
  id: string;
  name: string;
}

/** "Allowed in this chat" on a Bot's Mac card. */
export interface BotChatMacGrantView {
  id: string;
  botId: string;
  chatLabel?: string;
  grant: MacGrantClass;
  createdAt: string;
}

export interface ApprovalRulesPagePorts {
  book: Pick<ApprovalRuleBook, "list" | "add" | "change" | "remove" | "refresh" | "setAside">;
  /** A workspace's remembered exact commands and files. */
  workspaceExact: { list(): Promise<ToolApprovalRuleView[]>; revoke(id: string): Promise<boolean> };
  /** Bots' allow lists and folders; their receipts protect every removal. */
  botAllowed?: {
    list(): Promise<BotAllowedEntry[]>;
    remove(botId: string, entryId: string): Promise<boolean>;
    targets(botId: string): Promise<BotApprovalRuleView[]>;
  };
  botRules?: {
    get(botId: string): Promise<BotRulesView>;
    update(botId: string, revision: number, change: BotRuleChange): Promise<BotRulesUpdateResult>;
  };
  botChatMac?: { list(): Promise<BotChatMacGrantView[]>; revoke(botId: string, grantId: string): Promise<boolean> };
  /** The legacy Computer Use switch "Always allow in every chat". */
  computerUseEverywhere?: { get(): Promise<boolean>; turnOff(): Promise<void> };
  bots(): Promise<ApprovalRulesPageBot[]>;
  workspaces(): Promise<ApprovalRulesPageWorkspace[]>;
  revokeWorkspaceMac(workspaceId: string, grant: MacGrantClass): Promise<void>;
  picker(): Promise<ApprovalRulePickerOption[]>;
  log?(message: string, error: unknown): void;
}

export interface ApprovalRulesPage {
  list(): Promise<ApprovalRulesView>;
  picker(): Promise<ApprovalRulePickerOption[]>;
  add(input: ApprovalRuleAddInput): Promise<ApprovalRule>;
  change(input: ApprovalRuleChangeInput): Promise<{ changed: boolean }>;
  remove(ref: ApprovalRuleRowRef): Promise<{ removed: boolean }>;
  /** Read an unreadable rules file again, after a hand edit. */
  refresh(): Promise<ApprovalRulesView>;
  /** Put an unreadable rules file aside (its bytes kept) and start with no rules. */
  setAside(): Promise<ApprovalRulesView>;
}

const MAC_GRANT_KIND: Readonly<Record<MacGrantClass, string>> = {
  shell: "Commands",
  files: "Files",
  "computer-use": "Computer Use",
};

function byNewest(a: ApprovalRuleRow, b: ApprovalRuleRow): number {
  return (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.title.localeCompare(b.title);
}

export function createApprovalRulesPage(ports: ApprovalRulesPagePorts): ApprovalRulesPage {
  const log = (message: string, error: unknown) => ports.log?.(message, error);

  async function botNames(): Promise<Map<string, string>> {
    try {
      return new Map((await ports.bots()).map((bot) => [bot.id, bot.name]));
    } catch (error) {
      log("Could not read Bots for the rules page.", error);
      return new Map();
    }
  }

  async function ruleRows(names: Map<string, string>, workspaces: Map<string, string>): Promise<ApprovalRuleRow[] | "unreadable"> {
    let rules: ApprovalRule[];
    try {
      rules = await ports.book.list();
    } catch (error) {
      if (error instanceof ApprovalRulesUnreadableError) return "unreadable";
      throw error;
    }
    return rules.flatMap((rule): ApprovalRuleRow[] => {
      const owner = rule.owner;
      // A rule whose Bot or workspace is gone answers for nobody; it is listed
      // to remove, with nothing to change, until the owner's deletion forgets it.
      const orphan = (owner.kind === "bot" && !names.has(owner.botId)) || (owner.kind === "workspace" && !workspaces.has(owner.workspaceId));
      if (orphan) {
        return [{
          ref: { source: "rule", id: rule.id },
          group: rule.decision,
          title: describeApprovalRuleTarget(rule.target, rule.label),
          kind: approvalRuleKindLabel(rule.target.kind),
          scope: owner.kind === "bot" ? { kind: "bot", label: "a deleted Bot" } : { kind: "workspace", label: "a deleted workspace" },
          legacy: true,
          decisions: [],
          createdAt: rule.createdAt,
        }];
      }
      return [{
        ref: { source: "rule", id: rule.id },
        group: rule.decision,
        title: describeApprovalRuleTarget(rule.target, rule.label),
        kind: approvalRuleKindLabel(rule.target.kind),
        scope: owner.kind === "mac" ? { kind: "mac" }
          : owner.kind === "workspace" ? { kind: "workspace", label: workspaces.get(owner.workspaceId) ?? "Workspace" }
            : { kind: "bot", label: names.get(owner.botId)! },
        ...(owner.kind === "bot" ? { legacy: true as const } : {}),
        decisions: approvalRuleDecisionsFor(rule.target),
        ...(rule.target.kind === "text" && rule.decision === "ask" ? { handOff: { on: rule.handOff === true } } : {}),
        createdAt: rule.createdAt,
      }];
    });
  }

  async function workspaceExactRows(workspaces: Map<string, string>): Promise<ApprovalRuleRow[]> {
    return (await ports.workspaceExact.list()).map((rule) => ({
      ref: { source: "workspace-exact", id: rule.id },
      group: "allow",
      title: describeToolApprovalRule(rule),
      kind: rule.toolName === "run_command" ? "Command" : "File",
      scope: { kind: "workspace", label: workspaces.get(rule.workspaceId) ?? rule.workspaceLabel ?? "Workspace" },
      legacy: true,
      // An exact rule can be dropped (Ask), never widened into a Block of every command.
      decisions: ["allow", "ask"],
      createdAt: rule.createdAt,
    }));
  }

  async function botAllowedRows(names: Map<string, string>): Promise<ApprovalRuleRow[]> {
    if (!ports.botAllowed) return [];
    const entries = await ports.botAllowed.list();
    const rows: ApprovalRuleRow[] = [];
    const targets = new Map<string, BotApprovalRuleView[]>();
    for (const entry of entries) {
      const name = names.get(entry.botId);
      if (name === undefined) continue;
      if (entry.kind === "folder") {
        rows.push({
          ref: { source: "bot-folder", botId: entry.botId, entryId: entry.id },
          group: "mac",
          title: entry.what,
          kind: "Folder",
          scope: { kind: "bot", label: name },
          legacy: true,
          decisions: [],
          createdAt: entry.createdAt,
        });
        continue;
      }
      if (!targets.has(entry.botId)) targets.set(entry.botId, await ports.botAllowed.targets(entry.botId));
      const target = targets.get(entry.botId)!.find((rule) => rule.id === entry.id)?.target;
      rows.push({
        ref: { source: "bot-allow", botId: entry.botId, entryId: entry.id },
        group: "allow",
        title: entry.what,
        kind: target?.kind === "site" ? "Site" : "Tool",
        scope: { kind: "bot", label: name },
        legacy: true,
        decisions: target ? ["allow", "ask", "block"] : ["allow", "ask"],
        createdAt: entry.createdAt,
      });
    }
    return rows;
  }

  async function botRuleRows(names: Map<string, string>): Promise<ApprovalRuleRow[]> {
    if (!ports.botRules) return [];
    const rows: ApprovalRuleRow[] = [];
    for (const [botId, name] of names) {
      let view: BotRulesView;
      try {
        view = await ports.botRules.get(botId);
      } catch (error) {
        log("Could not read a Bot's rules for the rules page.", error);
        continue;
      }
      // An unreadable file reads as the defaults; the Bot refuses its ruled calls until it is saved again.
      if (view.unreadable) continue;
      for (const rule of view.rules) {
        if (rule.locked) continue;
        if (rule.actionClass !== undefined && rule.behavior !== "hand_off") continue;
        rows.push({
          ref: { source: "bot-rule", botId, ruleId: rule.id },
          group: "ask",
          title: botRuleLabel(rule),
          kind: rule.actionClass === undefined ? "When a Bot wants to" : "Built-in",
          scope: { kind: "bot", label: name },
          legacy: true,
          // A built-in rule can only stop handing off (back to the default ask).
          decisions: rule.actionClass === undefined ? ["ask", "block"] : ["ask"],
          handOff: { on: rule.behavior === "hand_off" },
        });
      }
    }
    return rows;
  }

  async function macRows(workspaces: ApprovalRulesPageWorkspace[], names: Map<string, string>): Promise<ApprovalRuleRow[]> {
    const rows: ApprovalRuleRow[] = [];
    for (const workspace of workspaces) {
      const policy = workspaceApprovalPolicy(workspace, "ask");
      if (policy.chatOnly) continue;
      for (const grant of policy.macGrants) {
        rows.push({
          ref: { source: "workspace-mac", workspaceId: workspace.id, grant },
          group: "mac",
          title: MAC_GRANT_LABELS[grant],
          kind: MAC_GRANT_KIND[grant],
          scope: { kind: "workspace", label: workspace.name },
          ...(policy.legacyFull ? { legacy: true as const } : {}),
          decisions: [],
        });
      }
    }
    if (ports.botChatMac) {
      for (const grant of await ports.botChatMac.list()) {
        const name = names.get(grant.botId);
        if (name === undefined) continue;
        rows.push({
          ref: { source: "bot-chat-mac", botId: grant.botId, grantId: grant.id },
          group: "mac",
          title: MAC_GRANT_LABELS[grant.grant],
          kind: MAC_GRANT_KIND[grant.grant],
          scope: { kind: "chat", label: grant.chatLabel ? `${name} · ${grant.chatLabel}` : name },
          decisions: [],
          createdAt: grant.createdAt,
        });
      }
    }
    if (ports.computerUseEverywhere && (await ports.computerUseEverywhere.get())) {
      rows.push({
        ref: { source: "computer-use-everywhere" },
        group: "mac",
        title: MAC_GRANT_LABELS["computer-use"],
        kind: MAC_GRANT_KIND["computer-use"],
        scope: { kind: "mac", label: "Every chat" },
        legacy: true,
        decisions: [],
      });
    }
    return rows;
  }

  async function botRuleChange(botId: string, change: BotRuleChange): Promise<void> {
    const rules = ports.botRules;
    if (!rules) throw new Error("This rule can’t be changed here.");
    const view = await rules.get(botId);
    const result = await rules.update(botId, view.revision, change);
    if (!result.ok) throw new Error(botRuleRefusalText(result.reason));
  }

  async function botRuleOf(botId: string, ruleId: string) {
    const rule = (await ports.botRules?.get(botId))?.rules.find((candidate) => candidate.id === ruleId);
    if (!rule || BOT_LOCKED_RULES.some((locked) => locked.id === rule.id)) throw new Error(botRuleRefusalText("not_found"));
    return rule;
  }

  async function botAllowTarget(botId: string, entryId: string): Promise<ApprovalRuleTarget | undefined> {
    const target = (await ports.botAllowed?.targets(botId))?.find((rule) => rule.id === entryId)?.target;
    if (!target) return undefined;
    return target.kind === "site"
      ? { kind: "site", host: target.host }
      : { kind: "connector-tool", serverId: target.serverId, tool: target.tool };
  }

  const page: ApprovalRulesPage = {
    async list() {
      const [names, workspaceList] = await Promise.all([botNames(), ports.workspaces()]);
      const workspaces = new Map(workspaceList.map((workspace) => [workspace.id, workspace.name]));
      const [own, ...others] = await Promise.all([
        ruleRows(names, workspaces),
        workspaceExactRows(workspaces),
        botAllowedRows(names),
        botRuleRows(names),
        macRows(workspaceList, names),
      ]);
      const rows = [...(own === "unreadable" ? [] : own), ...others.flat()].sort(byNewest);
      return own === "unreadable" ? { rows, unreadable: true } : { rows };
    },

    async refresh() {
      await ports.book.refresh();
      return page.list();
    },

    async setAside() {
      await ports.book.setAside();
      return page.list();
    },

    picker: () => ports.picker(),

    async add(input) {
      return ports.book.add({
        target: input.target,
        decision: input.decision,
        owner: input.owner ?? { kind: "mac" },
        ...(input.handOff ? { handOff: true } : {}),
        ...(input.label ? { label: input.label } : {}),
      });
    },

    async change({ ref, decision, handOff }) {
      switch (ref.source) {
        case "rule":
          return { changed: await ports.book.change(ref.id, { ...(decision ? { decision } : {}), ...(handOff === undefined ? {} : { handOff }) }) };
        case "workspace-exact":
          if (handOff !== undefined || decision === "block") throw new Error("This rule can only be allowed or asked.");
          return { changed: decision === "ask" ? await ports.workspaceExact.revoke(ref.id) : false };
        case "bot-allow": {
          if (handOff !== undefined || !ports.botAllowed) throw new Error("This rule can’t be changed here.");
          if (decision === "allow" || decision === undefined) return { changed: false };
          // Read the target first: once removed, the entry no longer names it.
          const target = decision === "block" ? await botAllowTarget(ref.botId, ref.entryId) : undefined;
          if (decision === "block" && !target) throw new Error("This allowance changed. Try again.");
          // The Block is saved before the allowance goes: a target the rule
          // book can't hold throws here and the allowance stays as it was.
          if (target) await ports.book.add({ target, decision: "block", owner: { kind: "bot", botId: ref.botId } });
          const removed = await ports.botAllowed.remove(ref.botId, ref.entryId);
          return { changed: removed || target !== undefined };
        }
        case "bot-rule": {
          const rule = await botRuleOf(ref.botId, ref.ruleId);
          if (rule.actionClass !== undefined) {
            if (decision !== undefined && decision !== "ask") throw new Error("A built-in rule always asks or hands the step to you.");
            if (handOff === undefined) return { changed: false };
            await botRuleChange(ref.botId, { type: "set_behavior", ruleId: rule.id, behavior: handOff ? "hand_off" : "ask" });
            return { changed: true };
          }
          if (decision === "block") {
            // Words that now block: the Bot's own Block rule, then the old rule goes.
            await ports.book.add({ target: { kind: "text", text: rule.text ?? "" }, decision: "block", owner: { kind: "bot", botId: ref.botId } });
            await botRuleChange(ref.botId, { type: "remove_custom", ruleId: rule.id });
            return { changed: true };
          }
          if (decision === "allow") throw new Error("A rule in your own words can only ask or block.");
          if (handOff === undefined) return { changed: false };
          await botRuleChange(ref.botId, { type: "edit_custom", ruleId: rule.id, behavior: handOff ? "hand_off" : "ask" });
          return { changed: true };
        }
        default:
          throw new Error("This grant can only be removed.");
      }
    },

    async remove(ref) {
      switch (ref.source) {
        case "rule":
          return { removed: await ports.book.remove(ref.id) };
        case "workspace-exact":
          return { removed: await ports.workspaceExact.revoke(ref.id) };
        case "bot-allow":
        case "bot-folder":
          if (!ports.botAllowed) return { removed: false };
          return { removed: await ports.botAllowed.remove(ref.botId, ref.entryId) };
        case "bot-rule": {
          const rule = await botRuleOf(ref.botId, ref.ruleId);
          // A built-in rule can't be removed; Remove stops it handing off.
          await botRuleChange(ref.botId, rule.actionClass === undefined
            ? { type: "remove_custom", ruleId: rule.id }
            : { type: "set_behavior", ruleId: rule.id, behavior: "ask" });
          return { removed: true };
        }
        case "workspace-mac":
          await ports.revokeWorkspaceMac(ref.workspaceId, ref.grant);
          return { removed: true };
        case "bot-chat-mac":
          return { removed: ports.botChatMac ? await ports.botChatMac.revoke(ref.botId, ref.grantId) : false };
        case "computer-use-everywhere":
          if (!ports.computerUseEverywhere) return { removed: false };
          await ports.computerUseEverywhere.turnOff();
          return { removed: true };
      }
    },
  };
  return page;
}
