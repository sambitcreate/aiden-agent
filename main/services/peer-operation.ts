import { peerBotSessionCompat } from "./peer-bot-session-compat.js";
import { validatePeerResponse } from "./peer-response.js";
import { hostIdentifier } from "../../renderer/shared/peer-host.js";
import type {
  PeerAttachmentContent,
  PeerOperation,
} from "../../renderer/shared/peer-operation.js";
import { peerRecord, peerText } from "./peer-pairing.js";
import {
  MAX_PEER_BINARY_BYTES,
  MAX_PEER_UPLOAD_BYTES,
  type PeerRequest,
} from "./peer-transport.js";
import { MAX_INLINE_IMAGE_BYTES } from "../../renderer/shared/attachment-contract.js";
import {
  AIDEN_REMOTE_CONTEXT_MODEL_ID,
  AIDEN_REMOTE_MAX_ENCODED_ATTACHMENT_NAME,
  encodeAidenRemoteAttachmentName,
  parseAidenRemoteBotConnectionRequestReceipt,
  parseAidenRemoteBotHandoffAnswerReceipt,
  parseAidenRemoteBotHandoffAnswerRequest,
  parseAidenRemoteBotHandoffOpenOnMacReceipt,
  parseAidenRemoteBotMessageReceipt,
  parseAidenRemoteBotQuestionAnswerReceipt,
  parseAidenRemoteBotSession,
  parseAidenRemoteBotSessionStateView,
  parseAidenRemoteChatContextPressure,
  parseAidenRemoteChatForkResult,
  parseAidenRemoteChatProjection,
  parseAidenRemoteChatSummaryPage,
} from "./aiden-remote-protocol.js";
import { MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS } from "../../renderer/shared/chat-copy-contract.js";

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
  "providerId",
  "modelId",
  "body",
  "idempotencyKey",
  "revision",
]);

/** Attachment IDs are longer than other host identifiers (contract revision 19). */
const ATTACHMENT_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const PUBLIC_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
/** A staged upload's ID, as `POST /chats/{chatId}/attachments` mints it. */
const STAGED_ATTACHMENT_ID = /^att_[A-Za-z0-9_-]{43}$/u;
/** A Bot question's or hand-off's durable wait id, as the host's answer routes accept it. */
const BOT_WAIT_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** Operations whose answer is bounded image bytes, not JSON. */
export const PEER_BINARY_OPERATIONS: ReadonlySet<string> = new Set(["attachmentContent", "botSessionImage"]);

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
  // A fork never changes its source, but a summary action changes the fork.
  "forkSummaryRetry",
  "forkSummarySkip",
  "forkSummaryCancel",
]);

/** Bot session mutations reconcile with one `GET /bots/{botId}/session`. */
export const PEER_BOT_SESSION_MUTATIONS: ReadonlySet<string> = new Set([
  "botSend",
  "botResume",
  "botDismiss",
  "botStop",
  "botAnswerQuestion",
  "botAnswerHandoff",
  "botPause",
  "botUnpause",
]);

/** A fork names one message to cut at and, optionally, a summary of what followed. */
function forkBody(value: unknown): Record<string, unknown> {
  const body = peerRecord(value);
  const keys = Object.keys(body);
  if (
    keys.some((key) => key !== "messageId" && key !== "position" && key !== "summary") ||
    typeof body.messageId !== "string" ||
    !PUBLIC_ID.test(body.messageId) ||
    (body.position !== "after" && body.position !== "before")
  )
    throw new Error("Invalid peer fork request.");
  if (body.summary === undefined) return { messageId: body.messageId, position: body.position };
  const summary = peerRecord(body.summary);
  const focus = summary.focus;
  if (
    Object.keys(summary).some((key) => key !== "focus") ||
    (focus !== undefined &&
      (typeof focus !== "string" || !focus.trim() || focus.length > MAX_FORK_SUMMARY_INSTRUCTIONS_CHARS))
  )
    throw new Error("Invalid peer fork request.");
  return {
    messageId: body.messageId,
    position: body.position,
    summary: focus === undefined ? {} : { focus },
  };
}

/** `{cancelled}` from `POST /chats/{chatId}/fork-summary/cancel`. */
function forkSummaryCancelled(value: unknown): { cancelled: boolean } {
  const record = peerRecord(value);
  if (typeof record.cancelled !== "boolean")
    throw new Error("Invalid peer fork summary answer.");
  return { cancelled: record.cancelled };
}

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
  if (PEER_BINARY_OPERATIONS.has(name)) return binaryContent(value);
  if (name === "server") {
    const { peerRoutes: _mainOnlyRoutes, ...projection } = peerRecord(value);
    await validatePeerResponse(name, projection);
    return projection;
  }
  if (name === "botSession") {
    // A newer host's session is read as far as this client understands it.
    const session = peerBotSessionCompat(value);
    await validatePeerResponse(name, session);
    return parseAidenRemoteBotSession(session);
  }
  await validatePeerResponse(name, value);
  if (name === "summaries")
    return parseAidenRemoteChatSummaryPage(value, "Peer chat summaries");
  if (
    name === "chat" ||
    name === "createChat" ||
    name === "renameChat" ||
    name === "forkSummaryRetry" ||
    name === "forkSummarySkip"
  )
    return parseAidenRemoteChatProjection(value, "Peer chat");
  if (name === "contextPressure")
    return parseAidenRemoteChatContextPressure(value, "Peer chat context pressure");
  if (name === "forkChat")
    return parseAidenRemoteChatForkResult(value, "Peer chat fork");
  if (name === "forkSummaryCancel") return forkSummaryCancelled(value);
  if (name === "botSend") return parseAidenRemoteBotMessageReceipt(value);
  if (name === "botResume" || name === "botDismiss" || name === "botStop" || name === "botPause" || name === "botUnpause")
    return parseAidenRemoteBotSessionStateView(value);
  if (name === "botAnswerQuestion") return parseAidenRemoteBotQuestionAnswerReceipt(value);
  if (name === "botAnswerHandoff") return parseAidenRemoteBotHandoffAnswerReceipt(value);
  if (name === "botHandoffOpenOnMac") return parseAidenRemoteBotHandoffOpenOnMacReceipt(value);
  if (name === "botConnectionRequest") return parseAidenRemoteBotConnectionRequestReceipt(value);
  return value;
}

/**
 * A query value as the host reads it back. Hosts before contract revision 41
 * refuse any `%` in a URL, so what they could read stays literal: a space
 * travels as `+` (which every host decodes) and the separators ids and
 * cursors use (`: @ / $ , ; =`) are left as they are; the host splits each
 * pair at its first `=`. Only a character that can't travel literally
 * (`& + # %`, quotes, accents, emoji) is percent-encoded, which revision 41
 * hosts accept.
 */
export function hostQueryValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%(3A|40|2F|24|2C|3B|3D)/giu, (escape) => decodeURIComponent(escape))
    .replace(/'/gu, "%27")
    .replace(/%20/gu, "+");
}

function query(entries: [string, string | undefined][]): string {
  const present = entries.filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return present.length === 0
    ? ""
    : `?${present.map(([key, value]) => `${key}=${hostQueryValue(value)}`).join("&")}`;
}

/**
 * Revision 50 (`attachments:raw`): a chat or Bot picture upload sent to a host
 * that granted this Mac raw uploads goes as the picture's own bytes, about a
 * quarter fewer than the base64 envelope. Anything else, text included, keeps
 * the JSON request `peerOperationRequest` built.
 */
export function peerRawUploadRequest(
  operation: unknown,
  request: Omit<PeerRequest, "credential">,
): Omit<PeerRequest, "credential"> {
  const input = peerRecord(operation);
  if (input.operation !== "uploadAttachment" && input.operation !== "uploadBotAttachment") return request;
  const body = request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return request;
  const { kind, mimeType, name, data } = body as Record<string, unknown>;
  if (kind !== "image" || (mimeType !== "image/png" && mimeType !== "image/jpeg")) return request;
  if (typeof name !== "string" || typeof data !== "string") return request;
  const bytes = Buffer.from(data, "base64");
  // A body that is not exact base64 keeps the envelope, so the host refuses it as before.
  if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES || bytes.toString("base64") !== data) return request;
  let encodedName: string;
  try {
    encodedName = encodeAidenRemoteAttachmentName(name);
  } catch {
    // A lone surrogate cannot be percent-encoded; the envelope lets the host refuse it as before.
    return request;
  }
  if (encodedName.length === 0 || encodedName.length > AIDEN_REMOTE_MAX_ENCODED_ATTACHMENT_NAME) return request;
  const { body: _json, ...rest } = request;
  return { ...rest, rawBody: { contentType: mimeType, encodedName, data: bytes } };
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
  let maxBodyBytes: number | undefined;
  let body: unknown = input.body;
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
    case "contextPressure": {
      // A model pair travels whole, or not at all: the host prices the chat's own model then.
      if ((input.providerId === undefined) !== (input.modelId === undefined))
        throw new Error("Invalid peer context model.");
      path = `/chats/${id()}/context`;
      if (input.providerId !== undefined) {
        // The host takes no percent-encoding, so the ids go literally or not at all.
        const literal = (raw: unknown) => {
          if (typeof raw !== "string" || !AIDEN_REMOTE_CONTEXT_MODEL_ID.test(raw))
            throw new Error("Invalid peer context model.");
          return raw;
        };
        path += `?providerId=${literal(input.providerId)}&modelId=${literal(input.modelId)}`;
      }
      break;
    }
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
      path = "/bots";
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
    case "botSession":
      path = `/bots/${id()}/session`;
      break;
    case "botSessionImage":
      path = `/bots/${id()}/session/images/${item()}`;
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
    case "cloneWorkspace":
      path = "/workspaces";
      method = "POST";
      needsKey = true;
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
    case "uploadAttachment":
      // Not keyed: an unused staged upload expires on the host, so a retry
      // after a lost answer only leaves a short-lived orphan behind.
      path = `/chats/${id()}/attachments`;
      method = "POST";
      maxBodyBytes = MAX_PEER_UPLOAD_BYTES;
      break;
    case "removeAttachment":
      path = `/chats/${id()}/attachments/${pattern(input.itemId, STAGED_ATTACHMENT_ID)}`;
      method = "DELETE";
      break;
    case "forkChat":
      path = `/chats/${id()}/fork`;
      method = "POST";
      needsKey = true;
      needsRevision = true;
      body = forkBody(input.body);
      break;
    case "forkSummaryRetry":
    case "forkSummarySkip":
    case "forkSummaryCancel":
      // Not keyed: retry and skip act only on the summary state they find, and
      // the host reads no body for any of them.
      path = `/chats/${id()}/fork-summary/${operation === "forkSummaryRetry" ? "retry" : operation === "forkSummarySkip" ? "skip" : "cancel"}`;
      method = "POST";
      if (input.body !== undefined && Object.keys(peerRecord(input.body)).length > 0)
        throw new Error("Invalid peer fork summary request.");
      body = {};
      break;
    case "botSend":
      path = `/bots/${id()}/messages`;
      method = "POST";
      needsKey = true;
      break;
    case "botResume":
    case "botDismiss":
    case "botStop":
      path = `/bots/${id()}/${operation === "botResume" ? "resume" : operation === "botDismiss" ? "dismiss" : "stop"}`;
      method = "POST";
      needsKey = true;
      if (input.body !== undefined && Object.keys(peerRecord(input.body)).length > 0)
        throw new Error("Invalid peer Bot session request.");
      body = {};
      break;
    case "botAnswerQuestion":
      path = `/bots/${id()}/questions/${pattern(input.itemId, BOT_WAIT_ID)}/answer`;
      method = "POST";
      needsKey = true;
      break;
    case "botAnswerHandoff":
      path = `/bots/${id()}/handoffs/${pattern(input.itemId, BOT_WAIT_ID)}/answer`;
      method = "POST";
      needsKey = true;
      // Only `{ outcome, note? }` with a known outcome reaches the host.
      body = parseAidenRemoteBotHandoffAnswerRequest(input.body);
      break;
    case "botHandoffOpenOnMac":
      path = `/bots/${id()}/handoffs/${pattern(input.itemId, BOT_WAIT_ID)}/open-on-mac`;
      method = "POST";
      needsKey = true;
      if (input.body !== undefined && Object.keys(peerRecord(input.body)).length > 0)
        throw new Error("Invalid peer Bot session request.");
      body = {};
      break;
    case "botPause":
    case "botUnpause":
      // The same route: POST pauses, DELETE (without a body) lifts the pause.
      path = `/bots/${id()}/pause`;
      method = operation === "botPause" ? "POST" : "DELETE";
      needsKey = true;
      if (input.body !== undefined && Object.keys(peerRecord(input.body)).length > 0)
        throw new Error("Invalid peer Bot session request.");
      body = {};
      break;
    case "botConnectionRequest":
      path = `/bots/${id()}/connection-requests`;
      method = "POST";
      needsKey = true;
      break;
    case "uploadBotAttachment":
      // Not keyed, like a chat upload: an unused staged upload expires on the host.
      path = `/bots/${id()}/attachments`;
      method = "POST";
      maxBodyBytes = MAX_PEER_UPLOAD_BYTES;
      break;
    case "removeBotAttachment":
      path = `/bots/${id()}/attachments/${pattern(input.itemId, STAGED_ATTACHMENT_ID)}`;
      method = "DELETE";
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
      ? { body: body ?? {} }
      : {}),
    ...(needsKey ? { idempotencyKey: token(input.idempotencyKey, 16) } : {}),
    ...(needsRevision ? { revision: token(input.revision, 1) } : {}),
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    ...(operation === "cloneWorkspace" ? { timeoutMs: 115_000 } : {}),
  };
}
