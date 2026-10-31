import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const api = await import("../dist/parity-test-api.js");

const linux = { platform: "linux", uid: 1000, user: "sam" };

/** A tailscale CLI that answers status, Serve status and prefs from fixtures. */
function tailscaleRunner({ backend = "Running", online = true, dnsName = "box.tail1234.ts.net.", certDomains = ["box.tail1234.ts.net"], funnel = {}, prefs = { OperatorUser: "sam" } } = {}) {
  return {
    async run(args) {
      if (args[0] === "status") return JSON.stringify({ BackendState: backend, Self: { Online: online, ...(dnsName ? { DNSName: dnsName } : {}) }, CertDomains: certDomains });
      if (args[0] === "serve") return JSON.stringify({ AllowFunnel: funnel });
      if (args[0] === "debug" && prefs instanceof Error) throw prefs;
      if (args[0] === "debug") return JSON.stringify(prefs);
      throw new Error(`unexpected tailscale ${args.join(" ")}`);
    },
  };
}

test("a signed-in tailnet with HTTPS certificates is ready, and the install question suggests both networks", async () => {
  const facts = await api.readTailscaleFacts(tailscaleRunner(), linux);
  assert.deepEqual(facts, { installed: true, signedIn: true, dnsName: "box.tail1234.ts.net", httpsCertificates: true, funnelOn443: false, operatorNeeded: false, exitNodeWithoutLan: false });
  const question = api.networkQuestion(facts, false, "linux");
  assert.equal(question.recommended, "both");
  assert.match(question.text, /Tailscale: ready as box\.tail1234\.ts\.net\./);
  assert.ok(api.tailscaleChecklist(facts, "linux").every((item) => item.state === "ok"));
});

test("each missing Tailscale step is named with its own fix, and the install question falls back to the local network", async () => {
  const cases = [
    [null, /not installed.*tailscale\.com\/download/],
    [tailscaleRunner({ backend: "NeedsLogin", online: false }), /not signed in.*sudo tailscale up/],
    [tailscaleRunner({ certDomains: [] }), /HTTPS certificates are off.*login\.tailscale\.com\/admin\/dns/],
    [tailscaleRunner({ prefs: { OperatorUser: "" } }), /sudo tailscale set --operator=\$USER/],
    [tailscaleRunner({ funnel: { "box.tail1234.ts.net:443": true } }), /Funnel is on for HTTPS port 443/],
  ];
  for (const [runner, fix] of cases) {
    const facts = await api.readTailscaleFacts(runner, linux);
    assert.equal(api.tailscaleReady(facts), false, String(fix));
    assert.equal(api.recommendNetwork(facts, false), "local");
    const failed = api.tailscaleChecklist(facts, "linux").filter((item) => item.state === "fail");
    assert.equal(failed.length, 1, `only the step that is missing fails: ${fix}`);
    assert.match(failed[0].text, fix);
    assert.match(api.networkQuestion(facts, false, "linux").text, fix);
  }
});

test("the operator step is a Linux non-root concern, and unreadable settings are not reported as a failure", async () => {
  assert.equal((await api.readTailscaleFacts(tailscaleRunner({ prefs: { OperatorUser: "" } }), { ...linux, uid: 0, user: "root" })).operatorNeeded, false);
  assert.equal((await api.readTailscaleFacts(tailscaleRunner({ prefs: { OperatorUser: "" } }), { platform: "darwin", uid: 501, user: "sam" })).operatorNeeded, undefined);
  const unreadable = await api.readTailscaleFacts(tailscaleRunner({ prefs: new Error("access denied") }), linux);
  assert.equal(unreadable.operatorNeeded, undefined);
  assert.equal(api.tailscaleReady(unreadable), true);
  assert.match(api.tailscaleChecklist({ ...unreadable, signedIn: false }, "darwin").at(-1).text, /Open the Tailscale app and sign in/);
});

test("an exit node without local network access is a warning, not a failure", async () => {
  const facts = await api.readTailscaleFacts(tailscaleRunner({ prefs: { OperatorUser: "sam", ExitNodeID: "nExit1", ExitNodeAllowLANAccess: false } }), linux);
  assert.equal(api.tailscaleReady(facts), true);
  const items = api.tailscaleChecklist(facts, "linux");
  assert.equal(items.at(-1).state, "warn");
  assert.match(items.at(-1).text, /exit-node-allow-lan-access/);
  const allowed = await api.readTailscaleFacts(tailscaleRunner({ prefs: { OperatorUser: "sam", ExitNodeID: "nExit1", ExitNodeAllowLANAccess: true } }), linux);
  assert.equal(allowed.exitNodeWithoutLan, false);
});

test("a cloud server is pointed at Tailscale, even before Tailscale is set up", async () => {
  const ready = await api.readTailscaleFacts(tailscaleRunner(), linux);
  const missing = await api.readTailscaleFacts(null, linux);
  for (const facts of [ready, missing]) {
    const question = api.networkQuestion(facts, true, "linux");
    assert.equal(question.recommended, "tailscale");
    assert.match(question.text, /cloud server/);
  }
  const lan = api.serverChecklist({ connectionMode: "lan", lanEndpoint: "https://box.local:49320/api/aiden/v1", tailscaleConnected: false }, missing, true);
  assert.deepEqual(lan.map((item) => item.state), ["ok", "warn", "off"]);
  assert.match(lan[1].text, /aiden remote network tailscale/);
});

test("the cloud check answers yes only when the metadata address accepts a connection", async () => {
  const listener = createNetServer((socket) => socket.end());
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  const { connect } = await import("node:net");
  try {
    assert.equal(await api.looksLikeCloudServer(300, (options) => connect({ ...options, host: "127.0.0.1", port })), true);
    const closed = createNetServer();
    closed.listen(0, "127.0.0.1");
    await once(closed, "listening");
    const closedPort = closed.address().port;
    closed.close();
    await once(closed, "close");
    assert.equal(await api.looksLikeCloudServer(300, (options) => connect({ ...options, host: "127.0.0.1", port: closedPort })), false);
  } finally {
    listener.close();
  }
});

test("the server checklist reports the Tailscale route and whether its address answered", async () => {
  const facts = await api.readTailscaleFacts(tailscaleRunner(), linux);
  const endpoint = "https://box.tail1234.ts.net/api/aiden/v1";
  const connected = { connectionMode: "both", lanEndpoint: "https://box.local:49320/api/aiden/v1", tailscaleEndpoint: endpoint, tailscaleConnected: true };
  assert.deepEqual(api.serverChecklist(connected, facts, false, true).map((item) => item.state), ["ok", "ok", "ok"]);
  const silent = api.serverChecklist(connected, facts, false, false).at(-1);
  assert.equal(silent.state, "fail");
  assert.match(silent.text, /did not answer.*HTTPS certificate/);
  const denied = api.serverChecklist({ connectionMode: "tailscale", tailscaleConnected: false, tailscaleErrorCode: "permission_denied" }, facts, false);
  assert.deepEqual(denied.map((item) => item.state), ["off", "fail"]);
  assert.match(denied[1].text, /sudo tailscale set --operator/);
  assert.match(api.serverChecklist({ connectionMode: "lan", lanEndpoint: "https://box.local:49320/api/aiden/v1" }, facts, false).at(-1).text, /ready.*aiden remote network both/);
  assert.match(api.serverChecklist(undefined, facts, false)[0].text, /not running/);
});

/** A control socket that answers like a running server and records what it was asked. */
async function fakeDaemon(answer) {
  const dir = mkdtempSync(join(tmpdir(), "aiden-reach-"));
  const asked = [];
  const server = createNetServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const { command, args } = JSON.parse(buffer);
      asked.push([command, ...args].join(" "));
      const result = answer(command, args);
      socket.end(JSON.stringify(result instanceof Error ? { error: result.message } : { result }) + "\n");
    });
  });
  server.listen(join(dir, "serve.sock"));
  await once(server, "listening");
  return { dir, asked, close: () => { server.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function sink() {
  const stream = { text: "", write(chunk) { stream.text += chunk; return true; } };
  return stream;
}

test("remote check prints both sections and fails when the Tailscale address does not answer", async () => {
  const endpoint = "https://box.tail1234.ts.net/api/aiden/v1";
  const daemon = await fakeDaemon(() => ({ connectionMode: "tailscale", tailscaleEndpoint: endpoint, tailscaleConnected: true }));
  const probed = [];
  try {
    for (const answers of [true, false]) {
      const out = sink();
      const passed = await api.remoteCheckCommand(daemon.dir, { runner: tailscaleRunner(), host: linux, cloud: async () => false, probe: async (value) => { probed.push(value); return answers; }, out });
      assert.equal(passed, answers);
      assert.match(out.text, /^Tailscale on this machine\n {2}✓ Tailscale is installed\n/);
      assert.match(out.text, /\n\nAiden server\n {2}– Local network: off/);
      assert.match(out.text, answers ? /✓ https:\/\/box\.tail1234\.ts\.net\/api\/aiden\/v1 answers/ : /✗ https:\/\/box\.tail1234\.ts\.net\/api\/aiden\/v1 did not answer/);
    }
    assert.deepEqual(probed, [endpoint, endpoint]);
  } finally {
    daemon.close();
  }
  const localOnly = await fakeDaemon(() => ({ connectionMode: "lan", lanEndpoint: "https://box.local:49320/api/aiden/v1", tailscaleConnected: false }));
  try {
    const out = sink();
    assert.equal(await api.remoteCheckCommand(localOnly.dir, { runner: null, host: linux, cloud: async () => false, out }), true, "a local-network server does not fail for a missing Tailscale");
    assert.match(out.text, /– Tailscale is not installed/);
  } finally {
    localOnly.close();
  }
});

test("Tailscale pairing warms the address before the window opens, and says so when it does not answer", async () => {
  const endpoint = "https://box.tail1234.ts.net/api/aiden/v1";
  const pairing = { sessionId: "pairing_test", qrPayload: "aiden-pair:test", manualCode: "ABCD-1234", bootstrap: { expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  const daemon = await fakeDaemon((command, args) => {
    if (args[0] === "pair") return pairing;
    if (args[0] === "status" || args[0] === "tailscale-prepare") return { connectionMode: "tailscale", tailscaleEndpoint: endpoint, tailscaleConnected: true };
    return { sessionId: "pairing_test", state: "failed" };
  });
  try {
    for (const answers of [true, false]) {
      daemon.asked.length = 0;
      const out = sink(), err = sink();
      let pairedBeforeWait;
      await api.showStartupPairing(daemon.dir, "tailscale", new AbortController().signal, out, err, async (value) => {
        assert.equal(value, endpoint);
        pairedBeforeWait = daemon.asked.includes("remote pair tailscale");
        return answers;
      });
      // Pairing reads the address's certificate with a short timeout, so the slow first request must come first.
      assert.equal(pairedBeforeWait, false);
      assert.deepEqual(daemon.asked.slice(0, 3), ["remote tailscale-prepare", "remote status", "remote pair tailscale"]);
      assert.match(out.text, /Checking that https:\/\/box\.tail1234\.ts\.net\/api\/aiden\/v1 answers[^]*Manual code: ABCD-1234/);
      if (answers) assert.doesNotMatch(err.text, /did not answer/);
      else assert.match(err.text, /did not answer yet.*aiden remote check/);
    }
  } finally {
    daemon.close();
  }
});

test("a Tailscale setup problem found while preparing opens no pairing window and names the fix", async () => {
  const daemon = await fakeDaemon((command, args) => args[0] === "tailscale-prepare" ? new Error("Tailscale is not signed in. Run `sudo tailscale up`, then `aiden remote pair tailscale`") : new Error(`unexpected ${args.join(" ")}`));
  const out = sink(), err = sink();
  try {
    await api.showStartupPairing(daemon.dir, "tailscale", new AbortController().signal, out, err, async () => assert.fail("nothing to wait for"));
    assert.deepEqual(daemon.asked, ["remote tailscale-prepare"]);
    assert.match(err.text, /Could not open a Tailscale pairing window\. Tailscale is not signed in.*sudo tailscale up/);
    assert.equal(out.text, "");
  } finally {
    daemon.close();
  }
});

test("waiting for the Tailscale address retries until it answers or the time runs out", async () => {
  let calls = 0;
  assert.equal(await api.waitForTailscaleAddress("https://x/api/aiden/v1", new AbortController().signal, 10_000, async () => ++calls === 3), true);
  assert.equal(calls, 3);
  const started = Date.now();
  assert.equal(await api.waitForTailscaleAddress("https://x/api/aiden/v1", new AbortController().signal, 1_500, async () => false), false);
  assert.ok(Date.now() - started < 5_000);
});

test("stopping the server ends a Tailscale check that is still waiting on the address", async (t) => {
  // Accepts the connection but never answers the TLS handshake, like a Serve name whose certificate is still on its way.
  const sockets = new Set();
  const silent = createNetServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  silent.listen(0, "127.0.0.1");
  await once(silent, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); silent.close(); });
  const endpoint = `https://127.0.0.1:${silent.address().port}/api/aiden/v1`;

  const stop = new AbortController();
  setTimeout(() => stop.abort(), 100);
  let started = Date.now();
  assert.equal(await api.waitForTailscaleAddress(endpoint, stop.signal, 30_000), false);
  assert.ok(Date.now() - started < 2_000, `a probe in flight ends with the stop, took ${Date.now() - started}ms`);

  let probes = 0;
  const pausing = new AbortController();
  setTimeout(() => pausing.abort(), 100);
  started = Date.now();
  assert.equal(await api.waitForTailscaleAddress(endpoint, pausing.signal, 30_000, async () => { probes += 1; return false; }), false);
  assert.ok(Date.now() - started < 600, `the pause between tries ends with the stop, took ${Date.now() - started}ms`);
  assert.equal(probes, 1, "no try after the stop");
});

test("the health probe accepts only Aiden's own answer over HTTPS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aiden-reach-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-days", "1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  } catch {
    t.skip("openssl is not available");
    return;
  }
  const cert = readFileSync(join(dir, "cert.pem"));
  let body = JSON.stringify({ ok: true, protocolVersion: 1 });
  const server = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert }, (request, response) => {
    if (request.url !== "/api/aiden/v1/health") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "application/json" }).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const endpoint = `https://localhost:${server.address().port}/api/aiden/v1`;
  assert.equal(await api.probeAidenHealth(endpoint, 5_000, { ca: cert }), true);
  assert.equal(await api.probeAidenHealth(endpoint, 5_000), false, "an untrusted certificate is not Aiden");
  body = "<html>Bad gateway</html>";
  assert.equal(await api.probeAidenHealth(endpoint, 5_000, { ca: cert }), false);
});

test("uninstall takes down Aiden's Tailscale route only when it is connected", async () => {
  let connected = true;
  const daemon = await fakeDaemon((command, args) => {
    if (args[0] === "status") return { tailscaleConnected: connected };
    if (args[0] === "tailscale-disconnect") { connected = false; return { tailscaleConnected: false }; }
    return new Error("unexpected");
  });
  try {
    assert.match(await api.releaseTailscaleRoute(daemon.dir), /Removed Aiden's Tailscale route/);
    assert.equal(await api.releaseTailscaleRoute(daemon.dir), undefined);
    assert.deepEqual(daemon.asked, ["remote status", "remote tailscale-disconnect", "remote status"]);
  } finally {
    daemon.close();
  }
  assert.equal(await api.releaseTailscaleRoute(mkdtempSync(join(tmpdir(), "aiden-reach-none-"))), undefined, "no running server, nothing to remove");
});
