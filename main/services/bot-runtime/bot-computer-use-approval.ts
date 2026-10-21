import type { ComputerUseApprovalDescriptor, ComputerUseController } from "../computer-use/controller.js";
import type { ComputerUseArgs } from "../computer-use/schema.js";
import type { BotClassifiableAction } from "../bot-rules/classify.js";
import type { BotToolCallCheck } from "./bot-extension.js";
import type { BotLiveApproval } from "./bot-tool-assembly.js";

export const BOT_COMPUTER_USE_REVOKED_REASON =
  "Computer Use access was revoked. Ask the user to allow it again.";

/**
 * What a Computer Use call does, for the Bot rules classifier: the action,
 * the window, and the role and label of the element it touches. Typed text
 * and field values never reach the classifier.
 */
function classifiableAction(args: ComputerUseArgs, descriptor: ComputerUseApprovalDescriptor): BotClassifiableAction {
  return {
    surface: "computer_use",
    action: args.action,
    ...(descriptor.target.app === undefined ? {} : { app: descriptor.target.app }),
    ...(descriptor.target.title === undefined ? {} : { windowTitle: descriptor.target.title }),
    ...(descriptor.element === undefined ? {} : { element: { ...descriptor.element } }),
    ...(descriptor.focusedElement === undefined ? {} : { focusedElement: { ...descriptor.focusedElement } }),
    ...(descriptor.secureFieldInCapture === true ? { secureFieldInCapture: true } : {}),
    ...(descriptor.menuPath === undefined ? {} : { menuPath: [...descriptor.menuPath] }),
    ...(args.action === "key" && typeof args.keys === "string" ? { keys: args.keys } : {}),
  };
}

/**
 * A durable Bot's Computer Use call on its retained controller. The Bot keeps
 * its controller across a running turn, so the grant (Always allow, or the Bot
 * chat's own grant) is re-checked before every call and again after an input
 * action's card is answered: Reset chat permissions or Always allow turning
 * off must stop even an observation, and an action already waiting for its
 * answer. A revoked grant closes the controller and blocks the call.
 *
 * An observation needs no approval and is not classified; every action is,
 * so the Bot's rules can tighten it.
 */
export async function botComputerUseApproval(
  controller: Pick<ComputerUseController, "approvalFor" | "authorize">,
  call: BotToolCallCheck,
  access: { granted(): Promise<boolean>; revoke(): Promise<void> },
): Promise<BotLiveApproval> {
  const assertGranted = async () => {
    if (await access.granted()) return;
    await access.revoke();
    throw new Error(BOT_COMPUTER_USE_REVOKED_REASON);
  };
  await assertGranted();
  const args = call.args as ComputerUseArgs;
  const descriptor = await controller.approvalFor(args, call.signal);
  if (!descriptor) return { approval: null };
  return {
    approval: {
      summary: descriptor.summary,
      onAllow: async () => {
        await assertGranted();
        controller.authorize(call.callId, args, descriptor);
      },
    },
    action: classifiableAction(args, descriptor),
  };
}
