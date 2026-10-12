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
  warn(message: string, error: unknown): void;
}

/**
 * The once-per-chat Computer Use access gate for one generation stream. It runs
 * before every `computer_use` call: a granted chat on a ready Mac passes
 * silently; otherwise it raises one access card. A deny holds for the rest of
 * the stream, so the model cannot raise the card again until the next turn.
 */
export function createComputerUseAccessGate(
  deps: ComputerUseAccessGateDependencies,
) {
  let declined = false;
  let granted = false;

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

  const decide = async (
    toolCallId: string,
    signal?: AbortSignal,
  ): Promise<ComputerUseAccessDecision> => {
    if (declined)
      return { allowed: false, reason: COMPUTER_USE_DECLINED_REASON };
    const status = await readStatus(signal);
    if (!status) return { allowed: false, reason: UNDECIDED_REASONS.cancelled };
    // Nothing the user can grant fixes an unsupported OS, an unsigned build or
    // a broken driver, so those block with the status detail and no card.
    if (!status.ready && !status.available)
      return { allowed: false, reason: status.detail };
    if (!granted) {
      try {
        granted = await deps.readGrant();
      } catch (error) {
        deps.warn(
          "Could not read the Computer Use grant; asking instead.",
          error,
        );
      }
    }
    if (granted && status.ready) return { allowed: true };
    if (signal?.aborted)
      return { allowed: false, reason: UNDECIDED_REASONS.cancelled };

    if (!status.ready) {
      await persist("Could not mark the chat to continue Computer Use.", () =>
        deps.setPendingContinue(true),
      );
    }
    const { outcome, scope } = await deps.requestAccess(toolCallId, signal);
    if (outcome === "allowed") {
      if (scope === "always") {
        await persist(
          "Could not save Always allow for Computer Use.",
          deps.grantAlways,
        );
      } else {
        // "chat", or a bare allow from a client that does not send scopes.
        await persist(
          "Could not save the chat's Computer Use grant.",
          deps.grantChat,
        );
      }
      granted = true;
      await persist(
        "Could not clear the chat's Computer Use continue marker.",
        () => deps.setPendingContinue(false),
      );
      const current = status.ready ? status : await readStatus(signal, true);
      if (!current)
        return { allowed: false, reason: UNDECIDED_REASONS.cancelled };
      if (!current.ready)
        return { allowed: false, reason: COMPUTER_USE_SETUP_REASON };
      return { allowed: true };
    }
    if (outcome === "denied") {
      declined = true;
      await persist(
        "Could not clear the chat's Computer Use continue marker.",
        () => deps.setPendingContinue(false),
      );
      return { allowed: false, reason: COMPUTER_USE_DECLINED_REASON };
    }
    // Cancelled, detached or unavailable: keep any continue marker so the
    // chat can offer Continue after the user restarts Aiden.
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
