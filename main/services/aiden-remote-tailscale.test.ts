import assert from "node:assert/strict";
import test from "node:test";
import {
  AidenRemoteTailscaleController,
  type AidenTailscaleCommandRunner,
} from "./aiden-remote-tailscale.js";

const target = "http://127.0.0.1:43177/api/aiden/v1";

function fixture(options: { emptyServeStatus?: boolean; certDomains?: unknown } = {}) {
  const calls: string[][] = [];
  let connected = false;
  const runner: AidenTailscaleCommandRunner = {
    run: async (args) => {
      calls.push([...args]);
      if (args[0] === "status") {
        return JSON.stringify({
          Self: { DNSName: "aiden.tailnet.ts.net." },
          CertDomains: options.certDomains ?? ["aiden.tailnet.ts.net"],
        });
      }
      if (args[0] === "serve" && args[1] === "status") {
        if (options.emptyServeStatus && !connected) return "{}";
        return JSON.stringify({
          TCP: { "443": { HTTPS: true } },
          Web: {
            "aiden.tailnet.ts.net:443": {
              Handlers: connected
                ? { "/api/aiden/v1": { Proxy: target }, "/other": { Proxy: "http://127.0.0.1:9" } }
                : { "/other": { Proxy: "http://127.0.0.1:9" } },
            },
          },
        });
      }
      if (args.includes("off")) connected = false;
      else connected = true;
      return "";
    },
  };
  return { controller: new AidenRemoteTailscaleController(runner), calls };
}

test("Tailscale controller connects and verifies only Aiden's route", async () => {
  const app = fixture();
  const ownership = await app.controller.connect(target);
  assert.deepEqual(ownership, { path: "/api/aiden/v1", target });
  assert.deepEqual(app.calls.find((args) => args.includes("--set-path=/api/aiden/v1") && !args.includes("off")), [
    "serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", target,
  ]);
  assert.equal(app.calls.some((args) => args.includes("reset")), false);
  assert.equal(app.calls.some((args) => args.includes("funnel")), false);

  await app.controller.disconnect(target, ownership);
  assert.deepEqual(app.calls[app.calls.length - 2], [
    "serve", "--https=443", "--set-path=/api/aiden/v1", "off",
  ]);
});

test("Tailscale controller reports stable URL identity without mutating configuration", async () => {
  const app = fixture();
  assert.deepEqual(await app.controller.status(), {
    installed: true,
    dnsName: "aiden.tailnet.ts.net",
    httpsAvailable: true,
    serveStatus: {
      TCP: { "443": { HTTPS: true } },
      Web: {
        "aiden.tailnet.ts.net:443": {
          Handlers: { "/other": { Proxy: "http://127.0.0.1:9" } },
        },
      },
    },
  });
  assert.equal(app.calls.length, 2);
});

test("Tailscale controller creates the first HTTPS listener only after exact certificate-domain proof", async () => {
  const app = fixture({ emptyServeStatus: true });
  const ownership = await app.controller.connect(target);
  assert.deepEqual(ownership, { path: "/api/aiden/v1", target });
  assert.deepEqual(app.calls.find((args) => args.includes("--set-path=/api/aiden/v1") && !args.includes("off")), [
    "serve", "--yes", "--bg", "--https=443", "--set-path=/api/aiden/v1", target,
  ]);
});

test("Tailscale controller refuses first-listener mutation without exact HTTPS eligibility", async () => {
  for (const certDomains of [[], ["other.tailnet.ts.net"], ["aiden.tailnet.ts.net.evil"]]) {
    const app = fixture({ emptyServeStatus: true, certDomains });
    await assert.rejects(app.controller.connect(target), /tailscale_https_unavailable/u);
    assert.equal(app.calls.some((args) => args.includes("--set-path=/api/aiden/v1")), false);
  }
});

test("missing Tailscale is explicit and cannot mutate routes", async () => {
  const controller = new AidenRemoteTailscaleController(null);
  assert.deepEqual(await controller.status(), {
    installed: false,
    errorCode: "not_installed",
  });
  await assert.rejects(controller.connect(target), /tailscale_not_installed/u);
});
