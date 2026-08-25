import { execFile } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function spkiSha256(certificatePem) {
  const certificate = new X509Certificate(certificatePem);
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spki).digest("base64")}`;
}

export function generatePairingSecret() {
  return randomBytes(32).toString("base64url");
}

export function assertCertificateCurrentlyValid(certificatePem, now = new Date()) {
  const certificate = new X509Certificate(certificatePem);
  if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo)) {
    throw new Error("Aiden server certificate is outside its validity window.");
  }
}

async function createCertificateAuthority(directory) {
  const keyPath = path.join(directory, "ca.key.pem");
  const certificatePath = path.join(directory, "ca.certificate.pem");
  await execFileAsync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  await execFileAsync("openssl", ["req", "-x509", "-new", "-key", keyPath, "-sha256", "-days", "3650", "-subj", "/CN=Aiden Phase 0 Local CA", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", certificatePath]);
  return { keyPath, certificatePath, certificate: await readFile(certificatePath, "utf8") };
}

async function issueCertificate(directory, name, certificateAuthority, keyPath) {
  const resolvedKeyPath = keyPath ?? path.join(directory, `${name}.key.pem`);
  const certificatePath = path.join(directory, `${name}.certificate.pem`);
  const requestPath = path.join(directory, `${name}.request.pem`);
  const argumentsBeforeKey = keyPath
    ? []
    : ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", resolvedKeyPath];
  if (argumentsBeforeKey.length > 0) await execFileAsync("openssl", argumentsBeforeKey);
  await execFileAsync("openssl", [
    "req",
    "-new",
    "-key",
    resolvedKeyPath,
    "-subj",
    `/CN=127.0.0.1/O=Aiden Phase 0/OU=${name}`,
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-addext",
    "keyUsage=critical,digitalSignature",
    "-addext",
    "extendedKeyUsage=serverAuth",
    "-out", requestPath,
  ]);
  await execFileAsync("openssl", ["x509", "-req", "-in", requestPath, "-CA", certificateAuthority.certificatePath, "-CAkey", certificateAuthority.keyPath, "-CAcreateserial", "-days", "30", "-sha256", "-copy_extensions", "copy", "-out", certificatePath]);
  const [privateKey, certificate] = await Promise.all([
    readFile(resolvedKeyPath, "utf8"),
    readFile(certificatePath, "utf8"),
  ]);
  return {
    keyPath: resolvedKeyPath,
    privateKey,
    certificate,
    caCertificate: certificateAuthority.certificate,
    certificateChain: `${certificate}\n${certificateAuthority.certificate}`,
    fingerprint: spkiSha256(certificate),
  };
}

async function loadIssuedIdentity(directory, name, certificateAuthority, keyPath) {
  const [privateKey, certificate] = await Promise.all([
    readFile(keyPath, "utf8"),
    readFile(path.join(directory, `${name}.certificate.pem`), "utf8"),
  ]);
  return {
    keyPath,
    privateKey,
    certificate,
    caCertificate: certificateAuthority.certificate,
    certificateChain: `${certificate}\n${certificateAuthority.certificate}`,
    fingerprint: spkiSha256(certificate),
  };
}

async function withHttpsServer(identity, body, action) {
  const server = https.createServer(
    { key: identity.privateKey, cert: identity.certificateChain },
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTPS spike did not bind TCP.");
  try {
    return await action(`https://127.0.0.1:${address.port}/health`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

export async function pinnedJsonRequest(url, certificatePem, caCertificatePem, expectedFingerprint, options = {}) {
  assertCertificateCurrentlyValid(certificatePem, options.now);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        ca: caCertificatePem,
        rejectUnauthorized: true,
        checkServerIdentity(hostname, certificate) {
          const standardError = tls.checkServerIdentity(hostname, certificate);
          if (standardError) return standardError;
          const actual = spkiSha256(certificate.raw);
          if (actual === expectedFingerprint) return undefined;
          const error = new Error("Aiden server public-key fingerprint changed; re-pairing is required.");
          error.code = "ERR_AIDEN_PIN_MISMATCH";
          return error;
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTPS spike returned ${response.statusCode}.`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(5_000, () => request.destroy(new Error("HTTPS spike timed out.")));
  });
}

async function rejected(request) {
  try {
    await request();
    return false;
  } catch {
    return true;
  }
}

export async function runLanTransportSpike() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "aiden-lan-transport-spike-"));
  try {
    const certificateAuthority = await createCertificateAuthority(directory);
    const original = await issueCertificate(directory, "original", certificateAuthority);
    const renewed = await issueCertificate(directory, "renewed", certificateAuthority, original.keyPath);
    const rotated = await issueCertificate(directory, "rotated", certificateAuthority);
    // Reload from persisted key/certificate files rather than retaining the issued object.
    // The companion process-spawn test proves this same identity survives a real process boundary.
    const restarted = await loadIssuedIdentity(
      directory,
      "original",
      certificateAuthority,
      original.keyPath,
    );

    const originalResponse = await withHttpsServer(original, { ok: true, identity: "original" }, (url) =>
      pinnedJsonRequest(url, original.certificate, original.caCertificate, original.fingerprint),
    );
    const renewedResponse = await withHttpsServer(renewed, { ok: true, identity: "renewed" }, (url) =>
      pinnedJsonRequest(url, renewed.certificate, renewed.caCertificate, original.fingerprint),
    );
    const restartedResponse = await withHttpsServer(restarted, { ok: true, identity: "restart" }, (url) =>
      pinnedJsonRequest(url, restarted.certificate, restarted.caCertificate, original.fingerprint),
    );
    const wrongPinRejected = await withHttpsServer(original, { ok: true }, (url) =>
      rejected(() => pinnedJsonRequest(url, original.certificate, original.caCertificate, rotated.fingerprint)),
    );
    const rotatedKeyRejected = await withHttpsServer(rotated, { ok: true }, (url) =>
      rejected(() => pinnedJsonRequest(url, rotated.certificate, rotated.caCertificate, original.fingerprint)),
    );
    const repairedResponse = await withHttpsServer(rotated, { ok: true, identity: "repaired" }, (url) =>
      pinnedJsonRequest(url, rotated.certificate, rotated.caCertificate, rotated.fingerprint),
    );
    const wrongHostRejected = await withHttpsServer(original, { ok: true }, (url) =>
      rejected(() => pinnedJsonRequest(url.replace("127.0.0.1", "localhost"), original.certificate, original.caCertificate, original.fingerprint)),
    );
    const expiredCertificateRejected = await withHttpsServer(original, { ok: true }, (url) =>
      rejected(() => pinnedJsonRequest(url, original.certificate, original.caCertificate, original.fingerprint, { now: new Date("2100-01-01T00:00:00Z") })),
    );

    return {
      protocolVersion: 1,
      algorithm: "P-256 SPKI SHA-256",
      hostnameAndChainValidated: true,
      originalAccepted: originalResponse.ok === true,
      stableInstallIdentityAccepted:
        restartedResponse.ok === true && restarted.fingerprint === original.fingerprint,
      sameKeyRenewalAccepted:
        renewedResponse.ok === true && renewed.fingerprint === original.fingerprint,
      changedKeyRejected: rotatedKeyRejected && rotated.fingerprint !== original.fingerprint,
      changedKeyRecoveryAccepted: repairedResponse.ok === true,
      wrongPinRejected,
      wrongHostRejected,
      expiredCertificateRejected,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const result = await runLanTransportSpike();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!Object.values(result).every((value) => value === true || typeof value === "string" || value === 1)) {
    process.exitCode = 1;
  }
}
