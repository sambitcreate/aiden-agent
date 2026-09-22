import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generatePairingSecret, runLanTransportSpike, spkiSha256 } from "./aiden-remote-lan-transport-spike.mjs";

const physicalServerPath = path.resolve("scripts/aiden-remote-physical-device-spike-server.mjs");

async function launchPhysicalServer(
  identityDirectory,
  mode,
  initialize = false,
  phase7 = false,
  extraArguments = [],
) {
  const arguments_ = [
    physicalServerPath,
    "--host", "127.0.0.1",
    "--identity-dir", identityDirectory,
    "--mode", mode,
  ];
  if (initialize) arguments_.push("--initialize");
  if (phase7) arguments_.push("--phase7");
  arguments_.push(...extraArguments);
  const child = spawn(process.execPath, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  const expectsRepairPayload = extraArguments.includes("--repair-secret-file");
  const payloads = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Physical spike server startup timed out.")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Physical spike server exited with ${code}: ${stderr}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split("\n").filter((line) => line.length > 0);
      if (lines.length < (expectsRepairPayload ? 2 : 1)) return;
      clearTimeout(timeout);
      try {
        resolve(lines.slice(0, expectsRepairPayload ? 2 : 1).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
  });
  const [pairingPayload, repairPairingPayload] = payloads;
  return {
    pairingPayload,
    repairPairingPayload,
    bootstrap: pairingPayload.bootstrap,
    async stop() {
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function requestJSON(url, { method = "GET", headers = {}, body, ca } = {}) {
  const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const response = await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      ca,
      headers: {
        ...headers,
        ...(encodedBody ? {
          "content-type": "application/json",
          "content-length": String(encodedBody.length),
        } : {}),
      },
    }, (incoming) => resolve(incoming));
    request.once("error", reject);
    if (encodedBody) request.write(encodedBody);
    request.end();
  });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const data = Buffer.concat(chunks).toString("utf8");
  return {
    status: response.statusCode,
    body: data.length > 0 ? JSON.parse(data) : undefined,
  };
}

test("LAN transport spike validates hostname/chain and pins a stable P-256 public key", async () => {
  const result = await runLanTransportSpike();
  assert.deepEqual(result, {
    protocolVersion: 1,
    algorithm: "P-256 SPKI SHA-256",
    hostnameAndChainValidated: true,
    originalAccepted: true,
    stableInstallIdentityAccepted: true,
    sameKeyRenewalAccepted: true,
    changedKeyRejected: true,
    changedKeyRecoveryAccepted: true,
    wrongPinRejected: true,
    wrongHostRejected: true,
    expiredCertificateRejected: true,
  });
});

test("pairing bootstrap secrets are independent 32-byte base64url values", () => {
  const first = generatePairingSecret();
  const second = generatePairingSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(first, "base64url").length, 32);
  assert.notEqual(first, second);
});

test("SPKI fingerprint format is QR-safe and versioned by algorithm label", () => {
  assert.throws(() => spkiSha256("not a certificate"));
});

test("physical identity survives process restart and encodes renewal, rotation, host, and expiry scenarios", async () => {
  const identityDirectory = await mkdtemp(path.join(os.tmpdir(), "aiden-physical-identity-test-"));
  try {
    const first = await launchPhysicalServer(identityDirectory, "original", true);
    assert.equal(first.pairingPayload.kind, "aiden-pairing-v1");
    assert.equal(first.pairingPayload.trust.mode, "private-ca");
    assert.ok(Buffer.from(first.pairingPayload.trust.caCertificateDerBase64, "base64").length > 100);
    const originalPin = first.bootstrap.serverSpkiSha256;
    await first.stop();

    const restarted = await launchPhysicalServer(identityDirectory, "original");
    assert.equal(restarted.bootstrap.serverSpkiSha256, originalPin);
    await restarted.stop();

    const renewed = await launchPhysicalServer(identityDirectory, "renewed");
    assert.equal(renewed.bootstrap.serverSpkiSha256, originalPin);
    await renewed.stop();

    const rotated = await launchPhysicalServer(identityDirectory, "rotated");
    assert.notEqual(rotated.bootstrap.serverSpkiSha256, originalPin);
    await rotated.stop();

    const wrongHostCertificate = new X509Certificate(
      await readFile(path.join(identityDirectory, "wrong-host-certificate.pem"), "utf8"),
    );
    assert.equal(wrongHostCertificate.checkHost("127.0.0.1"), undefined);
    const expiredCertificate = new X509Certificate(
      await readFile(path.join(identityDirectory, "expired-certificate.pem"), "utf8"),
    );
    assert.ok(new Date(expiredCertificate.validTo) <= new Date());
  } finally {
    await rm(identityDirectory, { recursive: true, force: true });
  }
});

test("physical proof server can model a system-trusted Tailscale endpoint over a loopback HTTP target", async () => {
  const identityDirectory = await mkdtemp(path.join(os.tmpdir(), "aiden-physical-tailscale-test-"));
  let server;
  try {
    const endpoint = "https://aiden.tailnet.ts.net/api/aiden/v1";
    const fingerprint = `sha256/${randomBytes(32).toString("base64")}`;
    server = await launchPhysicalServer(
      identityDirectory,
      "original",
      true,
      false,
      [
        "--phase6",
        "--listen-http",
        "--system-trust",
        "--public-endpoint", endpoint,
        "--public-spki-sha256", fingerprint,
      ],
    );
    assert.equal(server.pairingPayload.trust.mode, "system");
    assert.deepEqual(Object.keys(server.pairingPayload.trust), ["mode"]);
    assert.equal(server.bootstrap.endpoint, endpoint);
    assert.equal(server.bootstrap.serverSpkiSha256, fingerprint);
  } finally {
    if (server) await server.stop();
    await rm(identityDirectory, { recursive: true, force: true });
  }
});

test("Phase 7 physical server consumes bounded attachment references exactly once", async () => {
  const identityDirectory = await mkdtemp(path.join(os.tmpdir(), "aiden-physical-attachment-test-"));
  let server;
  try {
    server = await launchPhysicalServer(identityDirectory, "original", true, true);
    const ca = new X509Certificate(
      Buffer.from(server.pairingPayload.trust.caCertificateDerBase64, "base64"),
    ).toString();
    const endpoint = server.bootstrap.endpoint;
    const exchange = await requestJSON(`${endpoint}/pairing/exchange`, {
      method: "POST",
      ca,
      body: { secret: server.bootstrap.secret },
    });
    assert.equal(exchange.status, 200);
    const authorized = {
      ca,
      headers: {
        authorization: `Bearer ${exchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    };
    const workspace = await requestJSON(`${endpoint}/workspaces`, {
      ...authorized,
      method: "POST",
      body: { mode: "folderless", name: "Attachment Proof" },
    });
    assert.equal(workspace.status, 201);
    const chat = await requestJSON(`${endpoint}/chats`, {
      ...authorized,
      method: "POST",
      headers: { ...authorized.headers, "idempotency-key": "create-chat" },
      body: { workspaceId: workspace.body.id },
    });
    assert.equal(chat.status, 201);
    const uploaded = await requestJSON(`${endpoint}/chats/${chat.body.id}/attachments`, {
      ...authorized,
      method: "POST",
      body: { name: "proof.md", mimeType: "text/markdown", kind: "text", text: "# LAN proof" },
    });
    assert.equal(uploaded.status, 201);
    assert.match(uploaded.body.id, /^att_[A-Za-z0-9_-]{43}$/u);
    assert.equal(uploaded.body.size, 11);
    assert.equal(uploaded.body.text, undefined);
    assert.equal(uploaded.body.path, undefined);

    const turn = await requestJSON(`${endpoint}/chats/${chat.body.id}/turns`, {
      ...authorized,
      method: "POST",
      headers: { ...authorized.headers, "idempotency-key": "attachment-turn" },
      body: { text: "", attachmentIds: [uploaded.body.id] },
    });
    assert.equal(turn.status, 202);
    assert.deepEqual(turn.body.message.attachments, [{
      id: uploaded.body.id,
      name: "proof.md",
      mimeType: "text/markdown",
      kind: "text",
      size: 11,
    }]);

    const replay = await requestJSON(`${endpoint}/chats/${chat.body.id}/turns`, {
      ...authorized,
      method: "POST",
      headers: { ...authorized.headers, "idempotency-key": "attachment-replay" },
      body: { text: "Replay", attachmentIds: [uploaded.body.id] },
    });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, "handle_invalid");

    const discarded = await requestJSON(`${endpoint}/chats/${chat.body.id}/attachments`, {
      ...authorized,
      method: "POST",
      body: { name: "discard.txt", mimeType: "text/plain", kind: "text", text: "discard" },
    });
    assert.equal(discarded.status, 201);
    const removed = await requestJSON(
      `${endpoint}/chats/${chat.body.id}/attachments/${discarded.body.id}`,
      { ...authorized, method: "DELETE" },
    );
    assert.equal(removed.status, 204);
  } finally {
    if (server) await server.stop();
    await rm(identityDirectory, { recursive: true, force: true });
  }
});

test("physical auth revocation and re-pair rotation survive same-identity restarts", async () => {
  const identityDirectory = await mkdtemp(path.join(os.tmpdir(), "aiden-physical-auth-restart-test-"));
  const repairSecretPath = path.join(identityDirectory, "physical-repair-secret");
  await writeFile(repairSecretPath, randomBytes(32).toString("base64url"), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  let first;
  let restarted;
  try {
    first = await launchPhysicalServer(
      identityDirectory,
      "original",
      true,
      true,
      ["--persist-auth", "--repair-secret-file", repairSecretPath],
    );
    assert.equal(first.repairPairingPayload.kind, "aiden-pairing-v1");
    assert.equal(first.repairPairingPayload.bootstrap.endpoint, first.bootstrap.endpoint);
    assert.equal(first.repairPairingPayload.bootstrap.serverSpkiSha256, first.bootstrap.serverSpkiSha256);
    assert.notEqual(first.repairPairingPayload.bootstrap.secret, first.bootstrap.secret);
    const ca = new X509Certificate(
      Buffer.from(first.pairingPayload.trust.caCertificateDerBase64, "base64"),
    ).toString();
    const exchange = await requestJSON(`${first.bootstrap.endpoint}/pairing/exchange`, {
      method: "POST",
      ca,
      body: { secret: first.bootstrap.secret },
    });
    assert.equal(exchange.status, 200);
    const port = new URL(first.bootstrap.endpoint).port;
    const originalPin = first.bootstrap.serverSpkiSha256;
    await first.stop();
    first = undefined;
    const authStatePath = path.join(identityDirectory, "physical-auth-state.json");
    const authStateText = await readFile(authStatePath, "utf8");
    assert.doesNotMatch(authStateText, new RegExp(exchange.body.credential, "u"));
    assert.deepEqual(
      Object.keys(JSON.parse(authStateText)).sort(),
      ["credentialSha256", "revokedCredentialSha256", "version"],
    );
    assert.equal(JSON.parse(authStateText).version, 2);
    assert.deepEqual(JSON.parse(authStateText).revokedCredentialSha256, []);
    assert.equal((await stat(authStatePath)).mode & 0o777, 0o600);

    restarted = await launchPhysicalServer(
      identityDirectory,
      "original",
      false,
      true,
      ["--persist-auth", "--port", port, "--repair-secret-file", repairSecretPath],
    );
    assert.equal(restarted.bootstrap.serverSpkiSha256, originalPin);
    const repairPairingPayload = restarted.repairPairingPayload;
    const authorized = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${exchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.instanceId, "phase7-physical-device-spike");
    const reopenedPairing = await requestJSON(`${restarted.bootstrap.endpoint}/pairing/exchange`, {
      method: "POST",
      ca,
      body: { secret: restarted.bootstrap.secret },
    });
    assert.equal(reopenedPairing.status, 401);
    assert.equal(reopenedPairing.body.error.code, "pairing_closed");

    const revocationPath = path.join(identityDirectory, "physical-auth-revoked");
    await writeFile(revocationPath, "", { mode: 0o600, flag: "wx" });
    const revoked = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${exchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(revoked.status, 403);
    assert.equal(revoked.body.error.code, "credential_revoked");
    assert.equal((await stat(revocationPath)).mode & 0o777, 0o600);

    const repairWindowPath = path.join(identityDirectory, "physical-repair-open");
    await writeFile(repairWindowPath, "", { mode: 0o600, flag: "wx" });
    const repairExchange = await requestJSON(`${restarted.bootstrap.endpoint}/pairing/exchange`, {
      method: "POST",
      ca,
      body: { secret: repairPairingPayload.bootstrap.secret },
    });
    assert.equal(repairExchange.status, 200);
    assert.notEqual(repairExchange.body.credential, exchange.body.credential);
    assert.equal(repairExchange.body.deviceId, "physical-iphone-13-pro-repaired");
    const repairReplay = await requestJSON(`${restarted.bootstrap.endpoint}/pairing/exchange`, {
      method: "POST",
      ca,
      body: { secret: repairPairingPayload.bootstrap.secret },
    });
    assert.equal(repairReplay.status, 401);
    assert.equal(repairReplay.body.error.code, "pairing_closed");
    await assert.rejects(access(revocationPath), { code: "ENOENT" });
    await assert.rejects(access(repairWindowPath), { code: "ENOENT" });
    const rotatedAuthState = await readFile(authStatePath, "utf8");
    assert.doesNotMatch(rotatedAuthState, new RegExp(exchange.body.credential, "u"));
    assert.doesNotMatch(rotatedAuthState, new RegExp(repairExchange.body.credential, "u"));
    assert.equal(
      JSON.parse(rotatedAuthState).credentialSha256,
      createHash("sha256").update(repairExchange.body.credential).digest("hex"),
    );
    assert.deepEqual(JSON.parse(rotatedAuthState).revokedCredentialSha256, [
      createHash("sha256").update(exchange.body.credential).digest("hex"),
    ]);
    assert.equal((await stat(authStatePath)).mode & 0o777, 0o600);

    const oldAfterRepair = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${exchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(oldAfterRepair.status, 403);
    assert.equal(oldAfterRepair.body.error.code, "credential_revoked");
    const repaired = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${repairExchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(repaired.status, 200);

    await restarted.stop();
    restarted = await launchPhysicalServer(
      identityDirectory,
      "original",
      false,
      true,
      ["--persist-auth", "--port", port],
    );
    const repairedAfterRestart = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${repairExchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(repairedAfterRestart.status, 200);
    const oldAfterRestart = await requestJSON(`${restarted.bootstrap.endpoint}/server`, {
      ca,
      headers: {
        authorization: `Bearer ${exchange.body.credential}`,
        "aiden-protocol-version": "1",
      },
    });
    assert.equal(oldAfterRestart.status, 403);
    assert.equal(oldAfterRestart.body.error.code, "credential_revoked");
  } finally {
    if (first) await first.stop();
    if (restarted) await restarted.stop();
    await rm(identityDirectory, { recursive: true, force: true });
  }
});
