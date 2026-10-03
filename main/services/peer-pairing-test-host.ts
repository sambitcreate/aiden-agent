/**
 * Test support: a real Aiden host over HTTPS, running PR 4a's router and
 * pairing services in-process. It is imported by tests only.
 *
 * - The LAN listener serves `/api/aiden/v1` with a private CA, as a desktop
 *   host does on its LAN port.
 * - The "Tailscale" listener accepts the stripped base path and announces
 *   system trust for `https://localhost:<port>/api/aiden/v1`. Tests trust the
 *   fixture CA in place of the system roots.
 */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { AidenRemotePairingService } from "./aiden-remote-pairing.js";
import { AidenRemotePairingRequestService } from "./aiden-remote-pairing-requests.js";
import { createAidenRemoteRequestHandler } from "./aiden-remote-router.js";
import {
  AidenRemoteStateRegistry,
  createDefaultAidenRemoteState,
  type AidenRemoteStateDocument,
} from "./aiden-remote-state.js";
import {
  loadOrCreateAidenRemoteTlsIdentity,
  type AidenRemoteTlsIdentity,
} from "./aiden-remote-tls-identity.js";

export interface PeerTestHost {
  instanceId: string;
  /** The fixture CA, as PEM, for clients that must trust it. */
  caPem: string;
  caDerBase64: string;
  serverSpkiSha256(): string;
  lanEndpoint: string;
  tailscaleEndpoint: string;
  requests: AidenRemotePairingRequestService;
  pairing: AidenRemotePairingService;
  devices: AidenRemoteStateRegistry;
  /** Paths each listener served, in order. */
  seen: string[];
  /** Each request line as received, query included, with its headers. */
  received: { line: string; headers: IncomingHttpHeaders }[];
  setAccepting(value: boolean): void;
  /** Open a setup-code window for one route and return its code. */
  openSetupCode(route: "lan" | "tailscale"): string;
  /** Serve a new leaf key signed by the same CA, as after a renewal. */
  rotateLeaf(): Promise<void>;
  /** Serve an unrelated identity from a different CA. */
  impersonate(): Promise<void>;
  close(): Promise<void>;
}

async function identityIn(
  directory: string,
  from?: string,
): Promise<AidenRemoteTlsIdentity> {
  if (from) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of ["ca-key.pem", "ca-certificate.pem"])
      await copyFile(path.join(from, name), path.join(directory, name));
  }
  return loadOrCreateAidenRemoteTlsIdentity({ directory });
}

export async function startPeerTestHost(
  options: { displayName?: string; pollTimeoutMs?: number } = {},
): Promise<PeerTestHost> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiden-peer-host-"));
  const firstDirectory = path.join(root, "a");
  let identity = await identityIn(firstDirectory);
  const caDerBase64 = new X509Certificate(identity.caCertificate).raw.toString(
    "base64",
  );
  let stored: AidenRemoteStateDocument = createDefaultAidenRemoteState(() =>
    randomBytes(24),
  );
  const devices = new AidenRemoteStateRegistry(
    {
      load: async () => structuredClone(stored),
      save: async (document) => {
        stored = structuredClone(document);
      },
    },
    {
      now: Date.now,
      randomBytes,
      deriveCredentialDigest: async (credential, salt) =>
        createHash("sha256").update(credential).update(salt).digest(),
    },
  );
  const instanceId = stored.instanceId;
  const displayName = () => options.displayName ?? "Studio Mac";
  let accepting = true;
  let lanEndpoint = "";
  let tailscaleEndpoint = "";
  const requests = new AidenRemotePairingRequestService({
    instanceId,
    devices,
    accepting: () => accepting,
    resolveTransport: async (transport) =>
      transport === "lan"
        ? {
            endpoint: lanEndpoint,
            serverSpkiSha256: identity.serverSpkiSha256,
            trust: { mode: "private-ca", caCertificateDerBase64: caDerBase64 },
          }
        : {
            endpoint: tailscaleEndpoint,
            serverSpkiSha256: identity.serverSpkiSha256,
            trust: { mode: "system" },
          },
    displayName,
    botCapabilitiesSupported: () => true,
    hostCapabilitiesSupported: () => true,
    ...(options.pollTimeoutMs ? { pollTimeoutMs: options.pollTimeoutMs } : {}),
  });
  const pairing = new AidenRemotePairingService(
    instanceId,
    devices,
    undefined,
    undefined,
    displayName,
    () => true,
    () => true,
  );
  const seen: string[] = [];
  const received: PeerTestHost["received"] = [];
  const handler = (acceptStrippedBasePath: boolean) => {
    const route = createAidenRemoteRequestHandler({
      instanceId,
      displayName,
      appVersion: "0.60.0",
      devices,
      pairing,
      pairingRequests: requests,
      platform: "mac",
      connectionMode: () => "both",
      now: Date.now,
      acceptStrippedBasePath,
      log: () => undefined,
    });
    return (request: Parameters<typeof route>[0], response: Parameters<typeof route>[1]) => {
      seen.push(`${request.method} ${request.url?.split("?")[0]}`);
      received.push({ line: `${request.method} ${request.url}`, headers: { ...request.headers } });
      void route(request, response);
    };
  };
  const listen = async (server: https.Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("The test host did not bind.");
    return address.port;
  };
  const tlsOptions = () => ({
    key: identity.privateKey,
    cert: identity.certificateChain,
  });
  const lan = https.createServer(tlsOptions(), handler(false));
  const tailscale = https.createServer(tlsOptions(), handler(true));
  lanEndpoint = `https://127.0.0.1:${await listen(lan)}/api/aiden/v1`;
  tailscaleEndpoint = `https://localhost:${await listen(tailscale)}/api/aiden/v1`;
  let rotations = 0;
  const serve = (next: AidenRemoteTlsIdentity) => {
    identity = next;
    for (const server of [lan, tailscale]) {
      server.setSecureContext(tlsOptions());
      server.closeAllConnections();
    }
  };
  return {
    instanceId,
    caPem: identity.caCertificate,
    caDerBase64,
    serverSpkiSha256: () => identity.serverSpkiSha256,
    lanEndpoint,
    tailscaleEndpoint,
    requests,
    pairing,
    devices,
    seen,
    received,
    setAccepting: (value) => {
      accepting = value;
    },
    openSetupCode: (route) => {
      const endpoint = route === "lan" ? lanEndpoint : tailscaleEndpoint;
      const window = pairing.begin(endpoint, identity.serverSpkiSha256);
      pairing.sealManualPayload(
        window.sessionId,
        JSON.stringify({
          kind: "aiden-pairing-v1",
          bootstrap: window.bootstrap,
          trust:
            route === "lan"
              ? { mode: "private-ca", caCertificateDerBase64: caDerBase64 }
              : { mode: "system" },
        }),
      );
      return window.manualCode;
    },
    rotateLeaf: async () => {
      serve(await identityIn(path.join(root, `leaf-${++rotations}`), firstDirectory));
    },
    impersonate: async () => {
      serve(await identityIn(path.join(root, `other-${++rotations}`)));
    },
    close: async () => {
      await requests.close();
      for (const server of [lan, tailscale]) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}
