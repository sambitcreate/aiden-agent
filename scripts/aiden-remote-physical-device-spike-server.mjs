import { execFile } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const advertisedHost = option("--host");
const requestedMode = option("--mode") ?? "original";
const requestedIdentityDirectory = option("--identity-dir");
const requestedPortValue = option("--port");
const requestedRepairSecretFile = option("--repair-secret-file");
const requestedPublicEndpoint = option("--public-endpoint");
const requestedPublicSpkiSha256 = option("--public-spki-sha256");
const initializeRequested = process.argv.includes("--initialize");
const persistAuthRequested = process.argv.includes("--persist-auth");
const listenHttpRequested = process.argv.includes("--listen-http");
const systemTrustRequested = process.argv.includes("--system-trust");
const phase7Requested = process.argv.includes("--phase7");
const phase6Requested = process.argv.includes("--phase6") || phase7Requested;
const supportedModes = new Set(["original", "renewed", "rotated", "wrong-host", "expired"]);
const requestedPort = requestedPortValue === undefined ? 0 : Number(requestedPortValue);
const hasCompletePublicTransport = listenHttpRequested && systemTrustRequested &&
  requestedPublicEndpoint !== undefined && requestedPublicSpkiSha256 !== undefined;
const hasAnyPublicTransport = listenHttpRequested || systemTrustRequested ||
  requestedPublicEndpoint !== undefined || requestedPublicSpkiSha256 !== undefined;

let publicEndpoint;
if (requestedPublicEndpoint !== undefined) {
  try {
    const parsed = new URL(requestedPublicEndpoint);
    if (parsed.href !== requestedPublicEndpoint || parsed.protocol !== "https:" ||
        parsed.username || parsed.password || parsed.port ||
        parsed.pathname !== "/api/aiden/v1" || parsed.search || parsed.hash) {
      throw new Error("invalid");
    }
    publicEndpoint = parsed.href;
  } catch {
    throw new Error("The public endpoint must be a canonical HTTPS Aiden API endpoint on port 443.");
  }
}
let publicSpkiSha256;
if (requestedPublicSpkiSha256 !== undefined) {
  const encoded = requestedPublicSpkiSha256.startsWith("sha256/")
    ? requestedPublicSpkiSha256.slice("sha256/".length)
    : "";
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded) || Buffer.from(encoded, "base64").length !== 32) {
    throw new Error("The public SPKI pin must be a SHA-256 fingerprint.");
  }
  publicSpkiSha256 = requestedPublicSpkiSha256;
}

if (!advertisedHost || !/^[A-Za-z0-9.-]+$/.test(advertisedHost) || !supportedModes.has(requestedMode) ||
    !Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535 ||
    (requestedRepairSecretFile !== undefined && (!persistAuthRequested || !phase6Requested)) ||
    (hasAnyPublicTransport && (!hasCompletePublicTransport || !phase6Requested))) {
  throw new Error(
    "Usage: node scripts/aiden-remote-physical-device-spike-server.mjs --host <LAN IP or hostname> " +
      "[--identity-dir <private temporary directory> --initialize] " +
      "[--mode original|renewed|rotated|wrong-host|expired] [--port <0...65535>] [--persist-auth] " +
      "[--repair-secret-file <owner-only secret file>] " +
      "[--listen-http --system-trust --public-endpoint <https endpoint> --public-spki-sha256 <pin>]",
  );
}

const ownsIdentityDirectory = requestedIdentityDirectory === undefined;
const identityDirectory = requestedIdentityDirectory
  ? path.resolve(requestedIdentityDirectory)
  : await mkdtemp(path.join(os.tmpdir(), "aiden-physical-transport-identity-"));
const shouldInitialize = ownsIdentityDirectory || initializeRequested;
const manifestPath = path.join(identityDirectory, "identity.json");
const authStatePath = path.join(identityDirectory, "physical-auth-state.json");
const authRevocationPath = path.join(identityDirectory, "physical-auth-revoked");
const repairWindowPath = path.join(identityDirectory, "physical-repair-open");
const caKeyPath = path.join(identityDirectory, "ca-key.pem");
const caCertificatePath = path.join(identityDirectory, "ca-certificate.pem");
const stableKeyPath = path.join(identityDirectory, "stable-server-key.pem");
const rotatedKeyPath = path.join(identityDirectory, "rotated-server-key.pem");
const subjectAlternativeName = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(advertisedHost)
  ? `IP:${advertisedHost}`
  : `DNS:${advertisedHost}`;

async function issueCertificate(mode, keyPath, alternativeName, days) {
  const certificatePath = path.join(identityDirectory, `${mode}-certificate.pem`);
  const requestPath = path.join(identityDirectory, `${mode}-request.pem`);
  await execFileAsync("openssl", [
    "req", "-new", "-key", keyPath,
    "-subj", `/CN=Aiden Phase 0 Physical Device Spike/OU=${mode}`,
    "-addext", `subjectAltName=${alternativeName}`,
    "-addext", "basicConstraints=critical,CA:FALSE",
    "-addext", "keyUsage=critical,digitalSignature",
    "-addext", "extendedKeyUsage=serverAuth",
    "-out", requestPath,
  ]);
  await execFileAsync("openssl", [
    "x509", "-req", "-in", requestPath,
    "-CA", caCertificatePath, "-CAkey", caKeyPath, "-CAcreateserial",
    "-days", String(days), "-sha256", "-copy_extensions", "copy",
    "-out", certificatePath,
  ]);
}

async function initializeIdentity() {
  await mkdir(identityDirectory, { recursive: true, mode: 0o700 });
  try {
    await readFile(manifestPath, "utf8");
    throw new Error("Refusing to overwrite an existing Phase 0 transport identity.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await execFileAsync("openssl", [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", stableKeyPath,
  ]);
  await execFileAsync("openssl", [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", rotatedKeyPath,
  ]);
  await execFileAsync("openssl", [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", caKeyPath,
  ]);
  await execFileAsync("openssl", [
    "req", "-x509", "-new", "-key", caKeyPath, "-sha256", "-days", "3650",
    "-subj", "/CN=Aiden Phase 0 Physical Local CA",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-out", caCertificatePath,
  ]);
  await issueCertificate("original", stableKeyPath, subjectAlternativeName, 1);
  await issueCertificate("renewed", stableKeyPath, subjectAlternativeName, 2);
  await issueCertificate("rotated", rotatedKeyPath, subjectAlternativeName, 1);
  await issueCertificate("wrong-host", stableKeyPath, "DNS:wrong-host.aiden.invalid", 1);
  await issueCertificate("expired", stableKeyPath, subjectAlternativeName, 0);
  await writeFile(
    manifestPath,
    `${JSON.stringify({ version: 1, advertisedHost }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

if (shouldInitialize) await initializeIdentity();
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.version !== 1 || manifest.advertisedHost !== advertisedHost) {
  throw new Error("The persisted Phase 0 identity is bound to a different advertised host.");
}

const selectedKeyPath = requestedMode === "rotated" ? rotatedKeyPath : stableKeyPath;
const certificatePath = path.join(identityDirectory, `${requestedMode}-certificate.pem`);
const [privateKey, certificate, caCertificate] = await Promise.all([
  readFile(selectedKeyPath, "utf8"),
  readFile(certificatePath, "utf8"),
  readFile(caCertificatePath, "utf8"),
]);
const x509 = new X509Certificate(certificate);
const fingerprint = `sha256/${createHash("sha256")
  .update(x509.publicKey.export({ type: "spki", format: "der" }))
  .digest("base64")}`;
const pairingSecret = randomBytes(32).toString("base64url");
const deviceCredential = randomBytes(32).toString("base64url");
const repairSecretPath = requestedRepairSecretFile === undefined
  ? undefined
  : path.resolve(requestedRepairSecretFile);
if (repairSecretPath !== undefined) {
  const metadata = await stat(repairSecretPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error("The repair pairing secret file must be a regular owner-only file.");
  }
}
const repairPairingSecret = repairSecretPath === undefined
  ? undefined
  : (await readFile(repairSecretPath, "utf8")).trim();
if (repairPairingSecret !== undefined && !/^[A-Za-z0-9_-]{43}$/u.test(repairPairingSecret)) {
  throw new Error("The repair pairing secret must be exactly 32 bytes of base64url data.");
}
const repairedDeviceCredential = repairPairingSecret === undefined
  ? undefined
  : randomBytes(32).toString("base64url");
const instanceId = phase6Requested
  ? phase7Requested ? "phase7-physical-device-spike" : "phase6-physical-device-spike"
  : "phase0-physical-device-spike";
let pairingConsumed = false;
let repairPairingConsumed = false;
let authorizedCredentialDigest;
const revokedCredentialDigests = new Set();
if (persistAuthRequested) {
  try {
    const persistedAuth = JSON.parse(await readFile(authStatePath, "utf8"));
    if (Object.keys(persistedAuth).sort().join(",") !==
          "credentialSha256,revokedCredentialSha256,version" ||
        persistedAuth.version !== 2 ||
        typeof persistedAuth.credentialSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(persistedAuth.credentialSha256) ||
        !Array.isArray(persistedAuth.revokedCredentialSha256) ||
        persistedAuth.revokedCredentialSha256.length > 16 ||
        persistedAuth.revokedCredentialSha256.some((value) =>
          typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value) ||
          value === persistedAuth.credentialSha256
        ) ||
        new Set(persistedAuth.revokedCredentialSha256).size !==
          persistedAuth.revokedCredentialSha256.length) {
      throw new Error("The persisted physical auth state is invalid.");
    }
    pairingConsumed = true;
    authorizedCredentialDigest = persistedAuth.credentialSha256;
    for (const digest of persistedAuth.revokedCredentialSha256) {
      revokedCredentialDigests.add(digest);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
let workspaceSequence = 0;
let selectionConsumed = false;
const workspaceLocation = `loc_${randomBytes(32).toString("base64url")}`;
const workspaceSelection = `sel_${randomBytes(32).toString("base64url")}`;
const workspaces = new Map();
const chats = new Map();
const streams = new Map();
const attachments = new Map();
let chatSequence = 0;
let messageSequence = 0;
let turnSequence = 0;

const chatCapabilities = ["chat:read", "chat:write", "approval:respond"];

function chat(workspaceId) {
  chatSequence += 1;
  const timestamp = new Date().toISOString();
  return {
    id: `chat-${chatSequence}`,
    workspaceId,
    title: "New Chat",
    providerId: "openai",
    modelId: "gpt-5.6",
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `chat-rev-${chatSequence}-1`,
  };
}

function streamEvent(streamId, sequence, type, terminal, payload) {
  return {
    protocolVersion: 1,
    streamId,
    sequence,
    timestamp: new Date().toISOString(),
    type,
    terminal,
    payload,
  };
}

function sendSSE(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "aiden-protocol-version": "1",
  });
  for (const event of events) {
    response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function sendJSON(response, status, value) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendError(response, status, code, message) {
  sendJSON(response, status, {
    error: { code, message, requestId: "physical-device-spike", retryable: false },
  });
}

async function isPersistedAuthRevoked() {
  if (!persistAuthRequested) return false;
  try {
    await access(authRevocationPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function persistCredentialDigest(credentialSha256, replaceExisting) {
  if (replaceExisting && authorizedCredentialDigest !== undefined) {
    revokedCredentialDigests.add(authorizedCredentialDigest);
  }
  const value = `${JSON.stringify({
    version: 2,
    credentialSha256,
    revokedCredentialSha256: [...revokedCredentialDigests],
  }, null, 2)}\n`;
  if (!replaceExisting) {
    await writeFile(authStatePath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return;
  }
  const temporaryPath = path.join(
    identityDirectory,
    `physical-auth-state-${randomBytes(8).toString("hex")}.tmp`,
  );
  await writeFile(temporaryPath, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, authStatePath);
}

async function readJSON(request, maximumBytes = 1_048_576) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of request) {
    byteCount += chunk.length;
    if (byteCount > maximumBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const attachmentIdPattern = /^att_[A-Za-z0-9_-]{43}$/u;
const allowedTextMimeTypes = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json", "application/xml",
  "application/yaml", "application/x-yaml", "application/javascript", "application/typescript",
]);

function validAttachmentName(value) {
  return typeof value === "string" && value.length > 0 && [...value].length <= 255 &&
    [...value].every((character) => {
      const scalar = character.codePointAt(0);
      return scalar > 0x1f && scalar !== 0x7f && character !== "/" && character !== "\\";
    });
}

function attachmentReference(body) {
  if (!validAttachmentName(body.name) || body.kind !== "text" ||
      typeof body.mimeType !== "string" || !allowedTextMimeTypes.has(body.mimeType) ||
      typeof body.text !== "string" || [...body.text].length > 100_000) {
    return undefined;
  }
  const size = Buffer.byteLength(body.text, "utf8");
  if (size > 400_000) return undefined;
  return {
    id: `att_${randomBytes(32).toString("base64url")}`,
    name: body.name,
    mimeType: body.mimeType,
    kind: "text",
    size,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function workspace(name, hasFolder) {
  workspaceSequence += 1;
  const timestamp = new Date().toISOString();
  return {
    id: `workspace-${workspaceSequence}`,
    name,
    permission: "ask",
    hasFolder,
    isManagedWorktree: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: `rev-${workspaceSequence}-1`,
  };
}

async function handlePhase6Request(request, response, endpoint, advertisedFingerprint) {
  const url = new URL(request.url ?? "/", endpoint);
  const pathName = url.pathname;
  if (request.method === "POST" && pathName === "/api/aiden/v1/pairing/exchange") {
    const body = await readJSON(request);
    const isInitialPairing = !pairingConsumed && body.secret === pairingSecret;
    const isRepairPairing = repairPairingSecret !== undefined &&
      repairedDeviceCredential !== undefined &&
      !repairPairingConsumed &&
      pairingConsumed &&
      body.secret === repairPairingSecret &&
      await pathExists(repairWindowPath) &&
      await isPersistedAuthRevoked();
    if (!isInitialPairing && !isRepairPairing) {
      sendError(response, 401, "pairing_closed", "Pairing is unavailable.");
      return;
    }
    const issuedCredential = isRepairPairing ? repairedDeviceCredential : deviceCredential;
    const credentialSha256 = createHash("sha256").update(issuedCredential).digest("hex");
    if (isRepairPairing) repairPairingConsumed = true;
    else pairingConsumed = true;
    if (persistAuthRequested) {
      await persistCredentialDigest(credentialSha256, isRepairPairing);
    }
    authorizedCredentialDigest = credentialSha256;
    if (isRepairPairing) {
      await Promise.all([
        rm(authRevocationPath, { force: true }),
        rm(repairWindowPath, { force: true }),
      ]);
    }
    sendJSON(response, 200, {
      protocolVersion: 1,
      instanceId,
      deviceId: isRepairPairing ? "physical-iphone-13-pro-repaired" : "physical-iphone-13-pro",
      credential: issuedCredential,
      capabilities: ["server:read", "workspace:read", "workspace:manage", ...(phase7Requested ? chatCapabilities : [])],
      endpoint,
      serverSpkiSha256: advertisedFingerprint,
    });
    return;
  }
  const authorization = request.headers.authorization;
  const suppliedCredential = typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  const suppliedCredentialDigest = suppliedCredential === undefined
    ? undefined
    : createHash("sha256").update(suppliedCredential).digest("hex");
  if (request.headers["aiden-protocol-version"] !== "1") {
    sendError(response, 400, "invalid_request", "Aiden-Protocol-Version must be 1.");
    return;
  }
  if (authorizedCredentialDigest === undefined || suppliedCredentialDigest === undefined) {
    sendError(response, 401, "authentication_required", "Pair this device again.");
    return;
  }
  if (revokedCredentialDigests.has(suppliedCredentialDigest) ||
      (suppliedCredentialDigest === authorizedCredentialDigest && await isPersistedAuthRevoked())) {
    sendError(response, 403, "credential_revoked", "Pair this device again.");
    return;
  }
  if (suppliedCredentialDigest !== authorizedCredentialDigest) {
    sendError(response, 401, "authentication_required", "Pair this device again.");
    return;
  }
  if (request.method === "GET" && pathName === "/api/aiden/v1/server") {
    sendJSON(response, 200, {
      protocolVersion: 1,
      instanceId,
      name: "Aiden Physical Device Spike",
      appVersion: "1.0.0",
      capabilities: ["server:read", "workspace:read", "workspace:manage", ...(phase7Requested ? chatCapabilities : [])],
      connectionMode: systemTrustRequested ? "tailscale" : "lan",
      serverTime: new Date().toISOString(),
    });
    return;
  }
  if (request.method === "GET" && pathName === "/api/aiden/v1/workspaces") {
    sendJSON(response, 200, { workspaces: [...workspaces.values()] });
    return;
  }
  if (request.method === "POST" && pathName === "/api/aiden/v1/workspaces") {
    const body = await readJSON(request);
    let created;
    if (body.mode === "folderless" && typeof body.name === "string") {
      created = workspace(body.name, false);
    } else if (body.mode === "scratch") {
      created = workspace("Scratch Workspace", true);
    } else if (body.mode === "selected-folder" &&
               body.selection === workspaceSelection && !selectionConsumed) {
      selectionConsumed = true;
      created = workspace(body.name ?? "Approved Project", true);
    } else {
      sendError(response, 409, "handle_invalid", "The folder selection is invalid or expired.");
      return;
    }
    workspaces.set(created.id, created);
    sendJSON(response, 201, created);
    return;
  }
  if (request.method === "GET" && pathName === "/api/aiden/v1/workspace-browser/roots") {
    sendJSON(response, 200, {
      roots: [{
        id: "root-projects",
        label: "Projects",
        location: workspaceLocation,
        policyRevision: "policy-1",
      }],
    });
    return;
  }
  if (request.method === "GET" && pathName === "/api/aiden/v1/workspace-browser/children") {
    if (url.searchParams.get("location") !== workspaceLocation) {
      sendError(response, 404, "handle_invalid", "The folder location is invalid.");
      return;
    }
    sendJSON(response, 200, {
      rootId: "root-projects",
      label: "Projects",
      breadcrumbs: [{ label: "Projects", location: workspaceLocation }],
      entries: [{ id: "entry-aiden", name: "aiden-agent", location: workspaceLocation }],
    });
    return;
  }
  if (request.method === "POST" && pathName === "/api/aiden/v1/workspace-browser/selections") {
    const body = await readJSON(request);
    if (body.location !== workspaceLocation || selectionConsumed) {
      sendError(response, 409, "handle_invalid", "The folder selection is invalid or expired.");
      return;
    }
    sendJSON(response, 201, {
      selection: workspaceSelection,
      displayName: "aiden-agent",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    return;
  }
  if (phase7Requested && request.method === "GET" && pathName === "/api/aiden/v1/chats") {
    const workspaceId = url.searchParams.get("workspaceId");
    sendJSON(response, 200, {
      chats: [...chats.values()].filter((candidate) => !workspaceId || candidate.workspaceId === workspaceId),
    });
    return;
  }
  if (phase7Requested && request.method === "POST" && pathName === "/api/aiden/v1/chats") {
    const body = await readJSON(request);
    if (!workspaces.has(body.workspaceId) || !request.headers["idempotency-key"]) {
      sendError(response, 400, "invalid_request", "A workspace and idempotency key are required.");
      return;
    }
    const created = chat(body.workspaceId);
    chats.set(created.id, created);
    sendJSON(response, 201, created);
    return;
  }
  if (phase7Requested && request.method === "GET" && pathName === "/api/aiden/v1/models") {
    sendJSON(response, 200, {
      providers: [{
        id: "openai",
        label: "OpenAI",
        models: [{ id: "gpt-5.6", label: "GPT-5.6", thinkingLevels: ["high", "max"] }],
      }],
      defaults: { providerId: "openai", modelId: "gpt-5.6" },
    });
    return;
  }
  const attachmentCollectionMatch = pathName.match(/^\/api\/aiden\/v1\/chats\/([^/]+)\/attachments$/u);
  if (phase7Requested && request.method === "POST" && attachmentCollectionMatch) {
    const existing = chats.get(attachmentCollectionMatch[1]);
    if (!existing) {
      sendError(response, 404, "not_found", "Chat not found.");
      return;
    }
    const body = await readJSON(request, 12 * 1_048_576);
    const reference = attachmentReference(body);
    if (!reference) {
      sendError(response, 400, "invalid_request", "The attachment is invalid.");
      return;
    }
    attachments.set(reference.id, { chatId: existing.id, reference });
    sendJSON(response, 201, reference);
    return;
  }
  const attachmentItemMatch = pathName.match(
    /^\/api\/aiden\/v1\/chats\/([^/]+)\/attachments\/(att_[A-Za-z0-9_-]{43})$/u,
  );
  if (phase7Requested && request.method === "DELETE" && attachmentItemMatch) {
    const [,, chatId, attachmentId] = attachmentItemMatch;
    const record = attachments.get(attachmentId);
    if (record?.chatId === chatId) attachments.delete(attachmentId);
    response.writeHead(204, { "cache-control": "no-store" }).end();
    return;
  }
  const chatMatch = pathName.match(/^\/api\/aiden\/v1\/chats\/([^/]+)$/u);
  if (phase7Requested && chatMatch) {
    const existing = chats.get(chatMatch[1]);
    if (!existing) {
      sendError(response, 404, "not_found", "Chat not found.");
      return;
    }
    if (request.method === "GET") {
      sendJSON(response, 200, existing);
      return;
    }
    if (request.headers["if-match"] !== existing.revision) {
      sendError(response, 409, "revision_conflict", "The chat changed.");
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJSON(request);
      const updated = {
        ...existing,
        title: body.title,
        updatedAt: new Date().toISOString(),
        revision: `${existing.revision}-next`,
      };
      chats.set(updated.id, updated);
      sendJSON(response, 200, updated);
      return;
    }
    if (request.method === "DELETE") {
      chats.delete(existing.id);
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
  }
  const turnMatch = pathName.match(/^\/api\/aiden\/v1\/chats\/([^/]+)\/turns$/u);
  if (phase7Requested && request.method === "POST" && turnMatch) {
    const existing = chats.get(turnMatch[1]);
    if (!existing || !request.headers["idempotency-key"]) {
      sendError(response, 400, "invalid_request", "The chat and idempotency key are required.");
      return;
    }
    const body = await readJSON(request);
    const requestedAttachmentIds = body.attachmentIds === undefined ? [] : body.attachmentIds;
    const validAttachmentIds = Array.isArray(requestedAttachmentIds) &&
      requestedAttachmentIds.length <= 10 &&
      new Set(requestedAttachmentIds).size === requestedAttachmentIds.length &&
      requestedAttachmentIds.every((id) => typeof id === "string" && attachmentIdPattern.test(id));
    if (!validAttachmentIds || typeof body.text !== "string" ||
        (body.text.trim().length === 0 && requestedAttachmentIds.length === 0)) {
      sendError(response, 400, "invalid_request", "Text or attachments are required.");
      return;
    }
    const attachmentRecords = requestedAttachmentIds.map((id) => attachments.get(id));
    if (attachmentRecords.some((record) => !record || record.chatId !== existing.id ||
        Date.parse(record.reference.expiresAt) <= Date.now())) {
      sendError(response, 409, "handle_invalid", "An attachment is invalid, expired, or already used.");
      return;
    }
    const messageAttachments = attachmentRecords.map(({ reference }) => ({
      id: reference.id,
      name: reference.name,
      mimeType: reference.mimeType,
      kind: reference.kind,
      size: reference.size,
    }));
    for (const id of requestedAttachmentIds) attachments.delete(id);
    turnSequence += 1;
    messageSequence += 1;
    const turnId = `turn-${turnSequence}`;
    const streamId = `stream-${turnSequence}`;
    const userMessage = {
      id: `message-${messageSequence}`,
      role: "user",
      text: body.text,
      ...(messageAttachments.length > 0 ? { attachments: messageAttachments } : {}),
      createdAt: new Date().toISOString(),
    };
    existing.messages.push(userMessage);
    existing.updatedAt = new Date().toISOString();
    existing.revision = `${existing.revision}-turn-${turnSequence}`;
    streams.set(streamId, {
      streamId,
      chatId: existing.id,
      turnId,
      kind: body.text.includes("cancel") ? "cancel" : "approval",
      state: "running",
      approved: false,
      cancelled: false,
      completed: false,
    });
    sendJSON(response, 202, { turnId, streamId, status: "accepted", message: userMessage });
    return;
  }
  const streamMatch = pathName.match(/^\/api\/aiden\/v1\/streams\/([^/]+)$/u);
  if (phase7Requested && request.method === "GET" && streamMatch) {
    const stream = streams.get(streamMatch[1]);
    if (!stream) {
      sendError(response, 404, "not_found", "Stream not found.");
      return;
    }
    sendJSON(response, 200, {
      streamId: stream.streamId,
      chatId: stream.chatId,
      turnId: stream.turnId,
      state: stream.cancelled ? "cancelled" : stream.completed ? "done" : stream.approved ? "running" : stream.state,
      lastSequence: stream.cancelled ? 2 : stream.completed ? 10 : stream.approved ? 10 : 7,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  const eventMatch = pathName.match(/^\/api\/aiden\/v1\/streams\/([^/]+)\/events$/u);
  if (phase7Requested && request.method === "GET" && eventMatch) {
    const stream = streams.get(eventMatch[1]);
    if (!stream) {
      sendError(response, 404, "not_found", "Stream not found.");
      return;
    }
    const after = Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0);
    if (stream.cancelled) {
      sendSSE(response, [
        streamEvent(stream.streamId, 1, "status", false, { state: "running" }),
        streamEvent(stream.streamId, 2, "cancelled", true, { source: "device" }),
      ].filter((event) => event.sequence > after));
      return;
    }
    if (after < 2) {
      sendSSE(response, [
        streamEvent(stream.streamId, 1, "status", false, { state: "running" }),
        streamEvent(stream.streamId, 2, "text_delta", false, { text: "Hello " }),
      ].filter((event) => event.sequence > after));
      return;
    }
    if (!stream.approved) {
      stream.state = "waiting_for_approval";
      sendSSE(response, [
        streamEvent(stream.streamId, 3, "reasoning_delta", false, { text: "Checking the workspace." }),
        streamEvent(stream.streamId, 4, "tool_started", false, { toolId: "tool-1", name: "workspace_read" }),
        streamEvent(stream.streamId, 5, "tool_finished", false, { toolId: "tool-1", status: "succeeded" }),
        streamEvent(stream.streamId, 6, "timeline", false, { label: "Reviewed workspace" }),
        streamEvent(stream.streamId, 7, "approval_required", false, {
          approvalId: "approval-1",
          summary: "Allow Aiden to finish this physical-device proof?",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ].filter((event) => event.sequence > after));
      return;
    }
    const existing = chats.get(stream.chatId);
    if (!stream.completed) {
      messageSequence += 1;
      existing.messages.push({
        id: `message-${messageSequence}`,
        role: "assistant",
        text: "Hello from Aiden.",
        createdAt: new Date().toISOString(),
      });
      existing.updatedAt = new Date().toISOString();
      existing.revision = `${existing.revision}-done`;
      stream.completed = true;
    }
    sendSSE(response, [
      streamEvent(stream.streamId, 8, "status", false, { state: "running" }),
      streamEvent(stream.streamId, 9, "text_delta", false, { text: "from Aiden." }),
      streamEvent(stream.streamId, 10, "done", true, { messageId: existing.messages.at(-1).id }),
    ].filter((event) => event.sequence > after));
    return;
  }
  const cancelMatch = pathName.match(/^\/api\/aiden\/v1\/streams\/([^/]+)\/cancel$/u);
  if (phase7Requested && request.method === "POST" && cancelMatch) {
    const stream = streams.get(cancelMatch[1]);
    if (!stream || !request.headers["idempotency-key"]) {
      sendError(response, 404, "not_found", "Stream not found.");
      return;
    }
    stream.cancelled = true;
    sendJSON(response, 202, {
      streamId: stream.streamId,
      chatId: stream.chatId,
      turnId: stream.turnId,
      state: "cancelled",
      lastSequence: 2,
      updatedAt: new Date().toISOString(),
    });
    return;
  }
  if (phase7Requested && request.method === "POST" && pathName === "/api/aiden/v1/approvals/approval-1/respond") {
    const body = await readJSON(request);
    const stream = [...streams.values()].find((candidate) => candidate.state === "waiting_for_approval");
    if (!stream || !["allow", "deny"].includes(body.decision)) {
      sendError(response, 409, "approval_expired", "Approval is unavailable.");
      return;
    }
    stream.approved = body.decision === "allow";
    stream.state = stream.approved ? "running" : "cancelled";
    sendJSON(response, 200, {
      approvalId: "approval-1",
      decision: body.decision,
      resolvedAt: new Date().toISOString(),
    });
    return;
  }
  const workspaceMatch = pathName.match(/^\/api\/aiden\/v1\/workspaces\/([^/]+)$/u);
  if (workspaceMatch) {
    const existing = workspaces.get(workspaceMatch[1]);
    if (!existing) {
      sendError(response, 404, "not_found", "Workspace not found.");
      return;
    }
    if (request.headers["if-match"] !== existing.revision) {
      sendError(response, 409, "revision_conflict", "The workspace changed.");
      return;
    }
    if (request.method === "PATCH") {
      const body = await readJSON(request);
      const revisionNumber = Number(existing.revision.split("-").at(-1)) + 1;
      const updated = {
        ...existing,
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.permission === "string" ? { permission: body.permission } : {}),
        updatedAt: new Date().toISOString(),
        revision: `rev-${workspaceMatch[1].slice("workspace-".length)}-${revisionNumber}`,
      };
      workspaces.set(updated.id, updated);
      sendJSON(response, 200, updated);
      return;
    }
    if (request.method === "DELETE") {
      workspaces.delete(existing.id);
      response.writeHead(204, { "cache-control": "no-store" }).end();
      return;
    }
  }
  sendError(response, 404, "not_found", "Route not found.");
}
const requestHandler = async (request, response) => {
  if (request.url !== "/api/aiden/v1/health") {
    if (phase6Requested) {
      try {
        await handlePhase6Request(
          request,
          response,
          pairingBootstrap.endpoint,
          pairingBootstrap.serverSpkiSha256,
        );
      } catch {
        sendError(response, 400, "invalid_request", "The request is invalid.");
      }
      return;
    }
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify({ ok: true, protocolVersion: 1 }));
};
const server = listenHttpRequested
  ? http.createServer(requestHandler)
  : https.createServer({ key: privateKey, cert: `${certificate}\n${caCertificate}` }, requestHandler);
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(requestedPort, "0.0.0.0", resolve);
});
const address = server.address();
if (!address || typeof address === "string") throw new Error("Physical-device spike failed to bind TCP.");
const pairingBootstrap = {
  protocolVersion: 1,
  instanceId,
  endpoint: publicEndpoint ?? `https://${advertisedHost}:${address.port}/api/aiden/v1`,
  serverSpkiSha256: publicSpkiSha256 ?? fingerprint,
  secret: pairingSecret,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const pairingTrust = systemTrustRequested
  ? { mode: "system" }
  : {
      mode: "private-ca",
      caCertificateDerBase64: new X509Certificate(caCertificate).raw.toString("base64"),
    };
const pairingPayload = {
  kind: "aiden-pairing-v1",
  bootstrap: pairingBootstrap,
  trust: pairingTrust,
};
const encodedPairingPayload = JSON.stringify(pairingPayload);
if (Buffer.byteLength(encodedPairingPayload, "utf8") > 4_096) {
  throw new Error("Physical-device pairing payload is too large.");
}
process.stdout.write(`${encodedPairingPayload}\n`);
if (repairPairingSecret !== undefined) {
  const repairPairingPayload = {
    kind: "aiden-pairing-v1",
    bootstrap: {
      ...pairingBootstrap,
      secret: repairPairingSecret,
    },
    trust: pairingTrust,
  };
  const encodedRepairPairingPayload = JSON.stringify(repairPairingPayload);
  if (Buffer.byteLength(encodedRepairPairingPayload, "utf8") > 4_096) {
    throw new Error("Physical-device repair pairing payload is too large.");
  }
  process.stdout.write(`${encodedRepairPairingPayload}\n`);
}

const stop = async () => {
  await new Promise((resolve) => server.close(resolve));
  if (ownsIdentityDirectory) await rm(identityDirectory, { recursive: true, force: true });
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await stop();
    process.exit(0);
  });
}
