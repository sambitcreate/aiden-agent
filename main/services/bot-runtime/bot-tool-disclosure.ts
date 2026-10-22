// Gateway disclosure for durable Bot turns (blueprint G15).
//
// A Bot's browser is offered as one small `browser` tool first. Its
// `browser_*` tools are installed with it but withheld from every request
// until the request's own messages hold a successful `browser` result, so a
// Bot that never browses never pays for eleven tool declarations. The rule is
// read from the transcript, not from state in this process, so it survives a
// restart and replays the same way (Pi Durable has no per-turn hook for it).

import type { Message } from "@earendil-works/pi-ai";
import { isBrowserToolName } from "../browser-tools.js";

/** The gateway tool that discloses a Bot's `browser_*` tools. */
export const BOT_BROWSER_GATEWAY_TOOL = "browser";

/** Whether `messages` hold a successful result of the gateway tool `gateway`. */
function disclosed(messages: readonly Message[], gateway: string): boolean {
  return messages.some((message) => message.role === "toolResult" && message.toolName === gateway && !message.isError);
}

/** The tools this request must not declare yet: `browser_*` until `browser` has answered. */
export function withheldUntilDisclosed(messages: readonly Message[]): (name: string) => boolean {
  if (disclosed(messages, BOT_BROWSER_GATEWAY_TOOL)) return () => false;
  return (name) => isBrowserToolName(name);
}
