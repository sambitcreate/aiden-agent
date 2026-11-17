/**
 * Pure transitions for one chat's append-to-generation lease. The owner in
 * chat-turn-admission.ts keeps the timer, release callbacks and pool counters
 * and executes the effects returned here. See
 * docs/state-machines/chat-turn-admission.md.
 */

export type ChatTurnPoolName = "append" | "skill";

/** A pool's current charge and its limits, read by the owner for one event. */
export interface ChatTurnPool {
  readonly turns: number;
  readonly bytes: number;
  readonly maxTurns: number;
  readonly maxBytes: number;
}

export type ChatTurnSlot =
  | { readonly holder: "none" }
  | { readonly holder: "lease"; readonly bytes: number };

export interface ChatTurnLifecycle {
  readonly authority: "active" | "revoked";
  readonly preparation: "pending" | "settled";
  readonly registration: "none" | "registering";
  readonly append: ChatTurnSlot;
  readonly skill: ChatTurnSlot;
  readonly skillPrepared: boolean;
}

export type ChatTurnEvent =
  | { readonly type: "reserve-append"; readonly bytes: number; readonly pool: ChatTurnPool }
  | { readonly type: "reserve-skill"; readonly bytes: number; readonly pool: ChatTurnPool }
  | { readonly type: "prepare-skill"; readonly bytes: number }
  | { readonly type: "settle"; readonly retainAppend: boolean }
  | { readonly type: "revoke" }
  | { readonly type: "begin-registration" }
  | { readonly type: "registration-succeeded" }
  | { readonly type: "registration-failed" };

/** Effects run in order: the budget is complete before `finalize` is reached. */
export type ChatTurnEffect =
  | { readonly type: "budget"; readonly pool: ChatTurnPoolName; readonly turns: number; readonly bytes: number }
  | { readonly type: "revoked" }
  | { readonly type: "finalize" };

export type ChatTurnRejection = "unavailable" | "capacity" | "ignored";

export interface ChatTurnTransition {
  readonly state: ChatTurnLifecycle;
  readonly effects: readonly ChatTurnEffect[];
  readonly rejected?: ChatTurnRejection;
}

const EMPTY_SLOT: ChatTurnSlot = { holder: "none" };

export const INITIAL_CHAT_TURN_LIFECYCLE: ChatTurnLifecycle = {
  authority: "active",
  preparation: "pending",
  registration: "none",
  append: EMPTY_SLOT,
  skill: EMPTY_SLOT,
  skillPrepared: false,
};

function reject(state: ChatTurnLifecycle, rejected: ChatTurnRejection): ChatTurnTransition {
  return { state, effects: [], rejected };
}

function poolHasRoom(pool: ChatTurnPool, bytes: number): boolean {
  return pool.turns < pool.maxTurns && bytes <= pool.maxBytes - pool.bytes;
}

function refund(pool: ChatTurnPoolName, slot: ChatTurnSlot): ChatTurnEffect[] {
  return slot.holder === "lease"
    ? [{ type: "budget", pool, turns: -1, bytes: -slot.bytes }]
    : [];
}

/** Whether this turn may still start work. */
export function holdsChatTurnAuthority(state: ChatTurnLifecycle): boolean {
  return state.authority === "active";
}

/** Whether generation may take over from this lease. */
export function isChatTurnReadyForHandoff(state: ChatTurnLifecycle): boolean {
  return state.authority === "active" && state.preparation === "settled";
}

/** Whether a prepared skill could still be recorded, before its size is known. */
export function canPrepareChatTurnSkill(state: ChatTurnLifecycle): boolean {
  return (
    state.authority === "active" &&
    state.registration === "none" &&
    state.skill.holder === "lease" &&
    !state.skillPrepared
  );
}

/** Bytes the generation takes over if registration succeeds, when any. */
export function chatTurnSkillBytes(state: ChatTurnLifecycle): number | undefined {
  return state.skill.holder === "lease" ? state.skill.bytes : undefined;
}

/** Revoked, settled and out of registration: the lease has no reason to exist. */
function finish(state: ChatTurnLifecycle, effects: ChatTurnEffect[]): ChatTurnTransition {
  if (
    state.authority === "active" ||
    state.preparation === "pending" ||
    state.registration === "registering"
  ) {
    return { state, effects };
  }
  return {
    state: { ...state, append: EMPTY_SLOT, skill: EMPTY_SLOT },
    effects: [
      ...effects,
      ...refund("skill", state.skill),
      ...refund("append", state.append),
      { type: "finalize" },
    ],
  };
}

export function transitionChatTurn(
  state: ChatTurnLifecycle,
  event: ChatTurnEvent,
): ChatTurnTransition {
  const reservationsOpen = state.authority === "active" && state.registration === "none";
  switch (event.type) {
    case "reserve-append": {
      if (
        !reservationsOpen ||
        state.append.holder === "lease" ||
        !Number.isSafeInteger(event.bytes) ||
        event.bytes < 0
      ) {
        return reject(state, "unavailable");
      }
      if (!poolHasRoom(event.pool, event.bytes)) return reject(state, "capacity");
      return {
        state: { ...state, append: { holder: "lease", bytes: event.bytes } },
        effects: [{ type: "budget", pool: "append", turns: 1, bytes: event.bytes }],
      };
    }
    case "reserve-skill": {
      if (!reservationsOpen || state.skill.holder === "lease") return reject(state, "unavailable");
      if (!poolHasRoom(event.pool, event.bytes)) return reject(state, "capacity");
      return {
        state: { ...state, skill: { holder: "lease", bytes: event.bytes } },
        effects: [{ type: "budget", pool: "skill", turns: 1, bytes: event.bytes }],
      };
    }
    case "prepare-skill": {
      if (!canPrepareChatTurnSkill(state) || state.skill.holder !== "lease") {
        return reject(state, "unavailable");
      }
      if (event.bytes > state.skill.bytes) return reject(state, "capacity");
      return {
        state: {
          ...state,
          skill: { holder: "lease", bytes: event.bytes },
          skillPrepared: true,
        },
        effects: [{ type: "budget", pool: "skill", turns: 0, bytes: event.bytes - state.skill.bytes }],
      };
    }
    case "settle": {
      if (state.preparation === "settled") return reject(state, "ignored");
      const keepsAppend = event.retainAppend;
      return finish(
        {
          ...state,
          preparation: "settled",
          append: keepsAppend ? state.append : EMPTY_SLOT,
        },
        keepsAppend ? [] : refund("append", state.append),
      );
    }
    case "revoke": {
      if (state.authority === "revoked") return reject(state, "ignored");
      return finish({ ...state, authority: "revoked" }, [{ type: "revoked" }]);
    }
    case "begin-registration": {
      if (!isChatTurnReadyForHandoff(state) || state.registration === "registering") {
        return reject(state, "unavailable");
      }
      return { state: { ...state, registration: "registering" }, effects: [] };
    }
    case "registration-succeeded": {
      if (state.registration !== "registering") return reject(state, "ignored");
      // The generation now holds the skill bytes; only its custody refunds them.
      return finish(
        { ...state, authority: "revoked", registration: "none", skill: EMPTY_SLOT },
        state.authority === "active" ? [{ type: "revoked" }] : [],
      );
    }
    case "registration-failed": {
      if (state.registration !== "registering") return reject(state, "ignored");
      return finish({ ...state, registration: "none" }, []);
    }
  }
}

/**
 * Who owes the refund for a skill reservation once handoff starts. A release
 * requested before registration finishes cannot refund yet, because the lease
 * still holds the charge and a failed registration keeps it there.
 */
export type ChatTurnSkillCustody =
  | "lease"
  | "lease_release_requested"
  | "generation"
  | "returned"
  | "released";

export type ChatTurnSkillCustodyEvent = "release-requested" | "transferred" | "registration-failed";

export function transitionChatTurnSkillCustody(
  custody: ChatTurnSkillCustody,
  event: ChatTurnSkillCustodyEvent,
): { readonly custody: ChatTurnSkillCustody; readonly refund: boolean } {
  switch (event) {
    case "release-requested":
      if (custody === "lease") return { custody: "lease_release_requested", refund: false };
      if (custody === "generation") return { custody: "released", refund: true };
      return { custody, refund: false };
    case "transferred":
      if (custody === "lease") return { custody: "generation", refund: false };
      if (custody === "lease_release_requested") return { custody: "released", refund: true };
      return { custody, refund: false };
    case "registration-failed":
      if (custody === "lease" || custody === "lease_release_requested") {
        return { custody: "returned", refund: false };
      }
      return { custody, refund: false };
  }
}
