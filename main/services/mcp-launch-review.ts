/** Explicit foreground review. Stored environment values never enter the generic renderer projection. */
import { dialog } from "../platform.js";
import { mcpLaunchReviewText } from "./mcp-launch-review-core.js";
import type { McpServer } from "./types.js";

export async function confirmMcpLaunch(effective: McpServer): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Review connector launch",
    message: `Review the exact command, arguments and environment overrides for ${effective.name || "this connector"}.`,
    detail: `This explicit review shows saved environment values, including secrets. These overrides are passed with the command. Check execution settings such as PATH and NODE_OPTIONS before approving. These details are not logged.\n\n${mcpLaunchReviewText(effective)}`,
    buttons: ["Cancel", "Approve this launch"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}
