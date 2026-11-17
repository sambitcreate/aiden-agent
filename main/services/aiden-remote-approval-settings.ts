// Aiden Remote contract revision 61 (provisional), `approvals:settings`: the
// Mac's approval mode and its rules page, for the person's own paired
// devices. The routes are person-only (no Bot or agent path reaches the
// Remote API) and fail closed: a rules file that cannot be read refuses every
// change, and a refusal never says more than the desktop page would.
//
// The service reuses the desktop's own rules page and the Settings save path;
// it adds parsing, wire validation and error mapping only.

import { AidenRemoteServiceError } from "./aiden-remote-errors.js";
import {
  APPROVAL_RULE_DECISIONS,
  parseApprovalRuleAddInput,
  parseApprovalRuleChangeInput,
  parseApprovalRuleDecision,
  parseApprovalRuleRowRef,
  parseApprovalRuleTarget,
  type ApprovalRuleAddInput,
  type ApprovalRuleChangeInput,
  type ApprovalRulePickerOption,
  type ApprovalRuleRow,
  type ApprovalRuleRowRef,
  type ApprovalRulesView,
} from "../../renderer/shared/approval-rules.js";
import type { ApprovalMode } from "../../renderer/shared/approval-mode.js";
import {
  parseAidenRemoteApprovalModeRequest,
  parseAidenRemoteApprovalModeView,
  type AidenRemoteApprovalModeView,
} from "./aiden-remote-bot-ux.js";

/** The desktop services the routes reuse. */
export interface AidenRemoteApprovalSettingsPorts {
  /** The mode this Mac runs in, and whether Auto can be chosen. */
  readMode(): Promise<AidenRemoteApprovalModeView>;
  /** Save the mode through the Settings path (effects and analytics included). */
  writeMode(mode: ApprovalMode): Promise<void>;
  rules: {
    list(): Promise<ApprovalRulesView>;
    picker(): Promise<ApprovalRulePickerOption[]>;
    add(input: ApprovalRuleAddInput): Promise<unknown>;
    change(input: ApprovalRuleChangeInput): Promise<{ changed: boolean }>;
    remove(ref: ApprovalRuleRowRef): Promise<{ removed: boolean }>;
  };
  log?(message: string, error: unknown): void;
}

const ROWS_MAX = 2_000;
const PICKER_MAX = 2_000;
const TITLE_MAX = 400;
const KIND_MAX = 80;
const LABEL_MAX = 200;
const GROUPS = ["allow", "ask", "block", "mac"] as const;
const SCOPES = ["mac", "workspace", "bot", "chat"] as const;
const UNREADABLE = "Your approval rules couldn’t be read. Fix them on your Mac first.";
const REFUSED = "That rule couldn’t be changed. Refresh and try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} has an unknown field.`);
}
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(`${label} is invalid.`);
  return value;
}

function parseRow(value: unknown): ApprovalRuleRow {
  if (!isRecord(value)) throw new Error("Rule row must be an object.");
  exactKeys(value, ["ref", "group", "title", "kind", "scope", "legacy", "decisions", "handOff", "createdAt"], "Rule row");
  if (!(GROUPS as readonly unknown[]).includes(value.group)) throw new Error("Rule row group is invalid.");
  if (!isRecord(value.scope) || !(SCOPES as readonly unknown[]).includes(value.scope.kind)) throw new Error("Rule row scope is invalid.");
  exactKeys(value.scope, ["kind", "label"], "Rule row scope");
  if (!Array.isArray(value.decisions) || value.decisions.length > APPROVAL_RULE_DECISIONS.length || value.decisions.some((decision) => !parseApprovalRuleDecision(decision))) {
    throw new Error("Rule row decisions are invalid.");
  }
  if (value.legacy !== undefined && value.legacy !== true) throw new Error("Rule row legacy is invalid.");
  if (value.handOff !== undefined && (!isRecord(value.handOff) || typeof value.handOff.on !== "boolean" || Object.keys(value.handOff).length !== 1)) {
    throw new Error("Rule row handOff is invalid.");
  }
  if (value.createdAt !== undefined && (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)))) {
    throw new Error("Rule row createdAt is invalid.");
  }
  return {
    ref: parseApprovalRuleRowRef(value.ref),
    group: value.group as ApprovalRuleRow["group"],
    title: boundedText(value.title, "Rule row title", TITLE_MAX),
    kind: boundedText(value.kind, "Rule row kind", KIND_MAX),
    scope: {
      kind: value.scope.kind as ApprovalRuleRow["scope"]["kind"],
      ...(value.scope.label !== undefined ? { label: boundedText(value.scope.label, "Rule row scope label", LABEL_MAX) } : {}),
    },
    ...(value.legacy === true ? { legacy: true as const } : {}),
    decisions: value.decisions as ApprovalRuleRow["decisions"],
    ...(isRecord(value.handOff) ? { handOff: { on: value.handOff.on as boolean } } : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
  };
}

/** `GET /approvals/rules` and every rules write: the page's rows, newest first. */
export function parseAidenRemoteApprovalRulesView(value: unknown): ApprovalRulesView {
  if (!isRecord(value)) throw new Error("Rules view must be an object.");
  exactKeys(value, ["rows", "unreadable"], "Rules view");
  if (!Array.isArray(value.rows) || value.rows.length > ROWS_MAX) throw new Error("Rules view rows are invalid.");
  if (value.unreadable !== undefined && value.unreadable !== true) throw new Error("Rules view unreadable is invalid.");
  return { rows: value.rows.map(parseRow), ...(value.unreadable === true ? { unreadable: true as const } : {}) };
}

/** `GET /approvals/rules/picker`: Add rule's options. */
export function parseAidenRemoteApprovalRulePicker(value: unknown): { options: ApprovalRulePickerOption[] } {
  if (!isRecord(value)) throw new Error("Rule picker must be an object.");
  exactKeys(value, ["options"], "Rule picker");
  if (!Array.isArray(value.options) || value.options.length > PICKER_MAX) throw new Error("Rule picker options are invalid.");
  return {
    options: value.options.map((option) => {
      if (!isRecord(option)) throw new Error("Rule picker option must be an object.");
      exactKeys(option, ["target", "label", "group", "description"], "Rule picker option");
      const target = parseApprovalRuleTarget(option.target);
      if (!target || target.kind === "text") throw new Error("Rule picker target is invalid.");
      return {
        target,
        label: boundedText(option.label, "Rule picker label", LABEL_MAX),
        group: boundedText(option.group, "Rule picker group", LABEL_MAX),
        ...(option.description !== undefined ? { description: boundedText(option.description, "Rule picker description", TITLE_MAX) } : {}),
      };
    }),
  };
}

function invalid(message: string): AidenRemoteServiceError {
  return new AidenRemoteServiceError("invalid_request", message, 400);
}

export class AidenRemoteApprovalSettingsService {
  constructor(private readonly ports: AidenRemoteApprovalSettingsPorts) {}

  async mode(): Promise<AidenRemoteApprovalModeView> {
    return parseAidenRemoteApprovalModeView(await this.ports.readMode());
  }

  async setMode(input: unknown): Promise<AidenRemoteApprovalModeView> {
    let mode: ApprovalMode;
    try {
      mode = parseAidenRemoteApprovalModeRequest(input);
    } catch {
      throw invalid("The approval mode is invalid.");
    }
    // Auto needs a model to judge with; the desktop does not offer it either.
    if (mode === "auto" && !(await this.ports.readMode()).autoAvailable) {
      throw invalid("Auto needs a model. Connect one on your Mac first.");
    }
    await this.ports.writeMode(mode);
    return this.mode();
  }

  async rules(): Promise<ApprovalRulesView> {
    return parseAidenRemoteApprovalRulesView(await this.ports.rules.list());
  }

  async picker(): Promise<{ options: ApprovalRulePickerOption[] }> {
    return parseAidenRemoteApprovalRulePicker({ options: await this.ports.rules.picker() });
  }

  async addRule(input: unknown): Promise<ApprovalRulesView> {
    let parsed: ApprovalRuleAddInput;
    try {
      parsed = parseApprovalRuleAddInput(input);
    } catch {
      throw invalid("The rule is invalid.");
    }
    return this.write(() => this.ports.rules.add(parsed));
  }

  async changeRule(input: unknown): Promise<ApprovalRulesView> {
    let parsed: ApprovalRuleChangeInput;
    try {
      parsed = parseApprovalRuleChangeInput(input);
    } catch {
      throw invalid("The rule change is invalid.");
    }
    return this.write(async () => {
      if (!(await this.ports.rules.change(parsed)).changed) throw gone();
    });
  }

  async removeRule(input: unknown): Promise<ApprovalRulesView> {
    let ref: ApprovalRuleRowRef;
    try {
      if (!isRecord(input) || Object.keys(input).some((key) => key !== "ref")) throw new Error("Invalid rule.");
      ref = parseApprovalRuleRowRef(input.ref);
    } catch {
      throw invalid("The rule is invalid.");
    }
    return this.write(async () => {
      if (!(await this.ports.rules.remove(ref)).removed) throw gone();
    });
  }

  /** Every write fails closed while the rules file can't be read, then returns the page as it now is. */
  private async write(change: () => Promise<unknown>): Promise<ApprovalRulesView> {
    const before = await this.ports.rules.list();
    if (before.unreadable) throw new AidenRemoteServiceError("revision_conflict", UNREADABLE, 409);
    try {
      await change();
    } catch (error) {
      if (error instanceof AidenRemoteServiceError) throw error;
      this.ports.log?.("A rules change from a paired device was refused.", error);
      throw new AidenRemoteServiceError("revision_conflict", REFUSED, 409);
    }
    return this.rules();
  }
}

function gone(): AidenRemoteServiceError {
  return new AidenRemoteServiceError("not_found", "That rule is no longer there.", 404);
}
