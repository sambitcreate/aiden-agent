import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import type { PeerOperation } from "../../renderer/shared/peer-operation.js";
import { peerRecord, peerText } from "./peer-pairing.js";
import type { PeerRequest } from "./peer-transport.js";
import {
  parseAidenRemoteChatProjection,
  parseAidenRemoteChatSummaryPage,
} from "./aiden-remote-protocol.js";

/** Pairing credentials never cross back into renderer operation results. */
export function peerOperationResult(
  operation: unknown,
  value: unknown,
): unknown {
  const input = peerRecord(operation);
  const visit = (node: unknown, depth: number): void => {
    if (depth > 128) throw new Error("Peer response is too deeply nested.");
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (
        /^(credential|credentials|secret|secrets|authorization|headers|privatekey|cacertificatederbase64)$/u.test(
          key.replace(/[_-]/gu, "").toLowerCase(),
        )
      )
        throw new Error("The peer returned private connection data.");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (input.operation === "summaries")
    return parseAidenRemoteChatSummaryPage(value, "Peer chat summaries");
  if (
    input.operation === "chat" ||
    input.operation === "createChat" ||
    input.operation === "renameChat"
  )
    return parseAidenRemoteChatProjection(value, "Peer chat");
  return value;
}

/** Renderer selects a closed operation, never an arbitrary URL, header or credential. */
export function peerOperationRequest(
  value: unknown,
): Omit<PeerRequest, "credential"> {
  const input = peerRecord(value);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "operation",
          "resourceId",
          "workspaceId",
          "cursor",
          "body",
          "idempotencyKey",
          "revision",
        ].includes(key),
    )
  )
    throw new Error("Unknown peer operation field.");
  const operation = peerText(input.operation, 40) as PeerOperation["operation"];
  const id = () => encodeURIComponent(hostIdentifier(input.resourceId));
  const cursor = () => encodeURIComponent(peerText(input.cursor, 512));
  let path: string;
  let method: PeerRequest["method"] = "GET";
  let needsKey = false;
  let needsRevision = false;
  switch (operation) {
    case "server":
      path = "/server";
      break;
    case "summaries":
      path = `/chat-summaries${input.cursor ? `?cursor=${cursor()}` : ""}`;
      break;
    case "workspaces":
      path = "/workspaces";
      break;
    case "models":
      path = "/models";
      break;
    case "chat":
      path = `/chats/${id()}`;
      break;
    case "roots":
      path = "/workspace-browser/roots";
      break;
    case "children":
      path = `/workspace-browser/children?location=${id()}${input.cursor ? `&cursor=${cursor()}` : ""}`;
      break;
    case "stream":
      path = `/streams/${id()}`;
      break;
    case "approval":
      path = `/streams/${id()}/approval`;
      break;
    case "files":
      path = `/workspaces/${id()}/files`;
      break;
    case "file":
      path = `/workspaces/${encodeURIComponent(hostIdentifier(input.workspaceId))}/files/${id()}`;
      break;
    case "git":
      path = `/workspaces/${id()}/git/review`;
      break;
    case "createChat":
      path = "/chats";
      method = "POST";
      needsKey = true;
      break;
    case "send":
      path = `/chats/${id()}/turns`;
      method = "POST";
      needsKey = true;
      break;
    case "renameChat":
      path = `/chats/${id()}`;
      method = "PATCH";
      needsRevision = true;
      break;
    case "deleteChat":
      path = `/chats/${id()}`;
      method = "DELETE";
      needsRevision = true;
      break;
    case "cancel":
      path = `/streams/${id()}/cancel`;
      method = "POST";
      needsKey = true;
      break;
    case "respondApproval":
      path = `/approvals/${id()}/respond`;
      method = "POST";
      needsKey = true;
      break;
    case "selectFolder":
      path = "/workspace-browser/selections";
      method = "POST";
      break;
    case "createWorkspace":
      path = "/workspaces";
      method = "POST";
      needsKey = true;
      break;
    default:
      throw new Error("Unsupported peer operation.");
  }
  const token = (value: unknown, min: number) => {
    const text = peerText(value, 128);
    if (text.length < min || !/^[\x21-\x7e]+$/u.test(text))
      throw new Error("Invalid peer operation token.");
    return text;
  };
  return {
    path,
    method,
    ...(method !== "GET" && method !== "DELETE"
      ? { body: input.body ?? {} }
      : {}),
    ...(needsKey ? { idempotencyKey: token(input.idempotencyKey, 16) } : {}),
    ...(needsRevision ? { revision: token(input.revision, 1) } : {}),
  };
}
