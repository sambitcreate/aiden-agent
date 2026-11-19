// Which tools a workspace chat declares, and which calls a given turn refuses.
//
// A chat declares the same tools on every turn so the cached prefix holds
// (docs/plans/prompt-cache-hit-rate.md, phase 2). What differs from turn to
// turn is who is there: an unattended follow-up has nobody to approve or
// watch, a paired device cannot show some results, and inline visuals On
// request draw only after /visualize. Those turns keep the declaration and
// refuse the call in `beforeToolCall`, before any access check, approval or
// execution, with a reason that names the condition.

import type { InlineVisualsMode } from "../../renderer/shared/appearance.js";
import { WORKSPACE_ARTIFACT_TOOL_NAME } from "../../renderer/shared/workspace-artifacts.js";
import { COMPUTER_USE_TOOL_NAME } from "./computer-use/tool.js";
import { generativeUiUnavailableReason } from "./generative-ui-extension.js";
import { hooksToolUnavailableReason, offersHooksTool, type HooksToolSurface } from "./hooks-tool.js";

const FORM_FILL_TOOL_NAME = "form_fill";
const SUBAGENT_TOOL_NAME = "subagent";

/** The chat's own surface: fixed for every turn of the chat. */
export type ChatToolSurface = Omit<HooksToolSurface, "unattended" | "remoteAudience">;

/** Who and what this one turn serves. */
export interface ChatTurnAudience {
  /** Nobody is watching: an unattended follow-up. */
  unattended: boolean;
  /** A phone or paired Mac sent the turn and sees its results. */
  remoteAudience: boolean;
  inlineVisuals?: InlineVisualsMode;
  /** The person used /visualize in this turn. */
  visualize: boolean;
}

/** Declarations that depend on the chat alone, never on the turn's audience. */
export function chatToolOffers(surface: ChatToolSurface): { hooks: boolean } {
  return { hooks: offersHooksTool({ ...surface, unattended: false, remoteAudience: false }) };
}

/** A call this turn cannot run, with the reason the model reads, or undefined. */
export function chatTurnToolRefusal(
  surface: ChatToolSurface,
  turn: ChatTurnAudience,
): (name: string) => string | undefined {
  const hooksSurface: HooksToolSurface = { ...surface, unattended: turn.unattended, remoteAudience: turn.remoteAudience };
  const visuals = { onRequest: turn.inlineVisuals === "on_request", visualize: turn.visualize };
  return (name) => {
    const hooks = hooksToolUnavailableReason(name, hooksSurface);
    if (hooks) return hooks;
    if (turn.unattended && (name === COMPUTER_USE_TOOL_NAME || name === FORM_FILL_TOOL_NAME)) {
      return `${name} is not available in this turn: nobody is watching this follow-up to grant Computer Use. Describe what you would do on screen instead.`;
    }
    if (turn.unattended && name === SUBAGENT_TOOL_NAME) {
      return `${SUBAGENT_TOOL_NAME} is not available in this turn: nobody is watching this follow-up to approve or follow a subagent run. Do the work yourself or say what you would delegate.`;
    }
    if (turn.remoteAudience && (name === COMPUTER_USE_TOOL_NAME || name === FORM_FILL_TOOL_NAME)) {
      return `${name} is not available in this turn: the request came from a paired device, and Computer Use is granted only on this computer. Describe what you would do on screen instead.`;
    }
    if (turn.remoteAudience && name === WORKSPACE_ARTIFACT_TOOL_NAME) {
      return `${WORKSPACE_ARTIFACT_TOOL_NAME} is not available in this turn: the request came from a paired device, which cannot show workspace artifacts. Open the chat on this computer to create, refresh or run one.`;
    }
    return generativeUiUnavailableReason(name, visuals);
  };
}
