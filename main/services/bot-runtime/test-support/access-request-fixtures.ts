import type { BotAccessRequests } from "../bot-access-requests.js";

/** A private host prompt; tests project this through the real bridge. */
type Request = Parameters<BotAccessRequests["request"]>[0];

export function accessRequestPrompt(overrides: Partial<Request> = {}): Request {
  return {
    botId: "bot:a",
    toolCallId: "access-call",
    logicalRequestId: "logical-access",
    target: "folder",
    label: "Taxes",
    place: "~/Documents/Taxes",
    why: "Prepare your return.",
    choices: ["not_now", "always", "once"],
    grant: { folderPath: "/home/person/Documents/Taxes" },
    authorization: {
      policyRevision: "rev-1",
      requestIds: ["run-1"],
      target: "folder",
      root: "/home/person/Documents/Taxes",
      identity: { device: "1", inode: "2" },
      choices: ["not_now", "always", "once"],
    },
    signal: undefined,
    ...overrides,
  };
}
