import assert from "node:assert/strict";
import { createServer } from "node:net";
import test, { mock } from "node:test";
import {
  McpAbortError,
  McpAuthRequiredError,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpSessionExpiredError,
  McpTimeoutError,
} from "@earendil-works/pi-mcp";
import { OAuthError, OAuthIssuerMismatchError, OAuthRegistrationError } from "@earendil-works/pi-mcp/oauth";
import { registerMcpControlHandlers, type McpControlDependencies } from "../handlers/mcp-controls.js";
import { createDiagnosticEvent, type DiagnosticEventInput } from "./diagnostics-contract.js";
import { connectMcpClient, createMcpClient } from "./mcp-client.js";
import {
  classifyMcpFailure,
  McpDiagnosticsReporter,
  mcpFailureEvent,
  type McpDiagnosticServer,
} from "./mcp-failure-diagnostics.js";
import { McpOAuthCancelledError } from "./mcp-oauth-operation.js";
import { McpOAuthRefreshUnavailableError, McpOAuthSignInRequiredError } from "./mcp-oauth-provider-core.js";
import { McpOAuthCallbackError } from "./mcp-oauth-session.js";
import { McpStdioApprovalRequiredError } from "./mcp-stdio-approvals.js";
import { createMcpStdioTransport } from "./mcp-stdio-transport.js";
import { asMcpDeadlineError } from "./mcp-tool-discovery-core.js";

/** An error with a `cause` (the project's lib target predates ErrorOptions). */
function withCause<T extends Error>(error: T, cause: unknown): T {
  Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
  return error;
}

const remote: McpDiagnosticServer = { id: "linear", transport: "http", url: "https://mcp.linear.app/mcp" };
const local: McpDiagnosticServer = { id: "files", transport: "stdio" };

/** What the journal would store: the input after the contract's allowlist. */
function recorded(input: DiagnosticEventInput) {
  return createDiagnosticEvent(input, "session-test", () => new Date("2026-10-21T00:00:00Z"));
}

async function refusedFetch(): Promise<unknown> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return fetch(`http://127.0.0.1:${port}/mcp`).catch((error: unknown) => error);
}

test("classifies Pi transport errors with HTTP status", () => {
  const unavailable = classifyMcpFailure(new McpHttpError(503, "MCP HTTP request failed with status 503", "upstream down"), "http");
  assert.equal(unavailable.failure, "http-5xx");
  assert.equal(unavailable.httpStatus, 503);
  assert.equal(unavailable.code, "service-unavailable");
  assert.equal(unavailable.errorClass, "McpHttpError");

  assert.equal(classifyMcpFailure(new McpHttpError(404, "not found"), "http").failure, "http-4xx");
  // Pi raises McpHttpError for a 2xx it cannot use.
  const accepted = classifyMcpFailure(new McpHttpError(200, "MCP server returned unsupported content type"), "http");
  assert.deepEqual([accepted.failure, accepted.httpStatus, accepted.code], ["protocol", 200, "contract-rejected"]);
  const unauthorized = classifyMcpFailure(new McpAuthRequiredError(new Response(null, { status: 401 })), "http");
  assert.deepEqual([unauthorized.failure, unauthorized.httpStatus, unauthorized.errorClass], ["auth-required", 401, "McpAuthRequiredError"]);
  const forbidden = classifyMcpFailure(new McpHttpError(403, "MCP HTTP request failed with status 403"), "http");
  assert.deepEqual([forbidden.failure, forbidden.code], ["auth-rejected", "authentication-failed"]);
  assert.equal(classifyMcpFailure(new McpSessionExpiredError(), "http").failure, "session-expired");
  assert.equal(classifyMcpFailure(new McpError(-32601, "Method not found"), "http").failure, "protocol");
});

test("classifies a real refused connection with its errno", async () => {
  const error = await refusedFetch();
  const classified = classifyMcpFailure(error, "http");
  assert.equal(classified.failure, "network");
  assert.equal(classified.errno, "ECONNREFUSED");
  assert.equal(classified.code, "network-failed");
  assert.equal(classified.errorClass, "TypeError");
  // An unavailable refresh keeps its own class and still records the cause's errno.
  const refresh = classifyMcpFailure(new McpOAuthRefreshUnavailableError(error as Error), "http");
  assert.deepEqual([refresh.failure, refresh.errno, refresh.errorClass], ["auth-refresh-unavailable", "ECONNREFUSED", "McpOAuthRefreshUnavailableError"]);
});

test("classifies TLS and timeout causes behind fetch's TypeError", () => {
  const tls = withCause(new TypeError("fetch failed"), Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }));
  assert.deepEqual([classifyMcpFailure(tls, "http").failure, classifyMcpFailure(tls, "http").errno], ["tls", "CERT_HAS_EXPIRED"]);
  const connectTimeout = withCause(new TypeError("fetch failed"), Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }));
  assert.equal(classifyMcpFailure(connectTimeout, "http").failure, "timeout");
  assert.equal(classifyMcpFailure(new McpTimeoutError(30_000), "http").failure, "timeout");
  assert.equal(classifyMcpFailure(asMcpDeadlineError(new McpTimeoutError(30_000)), "http").failure, "timeout");
  assert.equal(classifyMcpFailure(new McpAbortError(), "http").failure, "cancelled");
  assert.equal(classifyMcpFailure(new McpOAuthCancelledError(), "http").failure, "cancelled");
});

test("classifies real platform aborts and timeouts", async () => {
  const controller = new AbortController();
  controller.abort();
  const aborted = await fetch("http://127.0.0.1:9/mcp", { signal: controller.signal }).then(() => undefined, (error: unknown) => error);
  assert.ok(aborted instanceof DOMException);
  assert.deepEqual([classifyMcpFailure(aborted, "http").failure, classifyMcpFailure(aborted, "http").errorClass], ["cancelled", "AbortError"]);
  const timedOut = await new Promise<unknown>((resolve) => {
    const signal = AbortSignal.timeout(1);
    // AbortSignal.timeout's timer doesn't keep the event loop alive, so hold it open until the abort fires.
    const hold = setTimeout(() => undefined, 1_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(hold);
        resolve(signal.reason);
      },
      { once: true },
    );
  });
  const classified = classifyMcpFailure(timedOut, "http");
  assert.deepEqual([classified.failure, classified.code, classified.errorClass], ["timeout", "timed-out", "TimeoutError"]);
  // A wrapper whose cause is the platform abort.
  assert.equal(classifyMcpFailure(withCause(new Error("Bot inventory stopped"), aborted), "http").failure, "cancelled");
});

test("classifies OAuth failures with the registered error code", () => {
  const grant = classifyMcpFailure(new OAuthError("invalid_grant", "Refresh token expired"), "http");
  assert.deepEqual([grant.failure, grant.oauthError, grant.code], ["oauth-error", "invalid_grant", "authentication-failed"]);
  // A server-invented code is never recorded verbatim.
  assert.equal(classifyMcpFailure(new OAuthError("tenant_acme_blocked", "no"), "http").oauthError, "other");
  const registration = classifyMcpFailure(new OAuthRegistrationError(403, JSON.stringify({ error: "invalid_client_metadata", error_description: "redirect not allowed" })), "http");
  assert.deepEqual([registration.failure, registration.httpStatus, registration.oauthError], ["oauth-registration-rejected", 403, "invalid_client_metadata"]);
  assert.equal(classifyMcpFailure(new OAuthRegistrationError(403, "<html>Forbidden</html>"), "http").oauthError, undefined);
  assert.equal(classifyMcpFailure(new OAuthIssuerMismatchError("https://a.example", "https://b.example"), "http").failure, "oauth-issuer-mismatch");
  assert.equal(classifyMcpFailure(new McpOAuthCallbackError("access_denied"), "http").oauthError, "access_denied");
  assert.equal(classifyMcpFailure(new McpOAuthSignInRequiredError(), "http").failure, "auth-required");
});

test("classifies stdio launch and exit failures from the real transport", async () => {
  const spawnError = await createMcpStdioTransport({ command: "/nonexistent-aiden-dir/server" }).start().then(() => undefined, (error: unknown) => error);
  const spawn = classifyMcpFailure(spawnError, "stdio");
  assert.deepEqual([spawn.failure, spawn.errno, spawn.code], ["stdio-spawn", "ENOENT", "launch-failed"]);

  const exitError = await connectMcpClient(
    createMcpClient("aiden-test"),
    createMcpStdioTransport({ command: process.execPath, args: ["-e", "process.exit(3)"] }),
    { timeoutMs: 10_000 },
  ).then(() => undefined, (error: unknown) => error);
  assert.equal(classifyMcpFailure(exitError, "stdio").failure, "stdio-exit");
  assert.equal(classifyMcpFailure(new McpConnectionClosedError(), "http").failure, "connection-closed");
  assert.equal(classifyMcpFailure(new McpStdioApprovalRequiredError("Files"), "stdio").failure, "stdio-approval");
  assert.equal(classifyMcpFailure(new Error("MCP stdio message exceeds 1048576 bytes"), "stdio").failure, "oversized");
});

test("recorded MCP failure events carry the classification, host and transport", () => {
  const event = recorded(mcpFailureEvent("mcp-degraded", remote, new McpHttpError(502, "bad gateway"), { phase: "mcp-prewarm" }));
  assert.equal(event.event, "mcp-degraded");
  assert.equal(event.code, "service-unavailable");
  assert.equal(event.fields?.mcpFailure, "http-5xx");
  assert.equal(event.fields?.httpStatus, 502);
  assert.equal(event.fields?.transport, "http");
  assert.equal(event.fields?.serverHost, "mcp.linear.app");
  assert.match(String(event.fields?.serverRef), /^[0-9a-f]{16}$/u);
  assert.equal(event.fields?.errorType, "McpHttpError");
  assert.equal(event.fields?.failurePhase, "mcp-prewarm");

  const stdio = recorded(mcpFailureEvent("mcp-degraded", local, new McpStdioApprovalRequiredError("Files"), { phase: "mcp-tool-discovery" }));
  assert.equal(stdio.fields?.failurePhase, "mcp-stdio-approval");
  assert.equal(stdio.fields?.serverHost, undefined);
  assert.equal(stdio.fields?.transport, "stdio");
});

test("caller extras never replace the classification", () => {
  const event = recorded(mcpFailureEvent("mcp-degraded", remote, new McpHttpError(503, "down"), {
    phase: "mcp-prewarm",
    extra: { mcpFailure: "unknown", failurePhase: "mcp-sign-in", backoffMs: 500 },
  }));
  assert.equal(event.fields?.mcpFailure, "http-5xx");
  assert.equal(event.fields?.failurePhase, "mcp-prewarm");
  assert.equal(event.fields?.backoffMs, 500);
});

test("hosts outside the bundled connectors are recorded only as a category", () => {
  const cases: Array<[string, string]> = [
    ["http://192.168.1.20:8080/mcp", "private-ip"],
    ["http://10.0.0.5/mcp", "private-ip"],
    ["http://100.101.102.103/mcp", "private-ip"],
    ["http://[fd00::1]/mcp", "private-ip"],
    ["http://localhost:3000/mcp", "loopback"],
    ["http://127.0.0.1:3845/mcp", "loopback"],
    ["http://[::1]/mcp", "loopback"],
    ["https://203.0.113.9/mcp", "public-ip"],
    ["https://jdoe-macbook.tail1234.ts.net/mcp", "custom"],
    ["https://acme.atlassian.net/mcp", "custom"],
    ["https://acme.mcp.linear.app/mcp", "custom"],
  ];
  for (const [url, kind] of cases) {
    const event = recorded(mcpFailureEvent("mcp-degraded", { id: "custom", transport: "http", url }, new McpTimeoutError(1), { phase: "mcp-prewarm" }));
    assert.equal(event.fields?.serverHostKind, kind, url);
    assert.equal(event.fields?.serverHost, undefined, url);
    const serialized = JSON.stringify(event);
    for (const fragment of ["192.168", "10.0.0.5", "100.101", "fd00", "localhost", "127.0.0.1", "::1", "203.0.113", "jdoe", "ts.net", "acme"]) {
      assert.ok(!serialized.includes(fragment), `${fragment} leaked for ${url}`);
    }
  }
  // A bundled connector's own public endpoint is named.
  const linear = recorded(mcpFailureEvent("mcp-degraded", remote, new McpTimeoutError(1), { phase: "mcp-prewarm" }));
  assert.equal(linear.fields?.serverHost, "mcp.linear.app");
  assert.equal(linear.fields?.serverHostKind, undefined);
});

test("recorded events never contain URLs, paths, tokens, client secrets or stdio arguments", async () => {
  const secrets = ["user-SECRET", "pw-SECRET", "SECRETPATH", "SECRET-QUERY", "SECRET-FRAGMENT", "8443", "SECRET-CLIENT", "SECRET-BODY", "SECRET-URI", "SECRET-ARG", "SECRET-ENV", "secret-bin", "SECRET-DATA", "example.com"];
  const server: McpDiagnosticServer = {
    id: "custom-SECRETPATH",
    transport: "http",
    url: "https://user-SECRET:pw-SECRET@mcp.example.com:8443/v1/SECRETPATH?access_token=SECRET-QUERY#SECRET-FRAGMENT",
  };
  const stdioServer: McpDiagnosticServer & { command: string; args: string[]; env: Record<string, string> } = {
    id: "local",
    transport: "stdio",
    command: "/Users/someone/secret-bin/server",
    args: ["--api-key", "SECRET-ARG"],
    env: { TOKEN: "SECRET-ENV" },
  };
  const spawnError = await createMcpStdioTransport(stdioServer).start().then(() => undefined, (error: unknown) => error);
  // The real spawn error carries the command and its arguments.
  assert.ok(JSON.stringify(spawnError).includes("SECRET-ARG"));

  const errors: Array<[McpDiagnosticServer, unknown]> = [
    [server, new OAuthError("invalid_client", "client_secret=SECRET-CLIENT was rejected", "https://auth.example/SECRET-URI")],
    [server, new OAuthRegistrationError(400, JSON.stringify({ error: "invalid_client_metadata", error_description: "SECRET-BODY" }))],
    [server, new McpHttpError(500, `POST ${server.url} failed`, "SECRET-BODY")],
    [server, new McpError(-32000, "SECRET-DATA", { token: "SECRET-DATA" })],
    [server, withCause(new TypeError(`Could not reach ${server.url}`), Object.assign(new Error("SECRETPATH"), { code: "ECONNREFUSED" }))],
    [stdioServer, spawnError],
  ];
  for (const [target, error] of errors) {
    for (const event of ["mcp-degraded", "mcp-failed"] as const) {
      const serialized = JSON.stringify(recorded(mcpFailureEvent(event, target, error, { phase: "mcp-sign-in" })));
      for (const secret of secrets) assert.ok(!serialized.includes(secret), `${secret} leaked into ${serialized}`);
      assert.doesNotMatch(serialized, /https?:|\/v1\//u);
    }
  }
  const remoteEvent = recorded(mcpFailureEvent("mcp-degraded", server, errors[0]![1], { phase: "mcp-prewarm" }));
  assert.equal(remoteEvent.fields?.serverHost, undefined);
  assert.equal(remoteEvent.fields?.serverHostKind, "custom");
  assert.equal(remoteEvent.fields?.oauthError, "invalid_client");
});

test("identical failures within the window become one line with a repeat count", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const written: DiagnosticEventInput[] = [];
  const reporter = new McpDiagnosticsReporter({ write: (event) => written.push(event), windowMs: 60_000 });
  const failure = () => new McpHttpError(503, "unavailable");

  for (let index = 0; index < 5; index += 1) reporter.degraded(remote, failure(), { phase: "mcp-tool-discovery" });
  assert.equal(written.length, 1);
  assert.equal(written[0]!.fields?.suppressed, undefined);

  mock.timers.tick(60_000);
  assert.equal(written.length, 2);
  assert.equal(recorded(written[1]!).fields?.suppressed, 4);
  assert.equal(recorded(written[1]!).fields?.mcpFailure, "http-5xx");

  // A quiet window closes without a line; the next failure is written at once.
  mock.timers.tick(60_000);
  assert.equal(written.length, 2);
  reporter.degraded(remote, failure(), { phase: "mcp-prewarm" });
  assert.equal(written.length, 3);

  // Another server is coalesced separately.
  reporter.degraded(local, new McpConnectionClosedError(), { phase: "mcp-prewarm" });
  assert.equal(written.length, 4);
  reporter.shutdown();
});

test("a server alternating between failures writes one line per failure per window; recovery flushes both once", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const written: DiagnosticEventInput[] = [];
  const reporter = new McpDiagnosticsReporter({ write: (event) => written.push(event) });
  const timeout = () => new McpTimeoutError(30_000);
  const network = () => withCause(new TypeError("fetch failed"), Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));

  for (let index = 0; index < 6; index += 1) reporter.degraded(remote, index % 2 ? network() : timeout(), { phase: "mcp-prewarm" });
  assert.deepEqual(written.map((event) => event.fields?.mcpFailure), ["timeout", "network"]);

  reporter.recovered(remote);
  reporter.recovered(remote);
  const tail = written.slice(2).map((event) => [event.event, event.fields?.mcpFailure, event.fields?.suppressed]);
  assert.deepEqual(tail.slice(0, 2).sort(), [["mcp-degraded", "network", 2], ["mcp-degraded", "timeout", 2]]);
  assert.deepEqual(tail.slice(2), [["mcp-recovered", undefined, undefined]]);
  const recovery = recorded(written[written.length - 1]!);
  assert.equal(recovery.outcome, "recovered");
  assert.equal(recovery.fields?.serverHost, "mcp.linear.app");
  // The reference matches the degraded lines and differs between servers.
  assert.equal(recovery.fields?.serverRef, recorded(written[0]!).fields?.serverRef);
  reporter.degraded(local, timeout(), { phase: "mcp-prewarm" });
  assert.notEqual(recorded(written[written.length - 1]!).fields?.serverRef, recovery.fields?.serverRef);

  // Nothing is pending after recovery: no timer writes later.
  mock.timers.tick(5 * 60_000);
  assert.equal(written.length, 6);
  // A server that never degraded reports no recovery.
  reporter.recovered({ id: "other", transport: "http", url: "https://mcp.notion.com/mcp" });
  assert.equal(written.length, 6);
  reporter.shutdown();
});

test("shutdown writes pending counts and stops every timer", (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const written: DiagnosticEventInput[] = [];
  const reporter = new McpDiagnosticsReporter({ write: (event) => written.push(event) });
  reporter.degraded(remote, new McpHttpError(503, "unavailable"), { phase: "mcp-prewarm" });
  reporter.degraded(remote, new McpHttpError(503, "unavailable"), { phase: "mcp-prewarm" });
  reporter.shutdown();
  assert.deepEqual(written.map((event) => event.fields?.suppressed), [undefined, 1]);
  mock.timers.tick(10 * 60_000);
  assert.equal(written.length, 2);
  // After shutdown each failure is written as it comes, without a window.
  reporter.degraded(remote, new McpHttpError(503, "unavailable"), { phase: "mcp-prewarm" });
  reporter.degraded(remote, new McpHttpError(503, "unavailable"), { phase: "mcp-prewarm" });
  assert.equal(written.length, 4);
  mock.timers.tick(10 * 60_000);
  assert.equal(written.length, 4);
});

test("a failed Authorize from Settings records a classified sign-in failure", async () => {
  const handlers = new Map<string, (event: string, ...args: unknown[]) => unknown>();
  const written: DiagnosticEventInput[] = [];
  const reporter = new McpDiagnosticsReporter({ write: (event) => written.push(event) });
  const unused = () => { throw new Error("unused"); };
  let signedIn = false;
  const deps: McpControlDependencies<string> = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    owner: () => ({ isDestroyed: () => false }),
    configured: async () => undefined,
    authorize: async () => {
      if (signedIn) return { authorized: true };
      throw new OAuthRegistrationError(403, JSON.stringify({ error: "invalid_client_metadata", client_secret: "SECRET-CLIENT" }));
    },
    reportAuthorizeFailure: (server, error) => reporter.signInFailed(server, error),
    reportAuthorizeSuccess: (server) => reporter.recovered(server),
    cancelAuthorization: () => false,
    signOut: unused,
    testDraft: unused,
    admitSaved: unused,
    signInState: unused,
    dependents: unused,
    liveStatus: () => [],
    toolList: () => undefined,
    pendingLaunchApprovals: async () => [],
    approveLaunch: unused,
    launchApproved: unused,
  };
  registerMcpControlHandlers(deps);
  const server = { id: "custom-acme", name: "Acme", transport: "http", url: "https://mcp.acme.test/v1?key=SECRET-QUERY", oauth: true, enabled: true };
  await assert.rejects(Promise.resolve().then(() => handlers.get("mcp:authorize")!("settings", server)), OAuthRegistrationError);
  assert.equal(written.length, 1);
  const event = recorded(written[0]!);
  assert.equal(event.event, "mcp-failed");
  assert.equal(event.outcome, "failed");
  assert.equal(event.fields?.failurePhase, "mcp-sign-in");
  assert.equal(event.fields?.mcpFailure, "oauth-registration-rejected");
  assert.equal(event.fields?.httpStatus, 403);
  assert.equal(event.fields?.oauthError, "invalid_client_metadata");
  assert.equal(event.fields?.serverHostKind, "custom");
  assert.doesNotMatch(JSON.stringify(event), /SECRET|acme/u);

  // A background failure, then a successful Authorize: recovery is written once.
  reporter.degraded(server as McpDiagnosticServer, new McpAuthRequiredError(new Response(null, { status: 401 })), { phase: "mcp-prewarm" });
  signedIn = true;
  assert.deepEqual(await handlers.get("mcp:authorize")!("settings", server), { authorized: true });
  assert.deepEqual(written.slice(1).map((line) => line.event), ["mcp-degraded", "mcp-recovered"]);
  reporter.shutdown();
});
