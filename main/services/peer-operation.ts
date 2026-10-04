import { validatePeerResponse } from "./peer-response.js";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import type {
  PeerAttachmentContent,
  PeerOperation,
} from "../../renderer/shared/peer-operation.js";
import { peerRecord, peerText } from "./peer-pairing.js";
import { MAX_PEER_BINARY_BYTES, type PeerRequest } from "./peer-transport.js";
import {
  parseAidenRemoteChatProjection,
  parseAidenRemoteChatSummaryPage,
} from "./aiden-remote-protocol.js";

const OPERATION_FIELDS = new Set([
  "operation",
  "resourceId",
  "itemId",
  "workspaceId",
  "cursor",
  "before",
  "limit",
  "query",
  "botId",
  "turnId",
  "includeArchived",
  "body",
  "idempotencyKey",
  "revision",
]);

/** Attachment IDs are longer than other host identifiers (contract revision 19). */
const ATTACHMENT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

/** Run-control operations reconcile from the host feed's run state. */
export const PEER_RUN_OPERATIONS: ReadonlySet<string> = new Set([
  "runCancel",
  "runRespondApproval",
  "runRespondQuestion",
  "runInputs",
]);

/** Chat-scoped mutations reconcile with one `GET /chats/{chatId}`. */
export const PEER_CHAT_MUTATIONS: ReadonlySet<string> = new Set([
  "send",
  "renameChat",
  "deleteChat",
  "markRead",
  "interruptAgent",
  "updateBotChatAccess",
]);

function binaryContent(value: unknown): PeerAttachmentContent {
  const record = peerRecord(value);
  const data = record.data;
  if (
    (record.mimeType !== "image/png" && record.mimeType !== "image/jpeg") ||
    !(data instanceof Uint8Array) ||
    data.byteLength === 0 ||
    data.byteLength > MAX_PEER_BINARY_BYTES
  )
    throw new Error("Invalid peer attachment content.");
  // A plain copy: the renderer receives bytes, never a Node Buffer view of pooled memory.
  return { mimeType: record.mimeType, bytes: new Uint8Array(data) };
}

/** Pairing credentials never cross back into renderer operation results. */
export async function peerOperationResult(
  operation: unknown,
  value: unknown,
): Promise<unknown> {
  const input = peerRecord(operation);
  const name = peerText(input.operation, 40);
  if (name === "attachmentContent") return binaryContent(value);
  await validatePeerResponse(name, value);
  if (name === "summaries")
    return parseAidenRemoteChatSummaryPage(value, "Peer chat summaries");
  if (name === "chat" || name === "createChat" || name === "renameChat")
    return parseAidenRemoteChatProjection(value, "Peer chat");
  return value;
}

function query(entries: [string, string | undefined][]): string {
  const present = entries.filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return present.length === 0
    ? ""
    : `?${present.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&")}`;
}

/** Renderer selects a closed operation, never an arbitrary URL, header or credential. */
export function peerOperationRequest(
  value: unknown,
): Omit<PeerRequest, "credential"> {
  const input = peerRecord(value);
  if (Object.keys(input).some((key) => !OPERATION_FIELDS.has(key)))
    throw new Error("Unknown peer operation field.");
  const operation = peerText(input.operation, 40) as PeerOperation["operation"];
  const id = () => encodeURIComponent(hostIdentifier(input.resourceId));
  const pattern = (raw: unknown, shape: RegExp) => {
    if (typeof raw !== "string" || !shape.test(raw))
      throw new Error("Invalid peer operation identifier.");
    return encodeURIComponent(raw);
  };
  const item = () => pattern(input.itemId, PUBLIC_ID);
  const cursor = () => encodeURIComponent(peerText(input.cursor, 512));
  const optional = (raw: unknown, read: () => string) =>
    raw === undefined ? undefined : read();
  const limit = (max: number) =>
    optional(input.limit, () => {
      if (
        !Number.isSafeInteger(input.limit) ||
        (input.limit as number) < 1 ||
        (input.limit as number) > max
      )
        throw new Error("Invalid peer operation limit.");
      return String(input.limit);
    });
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
    case "messagesWindow":
      path = `/chats/${id()}/messages${query([
        ["before", optional(input.before, () => decodeURIComponent(pattern(input.before, PUBLIC_ID)))],
        ["limit", limit(200)],
      ])}`;
      break;
    case "attachmentContent":
      path = `/chats/${id()}/attachments/${pattern(input.itemId, ATTACHMENT_ID)}/content`;
      break;
    case "skills":
      path = `/chats/${id()}/skills`;
      break;
    case "tasks":
      path = `/chats/${id()}/tasks`;
      break;
    case "agents":
      path = `/chats/${id()}/agents${query([
        ["turnId", optional(input.turnId, () => decodeURIComponent(pattern(input.turnId, PUBLIC_ID)))],
      ])}`;
      break;
    case "streamQuestion":
      path = `/streams/${id()}/question`;
      break;
    case "bots":
      path = `/bots${input.includeArchived === true ? "?includeArchived=true" : ""}`;
      break;
    case "bot":
      path = `/bots/${id()}`;
      break;
    case "botConversations":
      path = `/bot-conversations${query([
        ["cursor", optional(input.cursor, () => peerText(input.cursor, 128))],
        ["query", optional(input.query, () => {
          if (typeof input.query !== "string" || input.query.length > 200)
            throw new Error("Invalid peer operation query.");
          return input.query;
        })],
        ["botId", optional(input.botId, () => hostIdentifier(input.botId))],
        ["limit", limit(50)],
      ])}`;
      break;
    case "botCapabilities":
      path = `/bot-capabilities${query([
        ["botId", optional(input.botId, () => hostIdentifier(input.botId))],
      ])}`;
      break;
    case "botChatAccess":
      path = `/chats/${id()}/capabilities`;
      break;
    case "botFavorites":
      path = "/bot-favorites";
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
    case "markRead":
      path = `/chats/${id()}/read`;
      method = "POST";
      needsKey = true;
      break;
    case "interruptAgent":
      path = `/chats/${id()}/agents/${item()}/interrupt`;
      method = "POST";
      needsKey = true;
      break;
    case "respondQuestion":
      path = `/questions/${id()}/respond`;
      method = "POST";
      needsKey = true;
      break;
    case "inputs":
      path = `/streams/${id()}/inputs`;
      method = "POST";
      needsKey = true;
      break;
    case "runCancel":
      path = `/runs/${pattern(input.resourceId, PUBLIC_ID)}/cancel`;
      method = "POST";
      needsKey = true;
      break;
    case "runRespondApproval":
      path = `/runs/${pattern(input.resourceId, PUBLIC_ID)}/approvals/${item()}/respond`;
      method = "POST";
      needsKey = true;
      break;
    case "runRespondQuestion":
      path = `/runs/${pattern(input.resourceId, PUBLIC_ID)}/questions/${item()}/respond`;
      method = "POST";
      needsKey = true;
      break;
    case "runInputs":
      path = `/runs/${pattern(input.resourceId, PUBLIC_ID)}/inputs`;
      method = "POST";
      needsKey = true;
      break;
    case "createBotChat":
      path = `/bots/${id()}/chats`;
      method = "POST";
      needsKey = true;
      break;
    case "updateBotFavorites":
      path = "/bot-favorites";
      method = "PATCH";
      needsKey = true;
      needsRevision = true;
      break;
    case "updateBotChatAccess":
      path = `/chats/${id()}/capabilities`;
      method = "PATCH";
      needsKey = true;
      needsRevision = true;
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
