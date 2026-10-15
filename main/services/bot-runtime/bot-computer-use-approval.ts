import type { ComputerUseController } from "../computer-use/controller.js";
import type { ComputerUseArgs } from "../computer-use/schema.js";
import type { BotApprovalRequirement, BotToolCallCheck } from "./bot-extension.js";

export const BOT_COMPUTER_USE_REVOKED_REASON =
  "Computer Use access was revoked. Ask the user to allow it again.";

/**
 * A durable Bot's Computer Use call on its retained controller. The Bot keeps
 * its controller across a running turn, so the grant (Always allow, or the Bot
 * chat's own grant) is re-checked before every call and again after an input
 * action's card is answered: Reset chat permissions or Always allow turning
 * off must stop even an observation, and an action already waiting for its
 * answer. A revoked grant closes the controller and blocks the call.
 */
export async function botComputerUseApproval(
  controller: Pick<ComputerUseController, "approvalFor" | "authorize">,
  call: BotToolCallCheck,
  access: { granted(): Promise<boolean>; revoke(): Promise<void> },
): Promise<BotApprovalRequirement | null> {
  const assertGranted = async () => {
    if (await access.granted()) return;
    await access.revoke();
    throw new Error(BOT_COMPUTER_USE_REVOKED_REASON);
  };
  await assertGranted();
  const args = call.args as ComputerUseArgs;
  const descriptor = await controller.approvalFor(args, call.signal);
  if (!descriptor) return null;
  return {
    summary: descriptor.summary,
    onAllow: async () => {
      await assertGranted();
      controller.authorize(call.callId, args, descriptor);
    },
  };
}
