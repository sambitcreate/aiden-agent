import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  TailscalePreviewService,
  type TailscalePreviewRecord,
  type TailscalePreviewOptions,
} from "./tailscale-preview-service.js";
const original = () => ({
  TCP: { "443": { HTTPS: true } },
  Web: {
    "mac.tail.ts.net:443": {
      Handlers: {
        "/api/aiden/v1": { Proxy: "http://127.0.0.1:49221/api/aiden/v1" },
        "/other": { Proxy: "http://127.0.0.1:9000" },
      },
    },
  },
  AllowFunnel: { "mac.tail.ts.net:8443": true },
});
function fixture(initial: Record<string, unknown> = original()) {
  let config = structuredClone(initial),
    rows: TailscalePreviewRecord[] = [];
  const calls: string[][] = [];
  let writeFailure = false,
    failAfterApply = false,
    readFailure = false;
  const options: TailscalePreviewOptions = {
    lock: async (action) => action(),
    probe: async () => true,
    store: {
      read: async () => structuredClone(rows),
      write: async (next) => {
        if (writeFailure) throw new Error("disk full");
        rows = structuredClone(next);
      },
    },
    runner: {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "status")
          return JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "mac.tail.ts.net.", Online: true },
            CertDomains: [],
          });
        if (args[1] === "status") {
          if (readFailure) throw new Error("status failed");
          return JSON.stringify(config);
        }
        const number = Number(
          args.find((arg) => arg.startsWith("--http="))?.slice(7),
        );
        assert.ok(Number.isInteger(number));
        assert.ok(args.includes("--set-path=/"));
        const tcp = (config.TCP as Record<string, unknown>) ?? {};
        const web = (config.Web as Record<string, unknown>) ?? {};
        config.TCP = tcp;
        config.Web = web;
        if (args[args.length - 1] === "off") {
          delete tcp[String(number)];
          delete web[`mac.tail.ts.net:${number}`];
        } else {
          tcp[String(number)] = { HTTP: true };
          web[`mac.tail.ts.net:${number}`] = {
            Handlers: { "/": { Proxy: args[args.length - 1] } },
          };
        }
        if (failAfterApply) {
          readFailure = true;
          throw new Error("CLI timed out after mutation");
        }
        return "configured";
      },
    },
  };
  return {
    options,
    service: new TailscalePreviewService(options),
    calls,
    rows: () => rows,
    config: () => config,
    setConfig: (next: Record<string, unknown>) => {
      config = next;
    },
    failWrites: () => {
      writeFailure = true;
    },
    failAfterApply: () => {
      failAfterApply = true;
    },
    restore: () => {
      readFailure = false;
      failAfterApply = false;
    },
  };
}
test("private exact HTTP preview preserves API, other handlers and unrelated Funnel; same workspace reuses", async () => {
  const f = fixture();
  const opened = await f.service.open("workspace", {
    localPort: 3000,
    exposedPort: 8000,
  });
  assert.equal(opened.status, "active");
  assert.equal(opened.url, "http://mac.tail.ts.net:8000/");
  assert.deepEqual(f.config().AllowFunnel, original().AllowFunnel);
  assert.deepEqual(
    (f.config().Web as Record<string, unknown>)["mac.tail.ts.net:443"],
    original().Web["mac.tail.ts.net:443"],
  );
  assert.deepEqual(
    f.calls.find((args) => args.includes("--bg")),
    [
      "serve",
      "--yes",
      "--bg",
      "--http=8000",
      "--set-path=/",
      "http://127.0.0.1:3000",
    ],
  );
  assert.equal(
    (await f.service.open("workspace", { localPort: 3000, exposedPort: 8000 }))
      .id,
    opened.id,
  );
  assert.equal(f.calls.filter((args) => args.includes("--bg")).length, 1);
  await f.service.stop("workspace", { id: opened.id });
  assert.deepEqual(f.config(), original());
  assert.equal(f.rows().length, 0);
});
test("occupied HTTP/TCP/Funnel/foreground ports and noncanonical aliases never mutate", async () => {
  for (const config of [
    { TCP: { "3000": { TCPForward: "127.0.0.1:9000" } } },
    {
      Web: {
        "other.tail.ts.net:3000": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } },
        },
      },
    },
    { AllowFunnel: { "mac.tail.ts.net:3000": true } },
    { Foreground: { session: { TCP: { "3000": { HTTP: true } } } } },
    { TCP: { "03000": { HTTP: true } } },
    { Web: { "mac.tail.ts.net:03000": { Handlers: {} } } },
  ]) {
    const f = fixture(config);
    await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
      code: "conflict",
    });
    assert.equal(
      f.calls.some((args) => args.includes("--bg")),
      false,
    );
  }
});
test("stop requires workspace ownership and exact unchanged live handler", async () => {
  const f = fixture(),
    row = await f.service.open("workspace", { localPort: 3000 });
  await assert.rejects(f.service.stop("other", { id: row.id }), {
    code: "not_found",
  });
  const changed = f.config();
  (changed.Web as Record<string, unknown>)["mac.tail.ts.net:3000"] = {
    Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } },
  };
  await assert.rejects(f.service.stop("workspace", { id: row.id }), {
    code: "conflict",
  });
  assert.equal(
    f.calls.some((args) => args[args.length - 1] === "off"),
    false,
  );
  assert.deepEqual(await f.service.list("other"), []);
  assert.equal((await f.service.list("workspace"))[0]?.status, "changed");
});
test("invalid targets, protected listeners, and unavailable local HTTP servers never create routes", async () => {
  const f = fixture();
  for (const localPort of [0, 443, 65536, 3000.5])
    await assert.rejects(f.service.open("workspace", { localPort }), {
      code: "invalid_request",
    });
  f.options.protectedLocalPorts = async () => [3000];
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
    code: "invalid_request",
  });
  f.options.protectedLocalPorts = async () => [];
  f.options.probe = async () => false;
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
    code: "server_unreachable",
  });
  assert.equal(f.rows().length, 0);
});
test("durable journal failure and revoked async admission prevent CLI effect", async () => {
  const f = fixture();
  f.failWrites();
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }));
  assert.equal(
    f.calls.some((args) => args.includes("--bg")),
    false,
  );
  const other = fixture();
  let checks = 0;
  await assert.rejects(
    other.service.open("workspace", { localPort: 3000 }, async () => {
      if (++checks === 3) throw new Error("revoked");
    }),
  );
  assert.equal(
    other.calls.some((args) => args.includes("--bg")),
    false,
  );
});
test("unknown outcome keeps durable proof; restarted service can inspect and stop exact route", async () => {
  const f = fixture();
  f.failAfterApply();
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
    code: "outcome_unknown",
  });
  assert.equal(f.rows()[0]?.phase, "opening");
  f.restore();
  const restarted = new TailscalePreviewService(f.options);
  const records = await restarted.list("workspace");
  assert.equal(records[0]?.status, "active");
  await restarted.stop("workspace", { id: records[0]!.id });
  assert.deepEqual(f.config(), original());
  assert.deepEqual(f.rows(), []);
});
test("external configuration change after journal commit is detected before mutation", async () => {
  const f = fixture();
  const write = f.options.store.write;
  f.options.store.write = async (rows) => {
    await write(rows);
    f.setConfig({ ...f.config(), TCP: { "3000": { HTTP: true } } });
  };
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
    code: "conflict",
  });
  assert.equal(
    f.calls.some((args) => args.includes("--bg")),
    false,
  );
});

test("real localhost probe uses bounded credential-free HEAD and does not follow redirects", async () => {
  const requests: Array<{
    method?: string;
    authorization?: string;
    url?: string;
  }> = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method,
      authorization: req.headers.authorization,
      url: req.url,
    });
    res.writeHead(302, { location: "http://127.0.0.1:1/must-not-follow" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const f = fixture();
    delete f.options.probe;
    const preview = await f.service.open("workspace", {
      localPort: (server.address() as AddressInfo).port,
      exposedPort: 8300,
    });
    assert.equal(preview.status, "active");
    assert.deepEqual(requests, [
      { method: "HEAD", authorization: undefined, url: "/" },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("protected listener policy also excludes exposed ports and previously configured previews", async () => {
  const f = fixture();
  const old = await f.service.open("workspace", { localPort: 3000 });
  f.options.protectedLocalPorts = async () => [3000];
  await assert.rejects(f.service.open("workspace", { localPort: 3000 }), {
    code: "invalid_request",
  });
  await assert.rejects(
    f.service.open("workspace", { localPort: 4000, exposedPort: 3000 }),
    { code: "invalid_request" },
  );
  await f.service.stop("workspace", { id: old.id });
});
