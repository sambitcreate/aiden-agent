// The real MCP OAuth provider and attended sign-in against a fake OAuth + MCP
// server on 127.0.0.1. The fake server's observed requests and its accept or
// reject verdicts are the oracle; the store is in memory but goes through the
// same JSON + parse round trip as the encrypted store, so a new provider
// reading it sees what Aiden sees after a restart.

import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { authorizeMcp } from "@earendil-works/pi-mcp/oauth";
import { isBotConnectionReady } from "./bot-runtime-tools/suggest-connection.js";
import { createMcpClient, connectMcpClient } from "./mcp-client.js";
import { McpOAuthOperationGate } from "./mcp-oauth-operation.js";
import {
  authorizeMcpServerWithRuntime,
  createBackgroundMcpOAuthProvider,
  makeMcpOAuthTransport,
  McpOAuthRefreshUnavailableError,
  McpOAuthSignInRequiredError,
  readMcpOAuthSignInState,
  type McpOAuthRuntime,
} from "./mcp-oauth-provider-core.js";
import { mcpOAuthBindingForServer } from "./mcp-oauth-identity.js";
import { mcpScopeTokens, parseMcpOAuthSession, type McpOAuthSession } from "./mcp-oauth-session.js";
import { startFakeOAuthServer, type FakeOAuthServer, type FakeOAuthServerOptions } from "./mcp-oauth-test-server.js";
import { getMcpPreset, serverFromPreset } from "./mcp-presets.js";
import { McpLiveStatusRegistry } from "./mcp-status-events.js";
import type { McpServer } from "./types.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * `atomic` adds the locked read-modify-write the CLI's shared store offers
 * (`McpOAuthSessionStore.update`); without it saves read, then write.
 */
function memoryStore(atomic = false) {
  const entries = new Map<string, string>();
  const store = {
    entries,
    async get(serverId: string): Promise<McpOAuthSession> {
      return parseMcpOAuthSession(JSON.parse(entries.get(serverId) ?? "{}"));
    },
    async set(serverId: string, session: McpOAuthSession, isCurrent: () => boolean = () => true): Promise<void> {
      if (!isCurrent()) throw new Error("MCP OAuth credentials changed while this operation was in progress.");
      entries.set(serverId, JSON.stringify(session));
    },
    async clear(serverId: string): Promise<void> {
      entries.delete(serverId);
    },
  };
  if (!atomic) return store;
  return {
    ...store,
    async update(serverId: string, mutate: (current: McpOAuthSession) => McpOAuthSession | undefined, isCurrent: () => boolean = () => true): Promise<void> {
      if (!isCurrent()) throw new Error("MCP OAuth credentials changed while this operation was in progress.");
      // Read, decide and write with no await in between: nothing interleaves.
      const next = mutate(parseMcpOAuthSession(JSON.parse(entries.get(serverId) ?? "{}")));
      if (next) entries.set(serverId, JSON.stringify(next));
    },
  };
}

async function setup(
  t: test.TestContext,
  options: FakeOAuthServerOptions = {},
  extra: { server?: Partial<McpServer>; clientMetadataUrl?: string; atomicStore?: boolean } = {},
) {
  const fake = await startFakeOAuthServer(options);
  t.after(() => fake.close());
  const store = memoryStore(extra.atomicStore);
  const status = new McpLiveStatusRegistry();
  const opened: URL[] = [];
  const pages: Promise<string>[] = [];
  const runtime: McpOAuthRuntime = {
    store,
    gate: new McpOAuthOperationGate(),
    status,
    // The browser: follow the consent page back to Aiden's loopback and keep
    // the page Aiden answers with. Never awaited by the flow.
    openBrowser: async (url) => {
      opened.push(new URL(url));
      const page = (async () => {
        const consent = await fetch(url, { redirect: "manual" });
        const location = consent.headers.get("location");
        if (!location) return `consent page ${consent.status}`;
        return (await fetch(location)).text();
      })();
      page.catch(() => undefined);
      pages.push(page);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    clientVersion: "0.0.0-test",
    // Port 0: the loopback binds a free port and names it in its redirect URI.
    loopback: { port: 0, redirectUri: "http://127.0.0.1:0/callback", timeoutMs: 10_000 },
    ...(extra.clientMetadataUrl ? { clientMetadataUrl: extra.clientMetadataUrl } : {}),
    publish: (_serverId, operation) => operation(),
  };
  const server: McpServer = {
    id: "custom-fake",
    name: "Fake",
    transport: "http",
    url: fake.serviceUrl,
    oauth: true,
    enabled: true,
    ...extra.server,
  };
  return {
    fake,
    store,
    status,
    runtime,
    server,
    opened,
    pages,
    authorize: (target: McpServer = server) => authorizeMcpServerWithRuntime(runtime, target),
    /** A chat-turn style connection: stored tokens only. */
    backgroundConnect: async (target: McpServer = server) => {
      const client = createMcpClient("background-test", "1");
      try {
        await connectMcpClient(client, makeMcpOAuthTransport(target, createBackgroundMcpOAuthProvider(runtime, target)), { timeoutMs: 10_000 });
        return await client.listTools();
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    session: () => store.get(server.id),
    signInState: (target: McpServer = server) => readMcpOAuthSignInState(store, server.id, target),
  };
}

function registrationAndTokenTraffic(fake: FakeOAuthServer) {
  return { registrations: fake.seen.registrations.length, tokenRequests: fake.seen.tokenRequests.length, authorizations: fake.seen.authorizations.length };
}

test("a confidential-only server completes sign-in with the issued secret and refreshes after a restart", async (t) => {
  const h = await setup(t, { issueSecret: true, requireSecret: true, authMethods: ["client_secret_basic", "client_secret_post"] });
  assert.deepEqual(await h.authorize(), { authorized: true });
  assert.match(await h.pages[0], /Connected/u);
  const exchange = h.fake.seen.tokenRequests.find((request) => request.grant === "authorization_code")!;
  assert.equal(exchange.status, 200);
  assert.equal(exchange.presentedSecret, true);
  assert.equal(exchange.authMethod, "basic");
  const stored = await h.session();
  assert.equal(stored.clientInformation?.client_secret, "secret-1");
  assert.ok(stored.tokens?.refresh_token);

  // Restart: the access token expired; a background provider refreshes with the stored secret.
  h.fake.expireAccessTokens();
  assert.equal((await h.backgroundConnect()).length, 1);
  const refresh = h.fake.seen.tokenRequests.filter((request) => request.grant === "refresh_token");
  assert.deepEqual(refresh.map((request) => [request.status, request.presentedSecret]), [[200, true]]);
  assert.equal(h.fake.seen.registrations.length, 1, "the stored registration is reused");
  assert.notEqual((await h.session()).tokens?.access_token, stored.tokens?.access_token);
});

test("a public-only server registers a native Aiden Agent client and exchanges without a secret", async (t) => {
  const h = await setup(t, { authMethods: ["none"] });
  await h.authorize();
  const [registration] = h.fake.seen.registrations;
  assert.equal(registration.client_name, "Aiden Agent");
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.equal(registration.application_type, "native");
  assert.match(String((registration.redirect_uris as string[])[0]), /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
  assert.equal(h.fake.seen.authorizations[0].searchParams.get("redirect_uri"), (registration.redirect_uris as string[])[0]);
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => [request.grant, request.authMethod, request.status]), [["authorization_code", "none", 200]]);
  assert.equal((await h.signInState()).authorized, true);
});

test("a server that supports client metadata documents gets Aiden's document URL instead of a registration", async (t) => {
  const documentUrl = "https://aiden.example/mcp/client-metadata.json";
  const h = await setup(t, { cimdClientId: documentUrl }, { clientMetadataUrl: documentUrl });
  await h.authorize();
  assert.equal(h.fake.seen.registrations.length, 0);
  assert.equal(h.fake.seen.authorizations[0].searchParams.get("client_id"), documentUrl);
  assert.equal(h.fake.seen.tokenRequests[0].clientId, documentUrl);
  const stored = await h.session();
  assert.ok(stored.tokens);
  // Background refresh identifies with the same document, still without registering.
  h.fake.expireAccessTokens();
  await h.backgroundConnect();
  assert.equal(h.fake.seen.registrations.length, 0);
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => [request.grant, request.clientId, request.status]).slice(-1)[0], ["refresh_token", documentUrl, 200]);
});

test("without document support the same configuration falls back to dynamic registration", async (t) => {
  const h = await setup(t, {}, { clientMetadataUrl: "https://aiden.example/mcp/client-metadata.json" });
  await h.authorize();
  assert.equal(h.fake.seen.registrations.length, 1);
  assert.equal(h.fake.seen.authorizations[0].searchParams.get("client_id"), "client-1");
});

test("a stale client_id sends the background connection to sign-in, and Authorize registers and stores a new client", async (t) => {
  const h = await setup(t);
  await h.authorize();
  h.fake.forgetClients();
  h.fake.expireAccessTokens();
  const before = registrationAndTokenTraffic(h.fake);
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  const refresh = h.fake.seen.tokenRequests.slice(-1)[0]!;
  assert.deepEqual([refresh.grant, refresh.error], ["refresh_token", "invalid_client"]);
  assert.equal(h.fake.seen.registrations.length, before.registrations, "a background connection never registers");
  assert.equal(h.fake.seen.authorizations.length, before.authorizations);
  assert.equal(h.status.needsSignIn(h.server.id), true);
  const after = await h.signInState();
  assert.deepEqual([after.authorized, after.needsSignIn, after.hasSession], [false, true, true], "needs sign-in is read from the store, so it survives a restart");

  await h.authorize();
  assert.equal(h.fake.seen.registrations.length, 2);
  assert.equal(h.fake.seen.authorizations.slice(-1)[0]!.searchParams.get("client_id"), "client-2");
  assert.equal((await h.session()).clientInformation?.client_id, "client-2");
  assert.deepEqual(await h.signInState(), { authorized: true, needsSignIn: false, hasSession: true });
  assert.equal(h.status.needsSignIn(h.server.id), false);
});

test("protected-resource metadata follows a same-origin redirect without the server's credentials", async (t) => {
  const h = await setup(t, { metadataRedirect: "same-origin" }, { server: { headers: { "x-api-key": "service-secret" } } });
  await h.authorize();
  const [original] = h.fake.requestsTo(/^\/\.well-known\/oauth-protected-resource/u);
  const [moved] = h.fake.requestsTo("/moved/oauth-protected-resource");
  assert.equal(original.headers["x-api-key"], "service-secret", "the configured header goes to the service origin");
  assert.ok(moved, "the redirect was followed");
  assert.equal(moved.headers["x-api-key"], undefined, "a redirect hop never carries configured headers");
  assert.equal(moved.headers.authorization, undefined);
  assert.ok((await h.session()).tokens);
});

test("a cross-origin protected-resource redirect is a discovery miss, so discovery falls back to the server's origin", async (t) => {
  const h = await setup(t, { metadataRedirect: "cross-origin" });
  await h.authorize();
  assert.equal(h.fake.requestsTo("/moved/oauth-protected-resource").length, 0, "the other origin is never asked");
  assert.ok(h.fake.requestsTo(/^\/\.well-known\/oauth-authorization-server/u).length > 0, "the server origin's metadata was used");
  assert.ok((await h.session()).tokens);
});

test("an unreachable authorization server is reported by host and cause", async (t) => {
  const h = await setup(t);
  const closedPort = await freePort();
  const server = { ...h.server, url: `http://127.0.0.1:${closedPort}/mcp` };
  await assert.rejects(h.authorize(server), new RegExp(`Could not reach 127\\.0\\.0\\.1:${closedPort}: ECONNREFUSED`, "u"));
});

test("a denied consent shows the provider's reason in Aiden and on a failure page, and stores nothing", async (t) => {
  const h = await setup(t, { denyAuthorization: { error: "access_denied", description: "The workspace admin blocked this app.\u0007" } });
  await assert.rejects(h.authorize(), (error: Error) => {
    assert.match(error.message, /denied/u);
    assert.match(error.message, /The workspace admin blocked this app\./u);
    return true;
  });
  const page = await h.pages[0];
  assert.match(page, /Sign-in failed/u);
  assert.doesNotMatch(page, /Connected/u);
  assert.match(page, /workspace admin blocked this app/u);
  assert.equal(h.fake.seen.tokenRequests.length, 0);
  assert.equal(h.store.entries.size, 0);
});

test("a failed code exchange answers the browser with a failure page, not Connected", async (t) => {
  // The token endpoint wants a secret this public registration never received.
  const h = await setup(t, { requireSecret: true });
  await assert.rejects(h.authorize(), /Client ID and client secret are required/u);
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => [request.grant, request.status]), [["authorization_code", 401]]);
  const page = await h.pages[0];
  assert.match(page, /Sign-in failed/u);
  assert.doesNotMatch(page, /Connected/u);
  assert.equal(h.store.entries.size, 0);
});

test("a 5xx refresh keeps the stored sign-in and reports a transient connection failure", async (t) => {
  const h = await setup(t);
  await h.authorize();
  const signedIn = await h.session();
  h.fake.expireAccessTokens();
  h.fake.control.refreshStatus = 503;
  await assert.rejects(h.backgroundConnect(), McpOAuthRefreshUnavailableError);
  assert.deepEqual((await h.session()).tokens, signedIn.tokens, "the stored tokens are kept");
  assert.equal(h.status.needsSignIn(h.server.id), false);
  assert.equal((await h.signInState()).needsSignIn, false);
  assert.equal(h.opened.length, 1, "no new browser sign-in");

  h.fake.control.refreshStatus = undefined;
  assert.equal((await h.backgroundConnect()).length, 1, "the next connection refreshes");
});

test("a rejected refresh token needs sign-in, durably", async (t) => {
  const h = await setup(t);
  await h.authorize();
  h.fake.expireAccessTokens();
  h.fake.revokeRefreshTokens();
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.equal(h.fake.seen.tokenRequests.slice(-1)[0]!.error, "invalid_grant");
  const stored = await h.session();
  assert.equal(stored.tokens, undefined);
  assert.ok(stored.grantId);
  assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: true, hasSession: true });
});

test("re-authorizing keeps earlier granted scopes when the token response omits scope", async (t) => {
  const h = await setup(t, { scopesSupported: ["files.read"], omitTokenScope: true, emptyChallengeScope: true });
  // An earlier step-up granted files.write; the resource advertises only files.read.
  await h.store.set(h.server.id, { authorizationBinding: mcpOAuthBindingForServer(h.server), grantedScope: "files.write", grantId: "earlier" });
  await h.authorize();
  // The empty challenge scope fell back to scopes_supported instead of requesting "".
  assert.deepEqual(mcpScopeTokens(h.fake.seen.authorizations[0].searchParams.get("scope") ?? "").sort(), ["files.read", "files.write"]);
  const session = await h.session();
  assert.deepEqual(mcpScopeTokens(session.tokens?.scope).sort(), ["files.read", "files.write"]);
});

test("a granted offline_access scope merged into a re-authorization still asks for consent", async (t) => {
  const h = await setup(t, { scopesSupported: ["files.read"] });
  await h.store.set(h.server.id, { authorizationBinding: mcpOAuthBindingForServer(h.server), grantedScope: "offline_access", grantId: "earlier" });
  await h.authorize();
  const consent = h.fake.seen.authorizations[0];
  assert.deepEqual(mcpScopeTokens(consent.searchParams.get("scope") ?? "").sort(), ["files.read", "offline_access"]);
  assert.equal(consent.searchParams.get("prompt"), "consent");
});

test("a server that accepts anonymous initialize still signs in before Authorized", async (t) => {
  const h = await setup(t, { anonymousInitialize: true });
  assert.deepEqual(await h.authorize(), { authorized: true });
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => [request.grant, request.status]), [["authorization_code", 200]]);
  assert.ok((await h.session()).tokens, "Authorized always means stored tokens");
});

test("a background connection without stored tokens never discovers, registers or stores a verifier", async (t) => {
  const h = await setup(t);
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.deepEqual(h.fake.seen.requests.map((request) => request.path), ["/mcp"], "only the MCP request that got 401");
  assert.equal(h.store.entries.size, 0);
  assert.equal(h.opened.length, 0);
  assert.equal(h.status.needsSignIn(h.server.id), false, "a server never signed in is not 'expired'");
});

test("an expired client secret sends a background connection to sign-in without registering", async (t) => {
  const h = await setup(t, { issueSecret: true, requireSecret: true, authMethods: ["client_secret_post"] });
  await h.authorize();
  const session = await h.session();
  await h.store.set(h.server.id, { ...session, clientInformation: { ...session.clientInformation!, client_secret_expires_at: 1 } });
  h.fake.expireAccessTokens();
  const before = registrationAndTokenTraffic(h.fake);
  // A Bot's connect card reads the stored sign-in the way the desktop wires it.
  const notion = serverFromPreset(getMcpPreset("notion")!);
  const botSeesConnected = () => isBotConnectionReady("notion", {
    listServers: async () => [notion],
    hasPresetKey: async () => false,
    hasOAuthTokens: async () => (await readMcpOAuthSignInState(h.store, h.server.id, h.server)).authorized,
  });
  assert.equal(await botSeesConnected(), true);
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.deepEqual(registrationAndTokenTraffic(h.fake), before);
  // After a restart only the store is left: it reads needs-sign-in, the Bot
  // sees the connector as not connected, and a new connection stops at once.
  assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: true, hasSession: true });
  assert.equal((await h.session()).grantId, session.grantId, "the grant id stays");
  assert.equal(await botSeesConnected(), false);
  const requests = h.fake.seen.requests.length;
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.deepEqual(h.fake.seen.requests.slice(requests).map((request) => request.path), ["/mcp"]);
});

test("an expired client secret keeps newer tokens another client saved meanwhile", async (t) => {
  const h = await setup(t, { issueSecret: true, requireSecret: true, authMethods: ["client_secret_post"] });
  await h.authorize();
  const signedIn = await h.session();
  const expired = { ...signedIn, clientInformation: { ...signedIn.clientInformation!, client_secret_expires_at: 1 } };
  await h.store.set(h.server.id, expired);
  const provider = createBackgroundMcpOAuthProvider(h.runtime, h.server);
  await provider.tokens();
  // Another client stores newer tokens after this connection read its own.
  const newer = { ...expired, tokens: { access_token: "newer-access", token_type: "Bearer", refresh_token: "newer-refresh" } };
  await h.store.set(h.server.id, newer);
  await assert.rejects(provider.clientInformation(), McpOAuthSignInRequiredError);
  assert.deepEqual(await h.session(), newer);
});

test("invalid_client with no tokens left still drops the dead registration and the rejected-refresh marker", async (t) => {
  const h = await setup(t, { issueSecret: true, requireSecret: true, authMethods: ["client_secret_post"] });
  await h.authorize();
  h.fake.expireAccessTokens();
  h.fake.revokeRefreshTokens();
  // invalid_grant first: the tokens go, the registration and a marker stay.
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  const afterGrant = await h.session();
  assert.equal(afterGrant.tokens, undefined);
  assert.ok(afterGrant.clientInformation && afterGrant.rejectedRefresh);
  // Then the server rejects the client itself.
  const provider = createBackgroundMcpOAuthProvider(h.runtime, h.server);
  await provider.tokens();
  await provider.invalidateCredentials("all");
  const session = await h.session();
  assert.equal(session.clientInformation, undefined);
  assert.equal(session.rejectedRefresh, undefined);
  assert.equal(session.grantId, afterGrant.grantId, "the grant id stays, so Settings still reads needs sign-in");
  assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: true, hasSession: true });
});

test("a pre-registered client signs in without registration using its secret", async (t) => {
  const h = await setup(
    t,
    { registration: false, preRegistered: { clientId: "manual-client", clientSecret: "manual-secret" }, requireSecret: true, authMethods: ["client_secret_post"] },
    { server: { oauthClientId: "manual-client", oauthClientSecret: "manual-secret" } },
  );
  await h.authorize();
  assert.equal(h.fake.seen.registrations.length, 0);
  assert.equal(h.fake.seen.authorizations[0].searchParams.get("client_id"), "manual-client");
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => [request.clientId, request.authMethod, request.status]), [["manual-client", "post", 200]]);
  assert.equal((await h.session()).clientInformation, undefined, "the configured client is not copied into the session");
  // Another client ID is another client: the stored sign-in no longer applies.
  assert.equal((await h.signInState({ ...h.server, oauthClientId: "other-client" })).authorized, false);
  assert.equal((await h.signInState()).authorized, true);
});

test("a client secret that is still a keychain marker is never sent", async (t) => {
  const h = await setup(
    t,
    { registration: false, preRegistered: { clientId: "manual-client", clientSecret: "manual-secret" }, requireSecret: true },
    { server: { oauthClientId: "manual-client", oauthClientSecret: `aiden-secret:v1:${"a".repeat(32)}` } },
  );
  await assert.rejects(h.authorize(), /client secret .* missing/u);
  assert.equal(h.fake.seen.tokenRequests.length, 0);
});

test("verification after sign-in never opens a second browser tab and fails when the server rejects the tokens", async (t) => {
  const h = await setup(t);
  // The authorization server issues tokens, but the MCP endpoint rejects them.
  h.fake.control.afterCodeExchange = () => { h.fake.control.rejectAllTokens = true; };
  await assert.rejects(h.authorize(), /did not accept the new sign-in/u);
  assert.deepEqual(h.fake.seen.tokenRequests.map((request) => request.grant), ["authorization_code", "refresh_token"], "verification may refresh, but never authorizes again");
  assert.equal(h.opened.length, 1, "one consent tab only");
  assert.equal(h.store.entries.size, 0);
  assert.match(await h.pages[0], /Sign-in failed/u);
});

test("verification that fails for a non-auth reason keeps the new sign-in and reports the connection error", async (t) => {
  const h = await setup(t);
  h.fake.control.afterCodeExchange = () => { h.fake.control.mcpStatus = 503; };
  const result = await h.authorize();
  assert.equal(result.authorized, true);
  assert.match(result.connectionError ?? "", /503/u);
  assert.ok((await h.session()).tokens);
  assert.match(await h.pages[0], /Connected/u);
});

test("a background provider shows tokens to its observer before using or persisting them", async (t) => {
  const h = await setup(t);
  await h.authorize();
  h.fake.expireAccessTokens();
  const observed: string[] = [];
  const persistedUnseen: string[] = [];
  const set = h.store.set.bind(h.store);
  h.runtime.store = {
    ...h.store,
    set: async (serverId, session, isCurrent) => {
      // A child agent's redactor must know a token before it reaches disk.
      if (session.tokens && !observed.includes(session.tokens.access_token)) persistedUnseen.push(session.tokens.access_token);
      await set(serverId, session, isCurrent);
    },
  };
  const sentBeforeObserved: string[] = [];
  const client = createMcpClient("observer-test", "1");
  const provider = createBackgroundMcpOAuthProvider(h.runtime, h.server, () => true, (tokens) => observed.push(tokens.access_token));
  const firstRequest = h.fake.seen.requests.length;
  try {
    await connectMcpClient(client, makeMcpOAuthTransport(h.server, provider), { timeoutMs: 10_000 });
  } finally {
    await client.close();
  }
  for (const request of h.fake.seen.requests.slice(firstRequest).filter((entry) => entry.path === "/mcp")) {
    const token = /^Bearer\s+(.+)$/u.exec(String(request.headers.authorization ?? ""))?.[1];
    if (token && !observed.includes(token)) sentBeforeObserved.push(token);
  }
  assert.ok(h.fake.seen.requests.slice(firstRequest).some((entry) => entry.path === "/mcp" && entry.headers.authorization), "the connection sent tokens");
  const refreshed = (await h.session()).tokens!.access_token;
  assert.ok(observed.includes(refreshed), "the refreshed token was observed");
  assert.deepEqual(persistedUnseen, []);
  assert.deepEqual(sentBeforeObserved, []);
});

test("token-endpoint errors reach the browser and Settings as one bounded line, never a raw body", async (t) => {
  const html = await setup(t);
  html.fake.control.codeExchangeResponse = { status: 502, contentType: "text/html", body: `<html><body>${"Bad gateway <script>x</script>\n".repeat(200)}</body></html>` };
  await assert.rejects(html.authorize(), (error: Error) => {
    assert.equal(error.message, "The authorization server answered HTTP 502.");
    return true;
  });
  const page = await html.pages[0];
  assert.match(page, /answered HTTP 502/u);
  assert.doesNotMatch(page, /Bad gateway|<script>/u);

  const json = await setup(t);
  json.fake.control.codeExchangeResponse = { status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_request", error_description: `line one\nline two\r\n${"x".repeat(600)}` }) };
  await assert.rejects(json.authorize(), (error: Error) => {
    assert.match(error.message, /^The authorization server returned “invalid_request”: line one line two x+…$/u);
    assert.ok(error.message.length < 400);
    return true;
  });
  assert.doesNotMatch(await json.pages[0], /line one\s*\n/u);
});

test("an expired access token without a refresh token needs sign-in after a restart too", async (t) => {
  const h = await setup(t);
  h.fake.control.withoutRefreshTokens = true;
  await h.authorize();
  h.fake.expireAccessTokens();
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  // After a restart only the store is left: it reads "needs sign-in", and a new provider agrees.
  assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: true, hasSession: true });
  const requests = h.fake.seen.requests.length;
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.deepEqual(h.fake.seen.requests.slice(requests).map((request) => request.path), ["/mcp"], "no discovery for a sign-in that is known to be gone");
});

test("a refresh rejected without an OAuth error document needs sign-in durably", async (t) => {
  const h = await setup(t);
  await h.authorize();
  h.fake.expireAccessTokens();
  h.fake.control.refreshResponse = { status: 400, contentType: "text/html", body: "<h1>Bad Request</h1>" };
  await assert.rejects(h.backgroundConnect(), McpOAuthSignInRequiredError);
  assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: true, hasSession: true });
});

test("a step-up for more scope keeps the stored tokens", async (t) => {
  const h = await setup(t);
  await h.authorize();
  const before = (await h.session()).tokens;
  const provider = createBackgroundMcpOAuthProvider(h.runtime, h.server);
  // The transport's insufficient_scope recovery reads the grant, then starts a flow without a refresh.
  await provider.tokens();
  await provider.discoveryState();
  await assert.rejects(provider.state(), McpOAuthSignInRequiredError);
  assert.deepEqual((await h.session()).tokens, before);
});

test("a token endpoint that is temporarily unavailable with an OAuth error keeps the sign-in", async (t) => {
  const h = await setup(t);
  await h.authorize();
  const signedIn = await h.session();
  h.fake.expireAccessTokens();
  h.fake.control.refreshResponse = { status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) };
  await assert.rejects(h.backgroundConnect(), McpOAuthRefreshUnavailableError);
  assert.deepEqual((await h.session()).tokens, signedIn.tokens);
  assert.equal((await h.signInState()).needsSignIn, false);
});

test("a negative token lifetime is dropped instead of making the stored sign-in unreadable", async (t) => {
  const h = await setup(t);
  h.fake.control.expiresIn = -5;
  await h.authorize();
  const session = await h.session();
  assert.ok(session.tokens);
  assert.equal(session.tokens.expires_in, undefined);
  assert.equal((await h.signInState()).authorized, true);
});

/**
 * Hold the next refresh response after the server rotated the refresh token.
 * Resolves with the rotated tokens once the rotation happened; `release` sends
 * the held response.
 */
function holdNextRefresh(fake: FakeOAuthServer) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const rotated = new Promise<{ access_token: string; refresh_token?: string }>((resolve) => {
    fake.control.beforeRefreshResponse = (tokens) => {
      fake.control.beforeRefreshResponse = undefined;
      resolve(tokens);
      return released;
    };
  });
  return { rotated, release: () => release() };
}

/**
 * Client B as another process sees it: Pi's own refresh flow over a fetch that
 * shares no in-process refresh flight with client A.
 */
function otherProcessRefresh(h: Awaited<ReturnType<typeof setup>>) {
  return authorizeMcp(createBackgroundMcpOAuthProvider(h.runtime, h.server), { serverUrl: h.server.url!, fetch: globalThis.fetch });
}

function refreshVerdicts(fake: FakeOAuthServer) {
  return fake.seen.tokenRequests.filter((request) => request.grant === "refresh_token").map((request) => [request.status, request.error ?? null]);
}

for (const atomicStore of [false, true]) {
  const storeKind = atomicStore ? "a locked shared store" : "a read-then-write store";

  test(`a refresh rejected because another client just rotated the token keeps that rotation (${storeKind})`, async (t) => {
    const h = await setup(t, {}, { atomicStore });
    await h.authorize();
    const signedIn = await h.session();
    h.fake.expireAccessTokens();
    // A presents the stored refresh token; the server rotates it and the response is held.
    const held = holdNextRefresh(h.fake);
    const a = h.backgroundConnect();
    const rotated = await held.rotated;
    // B presents the same, now consumed, refresh token: invalid_grant, and the pair is removed.
    await assert.rejects(otherProcessRefresh(h), McpOAuthSignInRequiredError);
    assert.deepEqual(refreshVerdicts(h.fake), [[200, null], [400, "invalid_grant"]]);
    assert.equal((await h.session()).tokens, undefined);
    // A's rotation arrives and lands: it is the grant's only live refresh token.
    held.release();
    assert.equal((await a).length, 1);
    const session = await h.session();
    assert.equal(session.tokens?.refresh_token, rotated.refresh_token);
    assert.equal(session.grantId, signedIn.grantId);
    assert.deepEqual(await h.signInState(), { authorized: true, needsSignIn: false, hasSession: true });
    // Both clients connect again on the rotated grant, without another refresh or sign-in.
    assert.equal((await h.backgroundConnect()).length, 1);
    assert.equal(await otherProcessRefresh(h), "AUTHORIZED");
    assert.equal((await h.backgroundConnect()).length, 1);
    assert.equal(refreshVerdicts(h.fake).length, 3, "B's flow refreshed the restored grant once");
    assert.equal(h.opened.length, 1, "no new browser sign-in");
  });

  test(`a refresh that arrives after a sign-out does not sign back in (${storeKind})`, async (t) => {
    const h = await setup(t, {}, { atomicStore });
    await h.authorize();
    h.fake.expireAccessTokens();
    const held = holdNextRefresh(h.fake);
    const a = h.backgroundConnect();
    await held.rotated;
    await assert.rejects(otherProcessRefresh(h), McpOAuthSignInRequiredError);
    // Sign out from another process (this process's operation gate never hears of it).
    await h.store.clear(h.server.id);
    held.release();
    await assert.rejects(a);
    assert.deepEqual(await h.signInState(), { authorized: false, needsSignIn: false, hasSession: false });
  });

  test(`a refresh that arrives after a re-authorization keeps the new grant (${storeKind})`, async (t) => {
    const h = await setup(t, {}, { atomicStore });
    await h.authorize();
    h.fake.expireAccessTokens();
    const held = holdNextRefresh(h.fake);
    const a = h.backgroundConnect();
    const rotated = await held.rotated;
    await assert.rejects(otherProcessRefresh(h), McpOAuthSignInRequiredError);
    // Authorize again from another process (its own operation gate).
    await authorizeMcpServerWithRuntime({ ...h.runtime, gate: new McpOAuthOperationGate() }, h.server);
    const reauthorized = await h.session();
    held.release();
    await a.catch(() => undefined);
    const session = await h.session();
    assert.equal(session.grantId, reauthorized.grantId);
    assert.deepEqual(session.tokens, reauthorized.tokens);
    assert.notEqual(session.tokens?.refresh_token, rotated.refresh_token);
  });
}
