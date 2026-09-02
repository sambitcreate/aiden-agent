import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeSourcePreviewHttpRedirect,
  authorizeSourcePreviewHttpRequest,
  authorizeSourcePreviewWebSocketTarget,
  authorizeSourcePreviewWebSocketUpgrade,
  issueSourcePreviewTransportProof,
  type SourcePreviewTransportProofV1,
} from "./source-preview-transport-core.js";

function proof(): SourcePreviewTransportProofV1 {
  const value = issueSourcePreviewTransportProof({
    version: 1,
    sessionId: "preview_session_0001",
    targetOrigin: "http://127.0.0.1:5173",
    resolvedAddresses: ["127.0.0.1"],
    allowedHttpPathPrefixes: ["/app", "/@vite/client", "/src"],
    allowedWebSocketPathPrefixes: ["/hmr"],
    allowedHttpQueryKeys: ["t", "v", "import"],
    allowedWebSocketQueryParameters: { token: "opaque" },
    allowedWebSocketProtocols: ["vite-hmr"],
  });
  assert.ok(value);
  return value;
}

function httpRequest(
  value: SourcePreviewTransportProofV1,
  overrides: Record<string, unknown> = {},
) {
  return authorizeSourcePreviewHttpRequest({
    proof: value,
    targetUrl: "http://127.0.0.1:5173/app/index.html",
    method: "GET",
    headers: { accept: "text/html" },
    credentialsMode: "omit",
    resolvedAddresses: ["127.0.0.1"],
    ...overrides,
  } as Parameters<typeof authorizeSourcePreviewHttpRequest>[0]);
}

function websocketHeaders(value: SourcePreviewTransportProofV1) {
  return {
    host: `127.0.0.1:${value.port}`,
    origin: value.httpOrigin,
    connection: "keep-alive, Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-protocol": "vite-hmr",
  };
}

test("issues only an exact literal-loopback, credential-free, fixed-port proof", () => {
  assert.ok(proof());
  assert.equal(
    issueSourcePreviewTransportProof({
      version: 1,
      sessionId: "preview_session_0001",
      targetOrigin: "http://127.0.0.1:5173",
      resolvedAddresses: ["127.0.0.1"],
      allowedHttpPathPrefixes: ["/app"],
      allowedWebSocketPathPrefixes: ["/hmr"],
      allowedHttpQueryKeys: [],
      allowedWebSocketQueryParameters: {},
      allowedWebSocketProtocols: [],
      unexpectedAuthority: true,
    }),
    undefined,
  );
  for (const input of [
    {
      targetOrigin: "http://localhost:5173",
      resolvedAddresses: ["127.0.0.1"],
    },
    {
      targetOrigin: "http://user:password@127.0.0.1:5173",
      resolvedAddresses: ["127.0.0.1"],
    },
    {
      targetOrigin: "https://127.0.0.1:5173",
      resolvedAddresses: ["127.0.0.1"],
    },
    {
      targetOrigin: "http://127.0.0.1:5173",
      resolvedAddresses: ["127.0.0.1", "10.0.0.2"],
    },
  ]) {
    assert.equal(
      issueSourcePreviewTransportProof({
        version: 1,
        sessionId: "preview_session_0001",
        allowedHttpPathPrefixes: ["/app"],
        allowedWebSocketPathPrefixes: ["/hmr"],
        allowedHttpQueryKeys: [],
        allowedWebSocketQueryParameters: {},
        allowedWebSocketProtocols: [],
        ...input,
      }),
      undefined,
    );
  }
});

test("HTTP authorization allows only proof-bound paths, query keys, headers, and omitted credentials", () => {
  const value = proof();
  assert.deepEqual(httpRequest(value), {
    allowed: true,
    normalizedUrl: "http://127.0.0.1:5173/app/index.html",
  });
  assert.equal(
    httpRequest(value, { targetUrl: "http://127.0.0.1:5173/src/main.tsx?t=123" }).allowed,
    true,
  );
  assert.deepEqual(httpRequest(value, { targetUrl: "http://127.0.0.1:5173/admin" }), {
    allowed: false,
    reason: "path-unproven",
  });
  assert.deepEqual(
    httpRequest(value, { targetUrl: "http://127.0.0.1:5173/src/main.tsx?credential=x" }),
    { allowed: false, reason: "query-unproven" },
  );
  assert.deepEqual(httpRequest(value, { headers: { cookie: "session=x" } }), {
    allowed: false,
    reason: "header-forbidden",
  });
  assert.deepEqual(httpRequest(value, { headers: { authorization: "Bearer secret" } }), {
    allowed: false,
    reason: "header-forbidden",
  });
  assert.deepEqual(httpRequest(value, { headers: { Accept: "text/html", accept: "text/plain" } }), {
    allowed: false,
    reason: "header-forbidden",
  });
  assert.deepEqual(httpRequest(value, { credentialsMode: "include" }), {
    allowed: false,
    reason: "credentials-forbidden",
  });
  assert.deepEqual(httpRequest(value, { method: "POST" }), {
    allowed: false,
    reason: "method-forbidden",
  });
});

test("targets deny remote hosts, userinfo, port drift, rebinding, fragments, and encoded separators", () => {
  const value = proof();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ targetUrl: "http://example.com:5173/app" }, "non-loopback-target"],
    [{ targetUrl: "http://user:pass@127.0.0.1:5173/app" }, "credentials-forbidden"],
    [{ targetUrl: "http://127.0.0.1:5174/app" }, "port-drift"],
    [{ resolvedAddresses: ["10.0.0.2"] }, "hostname-rebinding"],
    [{ targetUrl: "http://127.0.0.1:5173/app#secret" }, "path-unproven"],
    [{ targetUrl: "http://127.0.0.1:5173/app%2f..%2fadmin" }, "path-unproven"],
  ];
  for (const [overrides, reason] of cases) {
    assert.deepEqual(httpRequest(value, overrides), { allowed: false, reason });
  }
});

test("a structurally identical forged proof has no authority", () => {
  const value = proof();
  const forged = { ...value } as SourcePreviewTransportProofV1;
  assert.deepEqual(httpRequest(forged), { allowed: false, reason: "unproven-authority" });
  assert.deepEqual(
    authorizeSourcePreviewWebSocketTarget({
      proof: {} as SourcePreviewTransportProofV1,
      targetUrl: "ws://127.0.0.1:5173/hmr",
      protocols: [],
      resolvedAddresses: ["127.0.0.1"],
    }),
    { allowed: false, reason: "unproven-authority" },
  );
});

test("every redirect revalidates both the source and destination against the proof", () => {
  const value = proof();
  const base = {
    proof: value,
    fromUrl: "http://127.0.0.1:5173/app",
    targetUrl: "http://127.0.0.1:5173/app/login",
    status: 302,
    method: "GET" as const,
    headers: { accept: "text/html" },
    credentialsMode: "omit" as const,
    fromResolvedAddresses: ["127.0.0.1"],
    targetResolvedAddresses: ["127.0.0.1"],
  };
  assert.equal(authorizeSourcePreviewHttpRedirect(base).allowed, true);
  assert.deepEqual(
    authorizeSourcePreviewHttpRedirect({ ...base, targetUrl: "http://127.0.0.1:5174/app" }),
    { allowed: false, reason: "port-drift" },
  );
  assert.deepEqual(
    authorizeSourcePreviewHttpRedirect({
      ...base,
      targetResolvedAddresses: ["127.0.0.1", "192.168.1.2"],
    }),
    { allowed: false, reason: "hostname-rebinding" },
  );
  assert.deepEqual(
    authorizeSourcePreviewHttpRedirect({ ...base, fromUrl: "http://127.0.0.1:5173/nope" }),
    { allowed: false, reason: "path-unproven" },
  );
  assert.deepEqual(authorizeSourcePreviewHttpRedirect({ ...base, status: 305 }), {
    allowed: false,
    reason: "redirect-forbidden",
  });
});

test("WebSocket target and upgrade are separately proof-bound", () => {
  const value = proof();
  assert.equal(
    authorizeSourcePreviewWebSocketTarget({
      proof: value,
      targetUrl: "ws://127.0.0.1:5173/hmr?token=opaque",
      protocols: ["vite-hmr"],
      resolvedAddresses: ["127.0.0.1"],
    }).allowed,
    true,
  );
  assert.equal(
    authorizeSourcePreviewWebSocketUpgrade({
      proof: value,
      targetUrl: "ws://127.0.0.1:5173/hmr?token=opaque",
      protocols: ["vite-hmr"],
      headers: websocketHeaders(value),
      resolvedAddresses: ["127.0.0.1"],
    }).allowed,
    true,
  );
});

test("WebSocket authorization denies path, protocol, origin, cookies, rebinding, and port drift", () => {
  const value = proof();
  const base = {
    proof: value,
    targetUrl: "ws://127.0.0.1:5173/hmr?token=opaque",
    protocols: ["vite-hmr"],
    headers: websocketHeaders(value),
    resolvedAddresses: ["127.0.0.1"],
  };
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({
      ...base,
      targetUrl: "ws://127.0.0.1:5173/hmr?token=attacker-controlled",
    }),
    { allowed: false, reason: "query-unproven" },
  );
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({ ...base, targetUrl: "ws://127.0.0.1:5173/admin" }),
    {
      allowed: false,
      reason: "path-unproven",
    },
  );
  assert.deepEqual(authorizeSourcePreviewWebSocketUpgrade({ ...base, protocols: ["graphql-ws"] }), {
    allowed: false,
    reason: "websocket-protocol-forbidden",
  });
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({
      ...base,
      headers: { ...base.headers, origin: "http://127.0.0.1:5174" },
    }),
    { allowed: false, reason: "websocket-upgrade-invalid" },
  );
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({
      ...base,
      headers: { ...base.headers, cookie: "session=secret" },
    }),
    { allowed: false, reason: "header-forbidden" },
  );
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({ ...base, resolvedAddresses: ["10.0.0.2"] }),
    { allowed: false, reason: "hostname-rebinding" },
  );
  assert.deepEqual(
    authorizeSourcePreviewWebSocketUpgrade({
      ...base,
      targetUrl: "ws://127.0.0.1:5174/hmr?token=opaque",
    }),
    { allowed: false, reason: "port-drift" },
  );
});
