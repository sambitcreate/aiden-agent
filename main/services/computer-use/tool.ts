import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ComputerUseController, ComputerUseResultDetails } from "./controller.js";
import { ComputerUseParameters } from "./schema.js";

export const COMPUTER_USE_TOOL_NAME = "computer_use";

export function createComputerUseAgentTool(
  controller: ComputerUseController,
): AgentTool<typeof ComputerUseParameters, ComputerUseResultDetails> {
  return {
    name: COMPUTER_USE_TOOL_NAME,
    label: "Computer Use",
    description:
      "Use native macOS apps in the background through Aiden's external cua-driver. Capture a window first, then act by its zero-based element index when possible. Mutating actions always require the user's approval. app='screen' or app='desktop' resolves the OS shell/desktop surface as one actionable window; captures never span multiple displays.",
    parameters: ComputerUseParameters,
    executionMode: "sequential",
    execute: (toolCallId, params, signal) => controller.execute(toolCallId, params, signal),
  };
}
