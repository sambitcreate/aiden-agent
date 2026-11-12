// One pure approval gate for every surface that runs tools: workspace chats,
// Bot turns, subagents and ACP harness permission requests
// (docs/plans/bot-ux-simplification.md §3.2).
//
// The steps run in Rakazo's order:
//
//   1. block            a hook denied it, access refuses it, its authority went
//                       stale, or the person already declined it in this run
//   2. money            purchases, money, credentials and anything a rule hands
//                       to the person: the person does it (or the run refuses)
//   3. explicit-only    asks once in every mode, never remembered
//   4. never ask        Full access, and the run-scoped pre-approvals
//   5. ask rule         a rule asks first
//   6. new destination  (Phase 2: taint tracking; never fires yet)
//   7. always allow     a remembered grant covers it
//   8. consequential    asks
//   9. otherwise        allow
//
// Phase 1 configures the gate to reproduce the decisions Aiden made before it
// existed, row for row (decision-table.test.ts). The facts below are today's
// inputs: a workspace's access stands in for the global mode until Phase 2.
//
// Callers keep every side effect. When the gate needs a fact that costs a
// read (a remembered approval, a plan's cover, a Bot's allow list), it
// returns `lookup` naming it, at the step that reads it; the caller reads it
// and asks the gate again with the answer, so a read only happens where the
// gate would act on it.

export type GateSurface = "workspace" | "bot" | "subagent" | "acp";

/** Today's workspace access, standing in for the global mode until Phase 2. */
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
  | "ask-rule"
  | "new-destination"
  | "always-allow"
  | "consequential"
  | "default";

export interface GateContext {
  surface: GateSurface;
  access: GateAccess;
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
  /** Runs on the person's Mac itself: Computer Use. Never pre-approved for a run. */
  mac?: boolean;
  /** Changes or sends something, so it asks where the mode asks. */
  consequential?: boolean;
  /** Asks in every mode, once only, and is never remembered. */
  explicitOnly?: boolean;
  /** Its own policy decides, and may show its own card (memory). */
  delegate?: "memory";
  /** The strictest of the Bot's rules that matched the call. */
  rule?: GateRule;
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
  | "peer";

export type GateAskOffer =
  /** Allow once and Deny only. */
  | "once"
  /** Allow once, for this chat, or always in this workspace. */
  | "workspace-scopes"
  /** The Bot's allow list may remember it. */
  | "bot-remember"
  /** A rule made this card. */
  | "rule";

export type GateAllowVia =
  | "full-access"
  | "routine-go-ahead"
  | "plan"
  | "remembered"
  | "hook-allow"
  | "allow-list"
  | "grant";

export type GateDecision =
  | { outcome: "block"; step: GateStep; reason: GateBlockReason }
  | { outcome: "hand-off"; step: "money" }
  | { outcome: "ask"; step: GateStep; offer: GateAskOffer }
  | { outcome: "allow"; step: GateStep; via?: GateAllowVia }
  | { outcome: "delegate"; step: "explicit-only"; to: "memory" }
  | { outcome: "lookup"; step: GateStep; lookup: "remembered" | "plan" | "allow-list" };

const UNWATCHED: ReadonlySet<GateAttendance> = new Set(["routine", "unattended", "peer"]);

/** Whether a decision would show the person a card. */
export function gateAsks(decision: GateDecision): decision is Extract<GateDecision, { outcome: "ask" }> {
  return decision.outcome === "ask";
}

export function planActionGate(context: GateContext, action: GateAction): GateDecision {
  const attendance = context.attendance ?? "person";
  const unwatched = UNWATCHED.has(attendance);
  const needsAnswer = action.consequential === true || action.rule !== undefined;

  // 1. Block.
  if (context.hook === "deny") return { outcome: "block", step: "block", reason: "hook" };
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

  // 3. Explicit-only: asks once in every mode. A hook's ask is one too.
  if (action.delegate) return { outcome: "delegate", step: "explicit-only", to: action.delegate };
  if (action.explicitOnly || context.hook === "ask") return { outcome: "ask", step: "explicit-only", offer: "once" };

  // 4. Never ask: Full access, and the run-scoped pre-approvals. The person's
  // Mac itself (Computer Use) is never pre-approved this way.
  if (needsAnswer && !action.mac) {
    if (action.rule === undefined && context.access !== "ask") {
      return { outcome: "allow", step: "never-ask", via: "full-access" };
    }
    if (context.routineGoAhead && attendance === "routine") {
      return { outcome: "allow", step: "never-ask", via: "routine-go-ahead" };
    }
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

  // 6. New destination: taint tracking arrives with Phase 2.

  // 7. Always allow: a remembered grant covers it.
  if (action.granted) return { outcome: "allow", step: "always-allow", via: "grant" };
  if (action.consequential && action.rememberable) {
    if (context.hook === "allow") return { outcome: "allow", step: "always-allow", via: "hook-allow" };
    if (action.remembered === undefined) return { outcome: "lookup", step: "always-allow", lookup: "remembered" };
    if (action.remembered !== "none") return { outcome: "allow", step: "always-allow", via: "remembered" };
  }
  if (action.consequential && action.allowListAvailable) {
    if (action.allowList === undefined) return { outcome: "lookup", step: "always-allow", lookup: "allow-list" };
    if (action.allowList === "match") return { outcome: "allow", step: "always-allow", via: "allow-list" };
  }

  // 8. Consequential: asks.
  if (action.consequential) {
    return {
      outcome: "ask",
      step: "consequential",
      offer: action.rememberable ? "workspace-scopes" : action.allowListAvailable ? "bot-remember" : "once",
    };
  }

  // 9. Otherwise allow.
  return { outcome: "allow", step: "default" };
}
