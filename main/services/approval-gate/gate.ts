// One pure approval gate for every surface that runs tools: workspace chats,
// Bot turns, subagents and ACP harness permission requests
// (docs/plans/bot-ux-simplification.md §3.2).
//
// The steps run in Rakazo's order:
//
//   1. block            a hook denied it, a Block rule on the rules page, access
//                       refuses it, its authority went stale, or the person
//                       already declined it in this run
//   2. money            purchases, money, credentials and anything a rule hands
//                       to the person: the person does it (or the run refuses)
//   3. explicit-only    asks once in every mode, never remembered
//   4. never ask        the Never ask mode, and the run-scoped pre-approvals
//   5. ask rule         a Bot's rule or an Always-ask rule asks first
//   6. new destination  after outside content: judged in Auto, asked in Ask
//   7. always allow     a remembered grant or an Always-allow rule covers it
//                       (a rule never covers the person's Mac)
//   8. consequential    judged in Auto, asked in Ask; the Mac always asks
//   9. otherwise        allow
//
// Phase 1 configured the gate to reproduce the decisions Aiden made before it
// existed, row for row (decision-table.test.ts). Phase 2 adds the global mode
// (Ask / Auto / Never ask), the Mac class, the exempt set, taint and the
// judge. A caller that names no mode gets its access's legacy mode: Full
// access is Never ask, anything else is Ask, so those rows still hold.
//
// The judge only ever runs at steps 6 and 8. It passes or defers, never
// denies, and an explicit-only tool or the person's Mac is never judged.
//
// Callers keep every side effect. When the gate needs a fact that costs a
// read (a remembered approval, a plan's cover, a Bot's allow list), it
// returns `lookup` naming it, at the step that reads it; the caller reads it
// and asks the gate again with the answer, so a read only happens where the
// gate would act on it.

import type { ApprovalMode, MacGrantClass } from "../../../renderer/shared/approval-mode.js";

export type GateSurface = "workspace" | "bot" | "subagent" | "acp";

/** The run's folder access ("none" and "read-only" refuse consequential ACP and subagent calls). */
export type GateAccess = "full" | "ask" | "read-only" | "none";

/** Who started or joined the run the call belongs to. */
export type GateAttendance =
  | "person"
  /** Only routine inputs. */
  | "routine"
  /** Nobody is watching: a routine mixed with other inputs, Telegram. */
  | "unattended"
  /** A message from another Bot. */
  | "bot-message"
  /** Another Bot's delegated work. */
  | "peer";

export type GateStep =
  | "block"
  | "money"
  | "explicit-only"
  | "never-ask"
  | "exempt"
  | "ask-rule"
  | "new-destination"
  | "always-allow"
  | "consequential"
  | "default";

export interface GateContext {
  surface: GateSurface;
  access: GateAccess;
  /**
   * The approval mode in force for this run (§3.1). Absent: the legacy mode
   * of `access` (`gateMode`).
   */
  mode?: ApprovalMode;
  /**
   * This caller can ask the judge. Without one, Auto fails closed to a card
   * wherever it would judge.
   */
  judge?: boolean;
  /** The PreToolUse hooks' verdict, when a hook answered. */
  hook?: "deny" | "ask" | "allow";
  attendance?: GateAttendance;
  /**
   * The legacy routines switch "Go ahead without asking" applies to this run:
   * it is on, every input is a routine's, and the run carries routine inputs.
   */
  routineGoAhead?: boolean;
}

export interface GateRule {
  behavior: "ask" | "hand_off";
  /** One of the locked rules (passwords and codes, money). */
  locked: boolean;
}

export interface GateAction {
  toolName: string;
  /**
   * Runs on the person's Mac itself: a shell command, a file change or
   * Computer Use. Its first use asks in every mode, it is never judged, and
   * only a grant (`granted` or `macGranted`) lets it run without a card.
   */
  mac?: boolean;
  /** Which part of the Mac, so a card can offer "Allow in this workspace" for it. */
  macClass?: MacGrantClass;
  /** "Allowed in this workspace" (or chat) covers this part of the Mac. */
  macGranted?: boolean;
  /** One of the Bot's own things (§3.2 Exempt): never asks. */
  exempt?: boolean;
  /**
   * After outside content entered the run: the first use of a connector in the
   * run, or a fetch to a site the person did not name (§3.2 Taint).
   */
  newDestination?: boolean;
  /** The judge's verdict for this action, once asked (Auto only). */
  judge?: "pass" | "defer";
  /** Changes or sends something, so it asks where the mode asks. */
  consequential?: boolean;
  /** Asks in every mode, once only, and is never remembered. */
  explicitOnly?: boolean;
  /** Its own policy decides, and may show its own card (memory). */
  delegate?: "memory";
  /** The strictest of the Bot's rules that matched the call. */
  rule?: GateRule;
  /**
   * The rules page's decision for this call (§3.5): Block refuses at step 1,
   * Ask asks at step 5, Allow allows at step 7. Never covers the Mac.
   * "unreadable": the rules file couldn't be read exactly, so the call asks
   * once in every mode (step 3), since the rule it can't see may be a Block.
   */
  pageRule?: "allow" | "ask" | "block" | "unreadable";
  /** The authority this call was admitted under changed. */
  stale?: boolean;
  /** The person declined this exact action earlier in this run. */
  declinedInRun?: boolean;
  /**
   * A grant that already covers the call: a chat's Computer Use access or a
   * subagent's run grant.
   */
  granted?: boolean;
  /** A workspace scope target exists, so the card can offer remembered scopes. */
  rememberable?: boolean;
  /** The remembered workspace approval for that target, once read. */
  remembered?: "chat" | "always" | "none";
  /** A plan covering this run can pre-approve the call. */
  planAvailable?: boolean;
  /** Whether that plan covers the call, once asked. */
  plan?: "covered" | "not-covered";
  /** The Bot's allow list can answer for this call. */
  allowListAvailable?: boolean;
  /** Whether a remembered entry matched, once read. */
  allowList?: "match" | "no-match";
}

export type GateBlockReason =
  | "hook"
  | "no-access"
  | "stale"
  | "declined"
  | "needs-person"
  | "unattended-rule"
  | "peer"
  /** A Block rule on the rules page. */
  | "rule"
  /** A run nobody started (a routine) cannot ask; it refuses and reports. */
  | "unattended";

export type GateAskOffer =
  /** Allow once and Deny only. */
  | "once"
  /** Allow once, for this chat, or always in this workspace. */
  | "workspace-scopes"
  /** The Bot's allow list may remember it. */
  | "bot-remember"
  /** A rule made this card. */
  | "rule"
  /** A Mac card: Allow once, or allow this part of the Mac in this workspace (or chat). */
  | "mac";

export type GateAllowVia =
  | "full-access"
  | "never-ask"
  | "exempt"
  | "judge"
  | "routine-go-ahead"
  | "plan"
  | "remembered"
  | "hook-allow"
  | "allow-list"
  | "grant"
  /** An Always-allow rule on the rules page. */
  | "rule";

export type GateDecision =
  | { outcome: "block"; step: GateStep; reason: GateBlockReason }
  | { outcome: "hand-off"; step: "money" }
  | { outcome: "ask"; step: GateStep; offer: GateAskOffer }
  | { outcome: "allow"; step: GateStep; via?: GateAllowVia }
  | { outcome: "delegate"; step: "explicit-only"; to: "memory" }
  | { outcome: "lookup"; step: GateStep; lookup: "remembered" | "plan" | "allow-list" | "judge" };

const UNWATCHED: ReadonlySet<GateAttendance> = new Set(["routine", "unattended", "peer"]);

/** Whether a decision would show the person a card. */
export function gateAsks(decision: GateDecision): decision is Extract<GateDecision, { outcome: "ask" }> {
  return decision.outcome === "ask";
}

/**
 * The mode a context runs in: its own, or its access's legacy mode. Before
 * modes, only "ask" access asked; Full and the internal read-only policy (its
 * mutating tools are withheld) ran without a card.
 */
export function gateMode(context: GateContext): ApprovalMode {
  return context.mode ?? (context.access === "ask" ? "ask" : "never");
}

export function planActionGate(context: GateContext, action: GateAction): GateDecision {
  const decision = decide(context, action);
  // A routine has nobody to ask: where the gate would show a card, the step
  // is refused and reported instead (§3.2 Unattended runs).
  if (decision.outcome === "ask" && (context.attendance ?? "person") === "routine") {
    return { outcome: "block", step: decision.step, reason: "unattended" };
  }
  return decision;
}

function decide(context: GateContext, action: GateAction): GateDecision {
  const attendance = context.attendance ?? "person";
  const unwatched = UNWATCHED.has(attendance);
  const mode = gateMode(context);
  const needsAnswer =
    action.consequential === true || action.rule !== undefined || action.pageRule === "ask" || action.pageRule === "unreadable";
  // The person's Mac with no grant covering it: asks in every mode.
  const macOpen = action.mac === true && action.granted !== true && action.macGranted !== true;

  // 1. Block.
  if (context.hook === "deny") return { outcome: "block", step: "block", reason: "hook" };
  if (action.pageRule === "block") return { outcome: "block", step: "block", reason: "rule" };
  if (action.stale) return { outcome: "block", step: "block", reason: "stale" };
  if (action.declinedInRun) return { outcome: "block", step: "block", reason: "declined" };
  if (action.consequential && context.surface !== "workspace" && (context.access === "read-only" || context.access === "none")) {
    // A workspace chat is never offered a tool its access lacks; an ACP agent
    // or a subagent that asks for one is refused.
    return { outcome: "block", step: "block", reason: "no-access" };
  }
  if (attendance === "peer" && needsAnswer && action.rule?.behavior !== "hand_off") {
    // Another Bot's delegated work has nobody to ask.
    return { outcome: "block", step: "block", reason: "peer" };
  }

  // 2. Purchases, money, credentials and hand-off rules: the person does it.
  if (action.rule?.behavior === "hand_off") {
    if (unwatched || attendance === "bot-message") return { outcome: "block", step: "money", reason: "needs-person" };
    return { outcome: "hand-off", step: "money" };
  }

  // 3. Explicit-only: asks once in every mode, Never ask included, and is
  // never judged. A hook's ask is one too.
  if (action.delegate) return { outcome: "delegate", step: "explicit-only", to: action.delegate };
  if (action.explicitOnly || context.hook === "ask" || action.pageRule === "unreadable") {
    return { outcome: "ask", step: "explicit-only", offer: "once" };
  }

  // 4. Never ask, and the run-scoped pre-approvals. The person's Mac is never
  // pre-approved this way; only its grant lets it run.
  if (needsAnswer && !macOpen) {
    if (mode === "never" && (action.rule === undefined || context.mode !== undefined)) {
      // Legacy Full access never answered a Bot's rule; the chosen Never ask
      // mode does ("Only Block rules apply").
      return { outcome: "allow", step: "never-ask", via: context.mode === undefined ? "full-access" : "never-ask" };
    }
    if (context.routineGoAhead && attendance === "routine") {
      return { outcome: "allow", step: "never-ask", via: "routine-go-ahead" };
    }
  }
  if (mode === "never" && action.newDestination && !macOpen && !needsAnswer) {
    return { outcome: "allow", step: "never-ask", via: "never-ask" };
  }
  if (needsAnswer && action.planAvailable) {
    if (action.plan === undefined) return { outcome: "lookup", step: "never-ask", lookup: "plan" };
    if (action.plan === "covered") return { outcome: "allow", step: "never-ask", via: "plan" };
  }

  // 5. A rule asks first.
  if (action.rule?.behavior === "ask") {
    // Nobody can answer a card a rule made on a call that needed none.
    if (!action.consequential && unwatched) return { outcome: "block", step: "ask-rule", reason: "unattended-rule" };
    return { outcome: "ask", step: "ask-rule", offer: "rule" };
  }
  if (action.pageRule === "ask") {
    // As a Bot's own rule: nobody can answer a card on a call that needed none.
    if (!action.consequential && unwatched) return { outcome: "block", step: "ask-rule", reason: "unattended-rule" };
    return { outcome: "ask", step: "ask-rule", offer: "once" };
  }

  // The Bot's own things never ask on their own account; a rule the person
  // wrote (above) still does.
  if (action.exempt) return { outcome: "allow", step: "exempt", via: "exempt" };

  // 6. New destination after outside content entered the run.
  if (action.newDestination && !macOpen) {
    const judged = judgeStep(context, action, mode, "new-destination");
    if (judged) return judged;
  }

  // 7. Always allow: a remembered grant covers it.
  if (action.granted) return { outcome: "allow", step: "always-allow", via: "grant" };
  // An Always-allow rule never reaches the person's Mac; only its grant does.
  if (action.pageRule === "allow" && !action.mac) return { outcome: "allow", step: "always-allow", via: "rule" };
  if (action.mac && action.macGranted) return { outcome: "allow", step: "always-allow", via: "grant" };
  if (action.consequential && action.rememberable) {
    if (context.hook === "allow") return { outcome: "allow", step: "always-allow", via: "hook-allow" };
    if (action.remembered === undefined) return { outcome: "lookup", step: "always-allow", lookup: "remembered" };
    if (action.remembered !== "none") return { outcome: "allow", step: "always-allow", via: "remembered" };
  }
  if (action.consequential && action.allowListAvailable) {
    if (action.allowList === undefined) return { outcome: "lookup", step: "always-allow", lookup: "allow-list" };
    if (action.allowList === "match") return { outcome: "allow", step: "always-allow", via: "allow-list" };
  }

  // 8. Consequential: the Mac always asks; the rest is judged in Auto.
  if (action.consequential) {
    if (!action.mac) {
      const judged = judgeStep(context, action, mode, "consequential");
      if (judged) return judged;
    }
    return {
      outcome: "ask",
      step: "consequential",
      offer: action.mac && action.macClass ? "mac" : action.rememberable ? "workspace-scopes" : action.allowListAvailable ? "bot-remember" : "once",
    };
  }
  if (action.newDestination && macOpen) {
    return { outcome: "ask", step: "new-destination", offer: "once" };
  }

  // 9. Otherwise allow.
  return { outcome: "allow", step: "default" };
}

/**
 * Steps 6 and 8 in Auto: the judge's pass allows, anything else asks. Without
 * a judge, or outside Auto, a new destination asks and a consequential call
 * falls through to its card. Fails closed.
 */
function judgeStep(
  context: GateContext,
  action: GateAction,
  mode: ApprovalMode,
  step: "new-destination" | "consequential",
): GateDecision | undefined {
  if (mode === "auto" && context.judge === true) {
    if (action.judge === undefined) return { outcome: "lookup", step, lookup: "judge" };
    if (action.judge === "pass") return { outcome: "allow", step, via: "judge" };
  }
  return step === "new-destination" ? { outcome: "ask", step, offer: "once" } : undefined;
}
