import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SOURCE_PREVIEW_MAX_REDIRECT_HOPS,
  createVitePreviewTransportProof,
  detectSourcePreviewScripts,
  fetchProvenSourcePreview,
  extractViteHmrToken,
  injectSourceDesignerScripts,
  sourcePreviewHeaderAuthorized,
  sourcePreviewIngressAuthorized,
  sourceDesignPreviewService,
} from "./source-design-preview.js";

test("preview HTTP ingress requires loopback, exact Host and Origin, plus an exact capability header", () => {
  assert.equal(
    sourcePreviewIngressAuthorized({
      remoteAddress: "127.0.0.1",
      host: "127.0.0.1:44001",
      origin: "http://127.0.0.1:44001",
      proxyPort: 44001,
    }),
    true,
  );
  assert.equal(
    sourcePreviewIngressAuthorized({
      remoteAddress: "127.0.0.1",
      host: "attacker.example",
      proxyPort: 44001,
    }),
    false,
  );
  assert.equal(
    sourcePreviewIngressAuthorized({
      remoteAddress: "10.0.0.8",
      host: "127.0.0.1:44001",
      proxyPort: 44001,
    }),
    false,
  );
  assert.equal(
    sourcePreviewIngressAuthorized({
      remoteAddress: "::1",
      host: "127.0.0.1:44001",
      origin: "https://attacker.example",
      proxyPort: 44001,
    }),
    false,
  );
  const capability = "s".repeat(32);
  assert.equal(sourcePreviewHeaderAuthorized(capability, capability), true);
  assert.equal(sourcePreviewHeaderAuthorized("wrong", capability), false);
  assert.equal(sourcePreviewHeaderAuthorized([capability], capability), false);
});

function previewProof() {
  return createVitePreviewTransportProof(5_173, "preview_test_session_01");
}

function sequenceFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected test fetch.");
    return response();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("detects only explicit Vite development scripts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-source-preview-"));
  try {
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "vite",
          storybook: "vite --config storybook.config.ts",
          build: "vite build",
          unsafe: "next dev",
        },
      }),
    );
    assert.deepEqual(await detectSourcePreviewScripts(root), [
      {
        id: "dev",
        label: "Development app",
        command: "pnpm run dev -- --host 127.0.0.1 --port <port> --strictPort",
      },
      {
        id: "storybook",
        label: "storybook",
        command: "pnpm run storybook -- --host 127.0.0.1 --port <port> --strictPort",
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exposes a detected Next.js runtime as a fixed-loopback preview script", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-source-next-preview-"));
  try {
    await fs.mkdir(path.join(root, "app"));
    await fs.writeFile(path.join(root, "app", "page.tsx"), "export default function Page() {}\n");
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev --webpack" }, dependencies: { next: "15.4.1" } }),
    );
    assert.deepEqual(await detectSourcePreviewScripts(root), [
      {
        id: "dev",
        label: "Next.js development app",
        command: "npm run dev -- --hostname 127.0.0.1 --port <port>",
      },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("injects the exact-selection bridge before the closing body", () => {
  const html = injectSourceDesignerScripts("<!doctype html><body><main>App</main></body>");
  assert.match(html, /__aiden_design__\/react-grab\.js/u);
  assert.match(html, /__aiden_design__\/bridge\.js/u);
  assert.ok(html.indexOf("bridge.js") < html.indexOf("</body>"));
});

test("ordinary Vite requests and same-origin redirects use manual credential-free fetches", async () => {
  const sequence = sequenceFetch([
    () => new Response(null, { status: 302, headers: { location: "/app/" } }),
    () => new Response(null, { status: 307, headers: { location: "index.html" } }),
    () => new Response("<!doctype html><main>Ready</main>", { status: 200 }),
  ]);
  const response = await fetchProvenSourcePreview({
    proof: previewProof(),
    targetUrl: "http://127.0.0.1:5173/",
    method: "GET",
    signal: AbortSignal.timeout(1_000),
    fetchImpl: sequence.fetchImpl,
  });
  assert.equal(await response.text(), "<!doctype html><main>Ready</main>");
  assert.deepEqual(
    sequence.calls.map((call) => call.url),
    [
      "http://127.0.0.1:5173/",
      "http://127.0.0.1:5173/app/",
      "http://127.0.0.1:5173/app/index.html",
    ],
  );
  for (const call of sequence.calls) {
    assert.equal(call.init?.redirect, "manual");
    assert.equal(call.init?.credentials, "omit");
  }
});

test("a redirect cannot escape to another host", async () => {
  const sequence = sequenceFetch([
    () => new Response(null, { status: 302, headers: { location: "http://example.com/app" } }),
  ]);
  await assert.rejects(
    fetchProvenSourcePreview({
      proof: previewProof(),
      targetUrl: "http://127.0.0.1:5173/",
      method: "GET",
      signal: AbortSignal.timeout(1_000),
      fetchImpl: sequence.fetchImpl,
    }),
    /redirected outside its approved loopback target/u,
  );
  assert.equal(sequence.calls.length, 1);
});

test("a redirect cannot drift to another port", async () => {
  const sequence = sequenceFetch([
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:5174/app" },
      }),
  ]);
  await assert.rejects(
    fetchProvenSourcePreview({
      proof: previewProof(),
      targetUrl: "http://127.0.0.1:5173/",
      method: "GET",
      signal: AbortSignal.timeout(1_000),
      fetchImpl: sequence.fetchImpl,
    }),
    /redirected outside its approved loopback target/u,
  );
  assert.equal(sequence.calls.length, 1);
});

test("redirect loops fail before issuing a repeated request", async () => {
  const sequence = sequenceFetch([
    () => new Response(null, { status: 302, headers: { location: "/b" } }),
    () => new Response(null, { status: 302, headers: { location: "/a" } }),
  ]);
  await assert.rejects(
    fetchProvenSourcePreview({
      proof: previewProof(),
      targetUrl: "http://127.0.0.1:5173/a",
      method: "GET",
      signal: AbortSignal.timeout(1_000),
      fetchImpl: sequence.fetchImpl,
    }),
    /entered a redirect loop/u,
  );
  assert.equal(sequence.calls.length, 2);
});

test("redirect chains are bounded", async () => {
  let redirectIndex = 0;
  const redirects = Array.from({ length: SOURCE_PREVIEW_MAX_REDIRECT_HOPS + 1 }, () => () => {
    redirectIndex += 1;
    return new Response(null, {
      status: 302,
      headers: { location: `/hop-${redirectIndex}` },
    });
  });
  const sequence = sequenceFetch(redirects);
  await assert.rejects(
    fetchProvenSourcePreview({
      proof: previewProof(),
      targetUrl: "http://127.0.0.1:5173/hop-0",
      method: "GET",
      signal: AbortSignal.timeout(1_000),
      fetchImpl: sequence.fetchImpl,
    }),
    /exceeded its redirect limit/u,
  );
  assert.equal(sequence.calls.length, SOURCE_PREVIEW_MAX_REDIRECT_HOPS + 1);
});

test("the Vite proof allows common transform queries and enables HMR only after exact token proof", async () => {
  const sequence = sequenceFetch([() => new Response("export default 1", { status: 200 })]);
  const proof = previewProof();
  const response = await fetchProvenSourcePreview({
    proof,
    targetUrl: "http://127.0.0.1:5173/src/main.ts?t=123&import=",
    method: "GET",
    signal: AbortSignal.timeout(1_000),
    fetchImpl: sequence.fetchImpl,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(proof.allowedWebSocketPathPrefixes, ["/__aiden_hmr_pending__"]);
  assert.deepEqual(proof.allowedWebSocketProtocols, []);
  assert.equal(extractViteHmrToken('const wsToken = "exact-token";'), "exact-token");
  assert.equal(extractViteHmrToken('const wsToken = "bad\\nvalue";'), undefined);
  assert.equal(extractViteHmrToken("const other = 'not-authority';"), undefined);
  const enabled = createVitePreviewTransportProof(5_173, "preview_test_session_01", "exact-token");
  assert.deepEqual(enabled.allowedWebSocketPathPrefixes, ["/"]);
  assert.deepEqual(enabled.allowedWebSocketProtocols, ["vite-hmr", "vite-ping"]);
  assert.equal(enabled.webSocketQueryValueHashes.token.length, 64);
});

test("application shutdown waits until the owned preview process group is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiden-source-preview-shutdown-"));
  const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
  try {
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" }, dependencies: {} }),
    );
    await fs.writeFile(path.join(root, "index.html"), "<!doctype html><main>Ready</main>");
    await fs.symlink(path.join(repositoryRoot, "node_modules"), path.join(root, "node_modules"));
    const controller = new AbortController();
    const owner = {
      id: 1,
      documentId: "source-preview-shutdown-test",
      isDestroyed: () => false,
      send: () => undefined,
      onInvalidated: () => () => undefined,
    };
    const state = await sourceDesignPreviewService.start({
      owner,
      admission: {
        signal: controller.signal,
        cancel: (reason) => controller.abort(reason),
        release: () => undefined,
      },
      workspaceId: "source-preview-shutdown-workspace",
      root,
      scriptId: "dev",
    });
    assert.equal(state.status, "running");
    const sessions = (
      sourceDesignPreviewService as unknown as {
        sessions: Map<string, { child: { pid?: number } }>;
      }
    ).sessions;
    const pid = [...sessions.values()][0]?.child.pid;
    assert.ok(pid);
    await sourceDesignPreviewService.shutdown();
    assert.equal(sessions.size, 0);
    let processGroupExists = true;
    try {
      process.kill(-pid, 0);
    } catch (error) {
      processGroupExists = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    assert.equal(processGroupExists, false);
  } finally {
    await sourceDesignPreviewService.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
