import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadOrCreateAidenRemoteTlsIdentity, classifyAidenRemoteTlsEndpointFailure, AidenRemoteTlsEndpointError, fetchTlsServerSpkiSha256 } from "./aiden-remote-tls-identity.js";

async function temporaryDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "aiden-remote-tls-"));
}

test("TLS identity persists one P-256 server key and renews without changing its pin", async () => {
  const directory = await temporaryDirectory();
  try {
    const first = await loadOrCreateAidenRemoteTlsIdentity({
      directory,
      hostnames: ["Aiden-Studio"],
    });
    const restarted = await loadOrCreateAidenRemoteTlsIdentity({ directory });
    const renewed = await loadOrCreateAidenRemoteTlsIdentity({
      directory,
      renewBeforeMs: 20 * 365 * 24 * 60 * 60 * 1_000,
    });

    assert.equal(restarted.serverSpkiSha256, first.serverSpkiSha256);
    assert.equal(renewed.serverSpkiSha256, first.serverSpkiSha256);
    assert.equal(renewed.privateKey, first.privateKey);
    const certificate = new X509Certificate(first.certificate);
    assert.equal(certificate.checkHost("aiden-studio"), "aiden-studio");
    assert.equal(certificate.checkHost("aiden-studio.local"), "aiden-studio.local");
    assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
    assert.equal(certificate.publicKey.asymmetricKeyType, "ec");
    assert.match(first.serverSpkiSha256, /^sha256\/[A-Za-z0-9+/]{43}=$/u);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("TLS identity directory and every persisted identity file are owner-only", async () => {
  const directory = await temporaryDirectory();
  try {
    await loadOrCreateAidenRemoteTlsIdentity({ directory });
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    for (const name of [
      "ca-key.pem",
      "ca-certificate.pem",
      "server-key.pem",
      "server-certificate.pem",
    ]) {
      assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("TLS identity fails closed instead of silently rotating an incomplete identity", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, "server-key.pem"), "partial", { mode: 0o600 });
    await assert.rejects(
      loadOrCreateAidenRemoteTlsIdentity({ directory }),
      /server identity is incomplete/u,
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("TLS endpoint probe failures classify into stable pairing codes", () => {
  const timedOut = classifyAidenRemoteTlsEndpointFailure(
    new Error("Aiden Remote TLS endpoint timed out."),
  );
  assert.equal(timedOut.code, "timed_out");
  assert.match(timedOut.message, /did not respond/u);

  const refused = classifyAidenRemoteTlsEndpointFailure(
    Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" }),
  );
  assert.equal(refused.code, "unreachable");

  const untrusted = classifyAidenRemoteTlsEndpointFailure(
    Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
  );
  assert.equal(untrusted.code, "untrusted");

  const invalid = classifyAidenRemoteTlsEndpointFailure(
    new Error("Aiden Remote TLS endpoint is invalid."),
  );
  assert.equal(invalid.code, "invalid_endpoint");

  const already = new AidenRemoteTlsEndpointError("timed_out", "kept");
  assert.equal(classifyAidenRemoteTlsEndpointFailure(already), already);
});

test("invalid TLS endpoints fail closed without opening a socket", async () => {
  await assert.rejects(
    fetchTlsServerSpkiSha256("not a host"),
    (error: unknown) => error instanceof AidenRemoteTlsEndpointError && error.code === "invalid_endpoint",
  );
  await assert.rejects(
    fetchTlsServerSpkiSha256("aiden.tailnet.ts.net", 0),
    (error: unknown) => error instanceof AidenRemoteTlsEndpointError && error.code === "invalid_endpoint",
  );
});
