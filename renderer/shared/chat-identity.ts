import { isSafeSubagentIdentifier } from "./subagent-runs.js";

/** The UUID namespace used by first-message draft commits. */
export function isDraftChatId(id: unknown): id is string {
  return typeof id === "string" && id.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id);
}

/** Only for an id obtained from a local chat owner, never an incoming event. */
export function isLocalChatOwnerId(id: unknown): id is string {
  return isDraftChatId(id) || isSafeSubagentIdentifier(id);
}

/** New local chats also appear in privacy-filtered activity and child snapshots. */
export function newChatUuid(randomUuid: () => string): string {
  let id = randomUuid();
  while (!isSafeSubagentIdentifier(id)) id = randomUuid();
  return id;
}
