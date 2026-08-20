import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AIDEN_REMOTE_BASE_PATH,
  AIDEN_REMOTE_CAPABILITIES,
  AIDEN_REMOTE_PROTOCOL_VERSION,
  parseAidenRemoteJson,
  type AidenRemoteCapability,
  type AidenRemoteErrorEnvelope,
} from "./aiden-remote-protocol.js";
import {
  AidenRemoteServiceError,
  asAidenRemoteServiceError,
} from "./aiden-remote-errors.js";
import type { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import type {
  AidenRemoteAuthenticatedDevice,
  AidenRemoteConnectionMode,
  AidenRemoteStateRegistry,
} from "./aiden-remote-state.js";
import type { AidenRemoteWorkspaceBrowserService } from "./aiden-remote-workspace-browser.js";
import type { AidenRemoteWorkspaceService } from "./aiden-remote-workspaces.js";
import type { AidenRemoteChatService } from "./aiden-remote-chats.js";
import type { AidenRemoteModelService } from "./aiden-remote-models.js";
import type { AidenRemoteStreamService } from "./aiden-remote-streams.js";
import type { AidenRemoteFileService } from "./aiden-remote-files.js";
import type { AidenRemoteGitService } from "./aiden-remote-git.js";
import type { AidenRemoteScheduleService } from "./aiden-remote-schedules.js";
import type { UsageDateRange, UsageSummary } from "./types.js";
import { MAX_AIDEN_REMOTE_ATTACHMENT_REQUEST_BYTES } from "./aiden-remote-attachments.js";

const MAX_REQUEST_BODY_BYTES = 1_048_576;
const MAX_FILE_REQUEST_BODY_BYTES = 6 * 1_048_576;
const MAX_REQUEST_URL_LENGTH = 2_048;
const SERVER_NAME = "Aiden Agent";

export interface AidenRemoteServerProjection {
  protocolVersion: typeof AIDEN_REMOTE_PROTOCOL_VERSION;
  instanceId: string;
  name: string;
  appVersion: string;
  capabilities: AidenRemoteCapability[];
  connectionMode: AidenRemoteConnectionMode;
  minimumClientVersion?: string;
  serverTime: string;
}

export interface AidenRemoteRouterDependencies {
  instanceId: string;
  appVersion: string;
  devices: Pick<AidenRemoteStateRegistry, "authenticate">;
  pairing: Pick<AidenRemotePairingService, "exchange">;
  workspaces?: Pick<AidenRemoteWorkspaceService, "list" | "get" | "create" | "update" | "remove">;
  workspaceBrowser?: Pick<
    AidenRemoteWorkspaceBrowserService,
    "listRoots" | "listChildren" | "createSelection"
  >;
  chats?: Pick<
    AidenRemoteChatService,
    "list" | "get" | "create" | "rename" | "move" | "remove" | "startTurn"
  > & Partial<Pick<AidenRemoteChatService, "uploadAttachment" | "removeAttachment">>;
  models?: Pick<AidenRemoteModelService, "list">;
  streams?: Pick<
    AidenRemoteStreamService,
    "status" | "cancel" | "respondApproval" | "openEvents"
  >;
  files?: Pick<AidenRemoteFileService, "list" | "read" | "write">;
  git?: Pick<AidenRemoteGitService, "review" | "diff" | "branches" | "checkout" | "createBranch" | "commit" | "pushCapability" | "push" | "compare" | "comparisonDiff" | "worktrees" | "createWorktree" | "deleteManagedWorktree">;
  schedules?: Pick<AidenRemoteScheduleService, "list" | "get" | "create" | "update" | "remove" | "pause" | "resume" | "run" | "runs" | "preview" | "scripts" | "mcpServers" | "settings" | "updateSettings">;
  usage?: { summary(range: UsageDateRange): Promise<UsageSummary> };
  connectionMode(): AidenRemoteConnectionMode;
  now(): number;
  /** Tailscale Serve strips the public API prefix before loopback proxying. */
  acceptStrippedBasePath?: boolean;
  log(entry: {
    requestId: string;
    route:
      | "health"
      | "pairingExchange"
      | "server"
      | "workspaces"
      | "workspace"
      | "workspaceBrowserRoots"
      | "workspaceBrowserChildren"
      | "workspaceBrowserSelection"
      | "workspaceFiles"
      | "workspaceFile"
      | "workspaceGit"
      | "scheduledTasks"
      | "usage"
      | "chats"
      | "chat"
      | "chatMove"
      | "chatAttachment"
      | "turns"
      | "models"
      | "stream"
      | "streamEvents"
      | "streamCancel"
      | "approvalRespond"
      | "unknown";
    status: number;
    latencyMs: number;
    deviceIdSuffix?: string;
    errorCode?: string;
  }): void;
}

function requestId(): string {
  return `req_${randomBytes(18).toString("base64url")}`;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function responseHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "aiden-protocol-version": String(AIDEN_REMOTE_PROTOCOL_VERSION),
    "cache-control": "no-store",
    "content-type": contentType,
    "cross-origin-resource-policy": "same-site",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...responseHeaders(),
    "content-length": String(Buffer.byteLength(body, "utf8")),
  });
  response.end(body);
}

function writeError(
  response: ServerResponse,
  id: string,
  error: AidenRemoteServiceError,
): void {
  const envelope: AidenRemoteErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message,
      requestId: id,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  writeJson(response, error.status, envelope);
}

async function readJsonBody(
  request: IncomingMessage,
  maximumBytes = MAX_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.toLowerCase().split(";", 1)[0]?.trim() !== "application/json"
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "This endpoint requires an application/json request body.",
      415,
    );
  }
  const declaredLength = request.headers["content-length"];
  if (
    typeof declaredLength === "string" &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    throw new AidenRemoteServiceError(
      "payload_too_large",
      "The request body is too large.",
      413,
    );
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximumBytes) {
      throw new AidenRemoteServiceError(
        "payload_too_large",
        "The request body is too large.",
        413,
      );
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body is required.",
      400,
    );
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body must be valid UTF-8 JSON.",
      400,
    );
  }
  try {
    return parseAidenRemoteJson(serialized, "request JSON data");
  } catch {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request body must be valid JSON with unique safe fields.",
      400,
    );
  }
}

function bearerCredential(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization);
  return match?.[1] ?? null;
}

async function authenticate(
  request: IncomingMessage,
  devices: Pick<AidenRemoteStateRegistry, "authenticate">,
  capability: AidenRemoteCapability,
): Promise<AidenRemoteAuthenticatedDevice> {
  if (request.headers["aiden-protocol-version"] !== "1") {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "Aiden-Protocol-Version must be 1.",
      400,
      false,
      { minimumClientVersion: "1" },
    );
  }
  const credential = bearerCredential(request);
  if (!credential) {
    throw new AidenRemoteServiceError(
      "authentication_required",
      "Pair this device in Aiden Settings before connecting.",
      401,
    );
  }
  const device = await devices.authenticate(credential);
  if (!device) {
    throw new AidenRemoteServiceError(
      "authentication_required",
      "This device credential is not valid for this Aiden installation.",
      401,
    );
  }
  if (device.revoked) {
    throw new AidenRemoteServiceError(
      "credential_revoked",
      "This device was revoked in Aiden Settings.",
      403,
    );
  }
  if (!device.capabilities.has(capability)) {
    throw new AidenRemoteServiceError(
      "capability_denied",
      "This device does not have access to that Aiden capability.",
      403,
    );
  }
  return device;
}

function requestTarget(
  request: IncomingMessage,
  acceptStrippedBasePath: boolean,
): { path: string; query: string } {
  const raw = request.url;
  if (
    !raw ||
    raw.length > MAX_REQUEST_URL_LENGTH ||
    raw.includes("#") ||
    raw.includes("%") ||
    raw.includes("\\") ||
    hasAsciiControl(raw)
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request URL is invalid.",
      400,
    );
  }
  const query = raw.indexOf("?");
  const path = query < 0 ? raw : raw.slice(0, query);
  if (
    !path.startsWith("/") ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "The request URL is invalid.",
      400,
    );
  }
  const queryString = query < 0 ? "" : raw.slice(query + 1);
  if (path.startsWith(`${AIDEN_REMOTE_BASE_PATH}/`)) {
    return { path: path.slice(AIDEN_REMOTE_BASE_PATH.length), query: queryString };
  }
  if (acceptStrippedBasePath) {
    return { path, query: queryString };
  }
  return { path: "", query: queryString };
}

function requireNoQuery(query: string): void {
  if (query) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      "This endpoint does not accept query parameters.",
      400,
    );
  }
}

function browserQuery(query: string): { location: string; cursor?: string } {
  const values = new Map<string, string>();
  for (const component of query.split("&")) {
    const separator = component.indexOf("=");
    if (separator <= 0) {
      throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
    }
    const key = component.slice(0, separator);
    const value = component.slice(separator + 1);
    if (values.has(key) || (key !== "location" && key !== "cursor")) {
      throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
    }
    values.set(key, value);
  }
  const location = values.get("location");
  const cursor = values.get("cursor");
  if (
    !location ||
    !/^loc_[A-Za-z0-9_-]{43}$/u.test(location) ||
    (cursor !== undefined && !/^cur_[A-Za-z0-9_-]{43}$/u.test(cursor))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The folder-browser query is invalid.", 400);
  }
  return { location, ...(cursor ? { cursor } : {}) };
}

function chatsQuery(query: string): { workspaceId?: string } {
  if (!query) return {};
  const separator = query.indexOf("=");
  if (
    separator <= 0 ||
    query.slice(0, separator) !== "workspaceId" ||
    query.indexOf("&") >= 0 ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(query.slice(separator + 1))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The chats query is invalid.", 400);
  }
  return { workspaceId: query.slice(separator + 1) };
}

function usageQuery(query: string): UsageDateRange {
  const params = new URLSearchParams(query);
  const range = params.get("range") ?? "30d";
  if (params.size !== 1 || !["7d", "30d", "90d", "1y", "all"].includes(range)) {
    throw new AidenRemoteServiceError("invalid_request", "The usage range is invalid.", 400);
  }
  return range as UsageDateRange;
}

function scheduledScriptsQuery(query: string): { workspaceId?: string } {
  if (!query) return {};
  const separator = query.indexOf("=");
  if (
    separator <= 0 ||
    query.slice(0, separator) !== "workspaceId" ||
    query.indexOf("&") >= 0 ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(query.slice(separator + 1))
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The scheduled-script query is invalid.", 400);
  }
  return { workspaceId: query.slice(separator + 1) };
}

function streamAfter(request: IncomingMessage, query: string): number {
  let after: string | undefined;
  if (query) {
    const separator = query.indexOf("=");
    if (
      separator <= 0 ||
      query.slice(0, separator) !== "after" ||
      query.indexOf("&") >= 0
    ) {
      throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
    }
    after = query.slice(separator + 1);
  }
  const lastEventId = request.headers["last-event-id"];
  if (Array.isArray(lastEventId) || (lastEventId !== undefined && typeof lastEventId !== "string")) {
    throw new AidenRemoteServiceError("invalid_request", "Last-Event-ID is invalid.", 400);
  }
  if (after !== undefined && lastEventId !== undefined && after !== lastEventId) {
    throw new AidenRemoteServiceError("invalid_request", "Stream cursors disagree.", 400);
  }
  const value = after ?? lastEventId ?? "0";
  if (!/^(?:0|[1-9]\d{0,15})$/u.test(value)) {
    throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AidenRemoteServiceError("invalid_request", "The stream cursor is invalid.", 400);
  }
  return parsed;
}

function approvalDecision(value: unknown): "allow" | "deny" {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (
    !record ||
    Object.keys(record).length !== 1 ||
    (record.decision !== "allow" && record.decision !== "deny")
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The approval response is invalid.", 400);
  }
  return record.decision;
}

function requiredHeader(
  request: IncomingMessage,
  name: "if-match" | "idempotency-key",
  pattern: RegExp,
): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new AidenRemoteServiceError(
      "invalid_request",
      `${name === "if-match" ? "If-Match" : "Idempotency-Key"} is required and invalid.`,
      400,
    );
  }
  return value;
}

function selectionLocation(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    typeof (value as { location?: unknown }).location !== "string" ||
    !/^loc_[A-Za-z0-9_-]{43}$/u.test((value as { location: string }).location)
  ) {
    throw new AidenRemoteServiceError("invalid_request", "The folder selection request is invalid.", 400);
  }
  return (value as { location: string }).location;
}

function sourceIdentity(request: IncomingMessage): string {
  const address = request.socket.remoteAddress ?? "unknown";
  return address.length <= 128 ? address : "unknown";
}

export function createAidenRemoteRequestHandler(
  dependencies: AidenRemoteRouterDependencies,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const id = requestId();
    const startedAt = dependencies.now();
    let route: Parameters<AidenRemoteRouterDependencies["log"]>[0]["route"] = "unknown";
    let deviceIdSuffix: string | undefined;
    void (async () => {
      if (request.headers.origin !== undefined) {
        throw new AidenRemoteServiceError(
          "invalid_request",
          "Browser-origin requests are not accepted by Aiden Remote.",
          403,
        );
      }
      const target = requestTarget(
        request,
        dependencies.acceptStrippedBasePath === true,
      );
      const { path, query } = target;
      if (request.method === "GET" && path === "/health") {
        requireNoQuery(query);
        route = "health";
        writeJson(response, 200, {
          ok: true,
          protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
        });
        return;
      }
      if (request.method === "POST" && path === "/pairing/exchange") {
        requireNoQuery(query);
        route = "pairingExchange";
        const result = await dependencies.pairing.exchange(
          await readJsonBody(request),
          sourceIdentity(request),
        );
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && path === "/server") {
        requireNoQuery(query);
        route = "server";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        const projection: AidenRemoteServerProjection = {
          protocolVersion: AIDEN_REMOTE_PROTOCOL_VERSION,
          instanceId: dependencies.instanceId,
          name: SERVER_NAME,
          appVersion: dependencies.appVersion,
          capabilities: [...AIDEN_REMOTE_CAPABILITIES],
          connectionMode: dependencies.connectionMode(),
          serverTime: new Date(dependencies.now()).toISOString(),
        };
        writeJson(response, 200, projection);
        return;
      }
      if (path === "/workspaces" && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaces";
        const device = await authenticate(request, dependencies.devices, "workspace:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaces.list());
        return;
      }
      if (path === "/workspaces" && request.method === "POST") {
        requireNoQuery(query);
        route = "workspaces";
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          201,
          await dependencies.workspaces.create(device.id, key, await readJsonBody(request)),
        );
        return;
      }
      const workspaceMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})$/u.exec(path);
      if (workspaceMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "workspace";
        const device = await authenticate(request, dependencies.devices, "workspace:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaces.get(workspaceMatch[1]!));
        return;
      }
      if (workspaceMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "workspace";
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(
          response,
          200,
          await dependencies.workspaces.update(
            workspaceMatch[1]!,
            revision,
            await readJsonBody(request),
          ),
        );
        return;
      }
      if (workspaceMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "workspace";
        const device = await authenticate(request, dependencies.devices, "workspace:manage");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaces) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await dependencies.workspaces.remove(workspaceMatch[1]!, revision);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const workspaceFilesMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/files$/u.exec(path);
      if (workspaceFilesMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaceFiles";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.files.list(device.id, workspaceFilesMatch[1]!));
        return;
      }
      const workspaceFileMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/files\/(file_[A-Za-z0-9_-]{43})$/u.exec(path);
      if (workspaceFileMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaceFile";
        const device = await authenticate(request, dependencies.devices, "files:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.files.read(device.id, workspaceFileMatch[1]!, workspaceFileMatch[2]!),
        );
        return;
      }
      if (workspaceFileMatch && request.method === "PUT") {
        requireNoQuery(query);
        route = "workspaceFile";
        const device = await authenticate(request, dependencies.devices, "files:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.files) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.files.write(
            device.id,
            workspaceFileMatch[1]!,
            workspaceFileMatch[2]!,
            await readJsonBody(request, MAX_FILE_REQUEST_BODY_BYTES),
          ),
        );
        return;
      }
      const gitBaseMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/git\/(review|diff|branches|checkout|commit|push-capability|push|compare|comparison-diff|worktrees)$/u.exec(path);
      if (gitBaseMatch) {
        requireNoQuery(query);
        route = "workspaceGit";
        const workspaceId = gitBaseMatch[1]!;
        const action = gitBaseMatch[2]!;
        const readRoute =
          (action === "review" && request.method === "GET") ||
          (action === "diff" && request.method === "POST") ||
          (action === "branches" && request.method === "GET") ||
          (action === "push-capability" && request.method === "GET") ||
          (action === "compare" && request.method === "POST") ||
          (action === "comparison-diff" && request.method === "POST") ||
          (action === "worktrees" && request.method === "GET");
        const writeRoute =
          (action === "branches" && request.method === "POST") ||
          (action === "checkout" && request.method === "POST") ||
          (action === "commit" && request.method === "POST") ||
          (action === "push" && request.method === "POST") ||
          (action === "worktrees" && request.method === "POST");
        if (readRoute || writeRoute) {
          const device = await authenticate(
            request,
            dependencies.devices,
            writeRoute ? "git:write" : "git:read",
          );
          deviceIdSuffix = device.id.slice(-8);
          if (!dependencies.git) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
          if (action === "review" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.review(device.id, workspaceId));
            return;
          }
          if (action === "diff" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.diff(device.id, workspaceId, await readJsonBody(request)));
            return;
          }
          if (action === "branches" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.branches(device.id, workspaceId));
            return;
          }
          if (action === "branches" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.createBranch(device.id, workspaceId, key, await readJsonBody(request)));
            return;
          }
          if (action === "checkout" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.checkout(device.id, workspaceId, key, await readJsonBody(request)));
            return;
          }
          if (action === "commit" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.commit(device.id, workspaceId, key, await readJsonBody(request)));
            return;
          }
          if (action === "push-capability" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.pushCapability(device.id, workspaceId));
            return;
          }
          if (action === "push" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.push(device.id, workspaceId, key, await readJsonBody(request)));
            return;
          }
          if (action === "compare" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.compare(device.id, workspaceId, await readJsonBody(request)));
            return;
          }
          if (action === "comparison-diff" && request.method === "POST") {
            writeJson(response, 200, await dependencies.git.comparisonDiff(device.id, workspaceId, await readJsonBody(request)));
            return;
          }
          if (action === "worktrees" && request.method === "GET") {
            writeJson(response, 200, await dependencies.git.worktrees(device.id, workspaceId));
            return;
          }
          if (action === "worktrees" && request.method === "POST") {
            const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
            writeJson(response, 202, await dependencies.git.createWorktree(device.id, workspaceId, key, await readJsonBody(request)));
            return;
          }
        }
      }
      const managedWorktreeMatch = /^\/workspaces\/([A-Za-z0-9_-]{1,128})\/git\/managed-worktree$/u.exec(path);
      if (managedWorktreeMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "workspaceGit";
        const device = await authenticate(request, dependencies.devices, "git:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.git) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(
          response,
          202,
          await dependencies.git.deleteManagedWorktree(
            device.id,
            managedWorktreeMatch[1]!,
            revision,
            key,
            await readJsonBody(request),
          ),
        );
        return;
      }
      if (path === "/scheduled-tasks" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.list(device.id));
        return;
      }
      if (path === "/scheduled-tasks" && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 201, await dependencies.schedules.create(device.id, key, await readJsonBody(request)));
        return;
      }
      if (path === "/scheduled-tasks/preview" && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, dependencies.schedules.preview(await readJsonBody(request)));
        return;
      }
      if (path === "/scheduled-tasks/scripts" && request.method === "GET") {
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.scripts(device.id, scheduledScriptsQuery(query).workspaceId));
        return;
      }
      if (path === "/scheduled-tasks/mcp-servers" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.mcpServers());
        return;
      }
      if (path === "/scheduled-tasks/settings" && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.settings());
        return;
      }
      if (path === "/scheduled-tasks/settings" && request.method === "PATCH") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.schedules.updateSettings(revision, await readJsonBody(request)));
        return;
      }
      const scheduledRunsMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})\/runs$/u.exec(path);
      if (scheduledRunsMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.runs(scheduledRunsMatch[1]!));
        return;
      }
      const scheduledActionMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})\/(pause|resume|run)$/u.exec(path);
      if (scheduledActionMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const taskId = scheduledActionMatch[1]!;
        const action = scheduledActionMatch[2]!;
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (action === "run") {
          writeJson(response, 202, await dependencies.schedules.run(device.id, taskId, key));
          return;
        }
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 202, action === "pause"
          ? await dependencies.schedules.pause(device.id, taskId, revision, key)
          : await dependencies.schedules.resume(device.id, taskId, revision, key));
        return;
      }
      const scheduledTaskMatch = /^\/scheduled-tasks\/([A-Za-z0-9._:-]{1,160})$/u.exec(path);
      if (scheduledTaskMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.schedules.get(device.id, scheduledTaskMatch[1]!));
        return;
      }
      if (scheduledTaskMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.schedules.update(device.id, scheduledTaskMatch[1]!, revision, await readJsonBody(request)));
        return;
      }
      if (scheduledTaskMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "scheduledTasks";
        const device = await authenticate(request, dependencies.devices, "schedule:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.schedules) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await dependencies.schedules.remove(scheduledTaskMatch[1]!, revision);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      if (path === "/workspace-browser/roots" && request.method === "GET") {
        requireNoQuery(query);
        route = "workspaceBrowserRoots";
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.workspaceBrowser.listRoots(device.id));
        return;
      }
      if (path === "/workspace-browser/children" && request.method === "GET") {
        route = "workspaceBrowserChildren";
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const parsed = browserQuery(query);
        writeJson(
          response,
          200,
          await dependencies.workspaceBrowser.listChildren(
            device.id,
            parsed.location,
            parsed.cursor,
          ),
        );
        return;
      }
      if (path === "/workspace-browser/selections" && request.method === "POST") {
        requireNoQuery(query);
        route = "workspaceBrowserSelection";
        const device = await authenticate(request, dependencies.devices, "workspace:browse");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.workspaceBrowser) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          201,
          await dependencies.workspaceBrowser.createSelection(
            device.id,
            selectionLocation(await readJsonBody(request)),
          ),
        );
        return;
      }
      if (path === "/models" && request.method === "GET") {
        requireNoQuery(query);
        route = "models";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.models) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.models.list());
        return;
      }
      if (path === "/usage" && request.method === "GET") {
        route = "usage";
        const device = await authenticate(request, dependencies.devices, "server:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.usage) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.usage.summary(usageQuery(query)));
        return;
      }
      if (path === "/chats" && request.method === "GET") {
        route = "chats";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.chats.list(chatsQuery(query).workspaceId));
        return;
      }
      if (path === "/chats" && request.method === "POST") {
        requireNoQuery(query);
        route = "chats";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 201, await dependencies.chats.create(device.id, key, await readJsonBody(request)));
        return;
      }
      const chatMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})$/u.exec(path);
      if (chatMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "chat";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, await dependencies.chats.get(chatMatch[1]!));
        return;
      }
      if (chatMatch && request.method === "PATCH") {
        requireNoQuery(query);
        route = "chat";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        writeJson(response, 200, await dependencies.chats.rename(chatMatch[1]!, revision, await readJsonBody(request)));
        return;
      }
      if (chatMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "chat";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        await dependencies.chats.remove(chatMatch[1]!, revision);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const moveMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/move$/u.exec(path);
      if (moveMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatMove";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const revision = requiredHeader(request, "if-match", /^[\x21-\x7e]{1,128}$/u);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 200, await dependencies.chats.move(device.id, moveMatch[1]!, revision, key, await readJsonBody(request)));
        return;
      }
      const turnsMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/turns$/u.exec(path);
      if (turnsMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "turns";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        writeJson(response, 202, await dependencies.chats.startTurn(device.id, turnsMatch[1]!, key, await readJsonBody(request)));
        return;
      }
      const attachmentCollectionMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/attachments$/u.exec(path);
      if (attachmentCollectionMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "chatAttachment";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.uploadAttachment) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          201,
          await dependencies.chats.uploadAttachment(
            device.id,
            attachmentCollectionMatch[1]!,
            await readJsonBody(request, MAX_AIDEN_REMOTE_ATTACHMENT_REQUEST_BYTES),
          ),
        );
        return;
      }
      const attachmentMatch = /^\/chats\/([A-Za-z0-9._:-]{1,128})\/attachments\/(att_[A-Za-z0-9_-]{43})$/u.exec(path);
      if (attachmentMatch && request.method === "DELETE") {
        requireNoQuery(query);
        route = "chatAttachment";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.chats?.removeAttachment) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        await dependencies.chats.removeAttachment(device.id, attachmentMatch[1]!, attachmentMatch[2]!);
        response.writeHead(204, responseHeaders());
        response.end();
        return;
      }
      const streamMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})$/u.exec(path);
      if (streamMatch && request.method === "GET") {
        requireNoQuery(query);
        route = "stream";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.streams) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 200, dependencies.streams.status(device.id, streamMatch[1]!));
        return;
      }
      const eventsMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/events$/u.exec(path);
      if (eventsMatch && request.method === "GET") {
        route = "streamEvents";
        const device = await authenticate(request, dependencies.devices, "chat:read");
        deviceIdSuffix = device.id.slice(-8);
        if (!dependencies.streams) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        dependencies.streams.openEvents(device.id, eventsMatch[1]!, streamAfter(request, query), response);
        return;
      }
      const cancelMatch = /^\/streams\/([A-Za-z0-9._:-]{1,128})\/cancel$/u.exec(path);
      if (cancelMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "streamCancel";
        const device = await authenticate(request, dependencies.devices, "chat:write");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (!dependencies.streams) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(response, 202, await dependencies.streams.cancel(device.id, cancelMatch[1]!, key));
        return;
      }
      const approvalMatch = /^\/approvals\/([A-Za-z0-9._:-]{1,128})\/respond$/u.exec(path);
      if (approvalMatch && request.method === "POST") {
        requireNoQuery(query);
        route = "approvalRespond";
        const device = await authenticate(request, dependencies.devices, "approval:respond");
        deviceIdSuffix = device.id.slice(-8);
        const key = requiredHeader(request, "idempotency-key", /^[\x21-\x7e]{16,128}$/u);
        if (!dependencies.streams) throw new AidenRemoteServiceError("not_found", "This endpoint is unavailable.", 404);
        writeJson(
          response,
          200,
          await dependencies.streams.respondApproval(
            device.id,
            approvalMatch[1]!,
            approvalDecision(await readJsonBody(request)),
            key,
          ),
        );
        return;
      }
      throw new AidenRemoteServiceError(
        "not_found",
        "This Aiden Remote endpoint does not exist.",
        404,
      );
    })()
      .then(() => {
        dependencies.log({
          requestId: id,
          route,
          status: response.statusCode,
          latencyMs: Math.max(0, dependencies.now() - startedAt),
          ...(deviceIdSuffix ? { deviceIdSuffix } : {}),
        });
      })
      .catch((error: unknown) => {
        const safe = asAidenRemoteServiceError(error);
        if (!response.headersSent) writeError(response, id, safe);
        else response.destroy();
        dependencies.log({
          requestId: id,
          route,
          status: safe.status,
          latencyMs: Math.max(0, dependencies.now() - startedAt),
          ...(deviceIdSuffix ? { deviceIdSuffix } : {}),
          errorCode: safe.code,
        });
      });
  };
}
