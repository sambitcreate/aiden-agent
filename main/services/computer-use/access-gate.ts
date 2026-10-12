import type { GenerationCancellationOrigin } from "../../../renderer/shared/generation-timeline.js";
import type { ToolApprovalScope } from "../../../renderer/shared/tool-approval-scope.js";
import type { ToolApprovalOutcome } from "../tool-approval.js";
import type { ComputerUseStatus } from "../types.js";
import type { ComputerUseController } from "./controller.js";
import type { ComputerUseArgs } from "./schema.js";

export const COMPUTER_USE_ACCESS_SUMMARY =
  "Use your computer in this chat. Screenshots and accessibility text go to the selected model, and Aiden can click and type in your apps.";

export const COMPUTER_USE_DECLINED_REASON =
  "The user declined Computer Use in this chat. Do not retry it unless the user asks again.";

export const COMPUTER_USE_SETUP_REASON =
  "Finish Computer Use setup on your Mac (Accessibility and Screen Recording), then ask again.";

/** Block reasons for approvals that settled without a user decision. */
const UNDECIDED_REASONS: Record<
  Exclude<ToolApprovalOutcome, "allowed" | "denied">,
  string
> = {
  detached:
    "Approval is unavailable while this response continues in the background. Return to the chat and retry the action.",
  unavailable:
    "Aiden could not present the approval request. Return to the chat and retry the action.",
  cancelled: "The action was cancelled before approval.",
};

export type ComputerUseAccessDecision =
  { allowed: true } | { allowed: false; reason: string };

/**
 * Bumped whenever grants are revoked (Reset chat permissions, Always allow
 * turned off, the beta turned off). A stream that cached a grant re-reads it
 * when the revision moved, so a revocation takes effect on the next call.
 */
let grantRevision = 0;

export function computerUseGrantRevision(): number {
  return grantRevision;
}

export function revokeComputerUseGrants(): void {
  grantRevision += 1;
}

export interface ComputerUseGrantResetDependencies {
  /** Cancel streams already using Computer Use (same path as the beta turning off). */
  cancelActivatedStreams(): void;
  clearAlwaysAllow(): Promise<unknown>;
  /** Clear every chat's grant; returns how many chats held one. */
  clearChatGrants(): Promise<number>;
}

/**
 * Settings → Computer Use → Reset chat permissions: every chat asks again and
 * Always allow turns off. Live streams drop their cached grant immediately,
 * and streams already using Computer Use are stopped.
 */
export async function resetComputerUseGrants(
  deps: ComputerUseGrantResetDependencies,
): Promise<{ cleared: number }> {
  revokeComputerUseGrants();
  deps.cancelActivatedStreams();
  await deps.clearAlwaysAllow();
  return { cleared: await deps.clearChatGrants() };
}

export interface ComputerUseAccessGateDependencies {
  /** Live grant: "Always allow" is on, or this chat was allowed. Read at call time. */
  readGrant(): Promise<boolean>;
  status(options: {
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<Pick<ComputerUseStatus, "ready" | "available" | "detail">>;
  /**
   * Raise the once-per-chat access card and wait for it. Returns the outcome
   * and, for an allow, the scope the user picked (undefined for a bare allow).
   */
  requestAccess(
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<{ outcome: ToolApprovalOutcome; scope?: ToolApprovalScope }>;
  grantChat(): Promise<unknown>;
  grantAlways(): Promise<unknown>;
  setPendingContinue(pending: boolean): Promise<unknown>;
  /**
   * Why the stream was cancelled, read when the card settles as cancelled.
   * Only an application shutdown keeps the continue marker; a user Stop (or
   * any other known origin) clears it.
   */
  cancellationOrigin(): GenerationCancellationOrigin | undefined;
  warn(message: string, error: unknown): void;
}

/**
 * The once-per-chat Computer Use access gate for one generation stream. It runs
 * before every `computer_use` call: a granted chat on a ready Mac passes
 * silently; otherwise it raises one access card. A deny holds for the rest of
 * the stream, so the model cannot raise the card again until the next turn.
 *
 * Scopes: "chat" persists the chat's grant, "always" turns on the global
 * setting, and a bare allow or "once" (what phones send) grants only this
 * stream and persists nothing.
 */
export function createComputerUseAccessGate(
  deps: ComputerUseAccessGateDependencies,
) {
  let declined = false;
  /** Grant revision at which this stream knew it was granted. */
  let grantedAt: number | null = null;
  /** Grant revision at which this stream saw granted && ready; later calls skip the probe. */
  let establishedAt: number | null = null;

  const persist = async (label: string, write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (error) {
      deps.warn(label, error);
    }
  };

  const readStatus = async (
    signal: AbortSignal | undefined,
    force = false,
  ): Promise<Pick<
    ComputerUseStatus,
    "ready" | "available" | "detail"
  > | null> => {
    try {
      return await deps.status({ force, signal });
    } catch (error) {
      if (signal?.aborted) return null;
      return {
        ready: false,
        available: false,
        detail:
          error instanceof Error
            ? error.message
            : "Computer Use status is unavailable.",
      };
    }
  };

  const setPending = (pending: boolean) =>
    persist(
      pending
        ? "Could not mark the chat to continue Computer Use."
        : "Could not clear the chat's Computer Use continue marker.",
      () => deps.setPendingContinue(pending),
    );

  const decide = async (
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ComputerUseAccessDecision> => {
    if (declined)
      return { allowed: false, reason: COMPUTER_USE_DECLINED_REASON };
    const revision = grantRevision;
    // Once this stream saw a granted chat on a ready Mac, skip the status
    // probe; a later permission loss surfaces as a driver error instead.
    if (establishedAt === revision) return { allowed: true };
    const status = await readStatus(signal);
    if (!status) return { allowed: false, reason: UNDECIDED_REASONS.cancelled };
    // Nothing the user can grant fixes an unsupported OS, an unsigned build or
    // a broken driver, so those block with the status detail and no card.
    if (!status.ready && !status.available)
      return { allowed: false, reason: status.detail };
    if (grantedAt !== revision) {
      grantedAt = null;
      try {
        if (await deps.readGrant()) grantedAt = revision;
      } catch (error) {
        deps.warn(
          "Could not read the Computer Use grant; asking instead.",
          error,
        );
      }
    }
    if (grantedAt === revision) {
      if (status.ready) {
        establishedAt = revision;
        return { allowed: true };
      }
      // Granted, but macOS permissions are missing (or were revoked later).
      // The card would add nothing, so mark the chat and ask for setup.
      await setPending(true);
      return { allowed: false, reason: COMPUTER_USE_SETUP_REASON };
    }
    if (signal?.aborted)
      return { allowed: false, reason: UNDECIDED_REASONS.cancelled };

    if (!status.ready) await setPending(true);
    const { outcome, scope } = await deps.requestAccess(toolCallId, signal);
    if (outcome === "allowed") {
      if (scope === "always") {
        await persist(
          "Could not save Always allow for Computer Use.",
          deps.grantAlways,
        );
      } else if (scope === "chat") {
        await persist(
          "Could not save the chat's Computer Use grant.",
          deps.grantChat,
        );
      }
      // A bare allow or "once" grants this response only.
      grantedAt = revision;
      const current = status.ready ? status : await readStatus(signal, true);
      if (!current)
        return { allowed: false, reason: UNDECIDED_REASONS.cancelled };
      // Still not ready: keep the continue marker so the chat can resume
      // after setup (and a restart, if macOS needs one).
      if (!current.ready)
        return { allowed: false, reason: COMPUTER_USE_SETUP_REASON };
      if (!status.ready) await setPending(false);
      establishedAt = revision;
      return { allowed: true };
    }
    if (outcome === "denied") {
      declined = true;
      if (!status.ready) await setPending(false);
      return { allowed: false, reason: COMPUTER_USE_DECLINED_REASON };
    }
    if (outcome === "cancelled" && !status.ready) {
      // Keep the marker across an app quit so the chat can offer Continue
      // after restart; a user Stop ends the request.
      const origin = deps.cancellationOrigin();
      if (origin !== undefined && origin !== "application_shutdown")
        await setPending(false);
    }
    // Detached or unavailable keep any continue marker.
    return { allowed: false, reason: UNDECIDED_REASONS[outcome] };
  };

  // Parallel tool calls share one card: each waits for the previous decision.
  let tail: Promise<unknown> = Promise.resolve();
  return {
    authorize(
      toolCallId: string,
      signal?: AbortSignal,
    ): Promise<ComputerUseAccessDecision> {
      const next = tail.then(() => decide(toolCallId, signal));
      tail = next.catch(() => undefined);
      return next;
    },
  };
}

export type ComputerUseAccessGate = ReturnType<
  typeof createComputerUseAccessGate
>;

/**
 * In a chat with Computer Use access, run an input action without its own
 * card. approvalFor still binds the grant to the exact target and enforces the
 * safety refusals (it throws for those); authorize consumes the binding so
 * execute accepts exactly this call. Observations need no grant.
 */
export async function authorizeAllowedComputerUseAction(
  controller: Pick<ComputerUseController, "approvalFor" | "authorize">,
  toolCallId: string,
  args: ComputerUseArgs,
  signal?: AbortSignal,
): Promise<void> {
  const descriptor = await controller.approvalFor(args, signal);
  if (descriptor) controller.authorize(toolCallId, args, descriptor);
}
