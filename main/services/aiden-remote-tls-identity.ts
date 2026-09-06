import { execFile } from "node:child_process";
import {
  createHash,
  createPublicKey,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_OPENSSL_PATH = "/usr/bin/openssl";
const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1_000;
const CERTIFICATE_DAYS = 90;
const CA_CERTIFICATE_DAYS = 3_650;

export interface AidenRemoteTlsIdentity {
  privateKey: string;
  certificate: string;
  certificateChain: string;
  caCertificate: string;
  serverSpkiSha256: string;
  validUntil: string;
}

export interface AidenRemoteTlsIdentityOptions {
  directory: string;
  hostnames?: string[];
  now?: Date;
  renewBeforeMs?: number;
  opensslPath?: string;
}

interface IdentityPaths {
  caKey: string;
  caCertificate: string;
  serverKey: string;
  serverCertificate: string;
}

function identityPaths(directory: string): IdentityPaths {
  return {
    caKey: path.join(directory, "ca-key.pem"),
    caCertificate: path.join(directory, "ca-certificate.pem"),
    serverKey: path.join(directory, "server-key.pem"),
    serverCertificate: path.join(directory, "server-certificate.pem"),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function validatedHostnames(values: string[]): string[] {
  const result = new Set(["localhost"]);
  for (const raw of values) {
    const value = raw.trim().replace(/\.$/u, "").toLowerCase();
    if (
      value.length === 0 ||
      value.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) ||
      value.split(".").some((label) => label.length === 0 || label.length > 63)
    ) {
      continue;
    }
    result.add(value);
    if (!value.includes(".")) result.add(`${value}.local`);
  }
  return [...result];
}

function spkiDigest(value: string | Buffer): string {
  const certificate = new X509Certificate(value);
  const spki = certificate.publicKey.export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spki).digest("base64")}`;
}

export async function fetchTlsServerSpkiSha256(
  hostname: string,
  port = 443,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(hostname) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Aiden Remote TLS endpoint is invalid.");
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };
    const socket = tls.connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: true,
    });
    const timeout = setTimeout(() => {
      const timeoutError = new Error("Aiden Remote TLS endpoint timed out.");
      timeoutError.name = "AidenRemoteTlsTimeoutError";
      settle(() => reject(timeoutError));
      socket.destroy();
    }, options.timeoutMs ?? 5_000);
    socket.once("secureConnect", () => {
      clearTimeout(timeout);
      try {
        const certificate = socket.getPeerCertificate(true);
        if (!certificate.raw?.length) throw new Error("Aiden Remote TLS endpoint has no certificate.");
        settle(() => resolve(spkiDigest(certificate.raw)));
      } catch (error) {
        settle(() => reject(error));
      } finally {
        socket.end();
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      settle(() => reject(error));
    });
  });
}

function keySpkiDigest(privateKey: string): string {
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return `sha256/${createHash("sha256").update(spki).digest("base64")}`;
}

function certificateNeedsRenewal(
  certificatePem: string,
  now: Date,
  renewBeforeMs: number,
): boolean {
  const certificate = new X509Certificate(certificatePem);
  const validFrom = new Date(certificate.validFrom).getTime();
  const validTo = new Date(certificate.validTo).getTime();
  const current = now.getTime();
  return current < validFrom || validTo - current <= renewBeforeMs;
}

async function secureFile(target: string): Promise<void> {
  await fs.chmod(target, 0o600);
}

async function assertPairCompleteness(
  first: string,
  second: string,
  label: string,
): Promise<boolean> {
  const [hasFirst, hasSecond] = await Promise.all([exists(first), exists(second)]);
  if (hasFirst !== hasSecond) {
    throw new Error(`Aiden Remote ${label} identity is incomplete; refusing to rotate it implicitly.`);
  }
  return hasFirst;
}

async function createCertificateAuthority(
  paths: IdentityPaths,
  opensslPath: string,
): Promise<void> {
  await execFileAsync(opensslPath, [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", paths.caKey,
  ]);
  await secureFile(paths.caKey);
  await issueCertificateAuthorityCertificate(paths, opensslPath);
}

async function issueCertificateAuthorityCertificate(
  paths: IdentityPaths,
  opensslPath: string,
): Promise<void> {
  await execFileAsync(opensslPath, [
    "req", "-x509", "-new", "-key", paths.caKey, "-sha256",
    "-days", String(CA_CERTIFICATE_DAYS),
    "-subj", "/CN=Aiden Agent Local CA",
    "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-out", paths.caCertificate,
  ]);
  await secureFile(paths.caCertificate);
}

async function createServerKey(paths: IdentityPaths, opensslPath: string): Promise<void> {
  await execFileAsync(opensslPath, [
    "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", paths.serverKey,
  ]);
  await secureFile(paths.serverKey);
}

async function issueServerCertificate(
  directory: string,
  paths: IdentityPaths,
  opensslPath: string,
  hostnames: string[],
): Promise<void> {
  const suffix = randomBytes(12).toString("hex");
  const requestPath = path.join(directory, `.server-${suffix}.csr.pem`);
  const certificatePath = path.join(directory, `.server-${suffix}.certificate.pem`);
  const extensionsPath = path.join(directory, `.server-${suffix}.extensions.cnf`);
  const subjectAltName = [
    "IP:127.0.0.1",
    "IP:::1",
    ...hostnames.map((hostname) => `DNS:${hostname}`),
  ].join(",");
  try {
    await fs.writeFile(
      extensionsPath,
      [
        "[server_ext]",
        `subjectAltName=${subjectAltName}`,
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=serverAuth",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 },
    );
    await execFileAsync(opensslPath, [
      "req", "-new", "-key", paths.serverKey,
      "-subj", "/CN=Aiden Agent Local",
      "-out", requestPath,
    ]);
    await execFileAsync(opensslPath, [
      "x509", "-req", "-in", requestPath,
      "-CA", paths.caCertificate, "-CAkey", paths.caKey,
      "-set_serial", `0x${randomBytes(16).toString("hex")}`,
      "-days", String(CERTIFICATE_DAYS), "-sha256",
      "-extfile", extensionsPath, "-extensions", "server_ext",
      "-out", certificatePath,
    ]);
    await secureFile(certificatePath);
    await fs.rename(certificatePath, paths.serverCertificate);
    await secureFile(paths.serverCertificate);
  } finally {
    await Promise.all([
      fs.rm(requestPath, { force: true }),
      fs.rm(certificatePath, { force: true }),
      fs.rm(extensionsPath, { force: true }),
    ]);
  }
}

export async function loadOrCreateAidenRemoteTlsIdentity(
  options: AidenRemoteTlsIdentityOptions,
): Promise<AidenRemoteTlsIdentity> {
  const opensslPath = options.opensslPath ?? DEFAULT_OPENSSL_PATH;
  const now = options.now ?? new Date();
  const renewBeforeMs = options.renewBeforeMs ?? RENEW_BEFORE_MS;
  if (!path.isAbsolute(options.directory)) {
    throw new Error("Aiden Remote TLS identity directory must be absolute.");
  }
  await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
  await fs.chmod(options.directory, 0o700);
  const paths = identityPaths(options.directory);

  const hasCa = await assertPairCompleteness(
    paths.caKey,
    paths.caCertificate,
    "certificate authority",
  );
  if (!hasCa) await createCertificateAuthority(paths, opensslPath);

  const hasServer = await assertPairCompleteness(
    paths.serverKey,
    paths.serverCertificate,
    "server",
  );
  if (!hasServer) await createServerKey(paths, opensslPath);

  let [caKey, caCertificate, serverKey, existingServerCertificate] = await Promise.all([
    fs.readFile(paths.caKey, "utf8"),
    fs.readFile(paths.caCertificate, "utf8"),
    fs.readFile(paths.serverKey, "utf8"),
    hasServer ? fs.readFile(paths.serverCertificate, "utf8") : Promise.resolve(null),
  ]);
  const ca = new X509Certificate(caCertificate);
  if (!ca.ca || keySpkiDigest(caKey) !== spkiDigest(caCertificate)) {
    throw new Error("Aiden Remote certificate authority identity is invalid.");
  }
  if (certificateNeedsRenewal(caCertificate, now, renewBeforeMs)) {
    await issueCertificateAuthorityCertificate(paths, opensslPath);
    caCertificate = await fs.readFile(paths.caCertificate, "utf8");
    caKey = await fs.readFile(paths.caKey, "utf8");
  }

  let certificate = existingServerCertificate;
  if (certificate) {
    try {
      if (keySpkiDigest(serverKey) !== spkiDigest(certificate)) certificate = null;
    } catch {
      certificate = null;
    }
  }
  if (
    !certificate ||
    certificateNeedsRenewal(certificate, now, renewBeforeMs)
  ) {
    await issueServerCertificate(
      options.directory,
      paths,
      opensslPath,
      validatedHostnames(options.hostnames ?? []),
    );
    certificate = await fs.readFile(paths.serverCertificate, "utf8");
  }

  await Promise.all(Object.values(paths).map(secureFile));
  const parsedCertificate = new X509Certificate(certificate);
  return {
    privateKey: serverKey,
    certificate,
    certificateChain: `${certificate.trim()}\n${caCertificate.trim()}\n`,
    caCertificate,
    serverSpkiSha256: spkiDigest(certificate),
    validUntil: new Date(parsedCertificate.validTo).toISOString(),
  };
}
