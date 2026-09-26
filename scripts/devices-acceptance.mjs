/* global Buffer, console, fetch, process */
// Manual Phase 2 acceptance for the experimental Simulator tab on a real Mac
// with Xcode. It runs the production device service outside Electron:
// consent → npm install of the pinned hub → hub start → simctl listing →
// boot and attach one simulator → a screenshot and proxied reads → stop.
//
// It contacts the npm registry, so it refuses to run without
// `--allow-npm-install`. Tools install into a temporary folder unless
// `--base-dir <path>` is given. Simulators it boots are left running unless
// `--shutdown` is given.
//
//   node --import tsx scripts/devices-acceptance.mjs --allow-npm-install [--udid <udid>] [--shutdown]
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startDeviceHubProxy } from "../main/services/devices/device-hub-proxy.ts";
import { createDeviceService } from "../main/services/devices/device-service.ts";
import {
  createNpmRunner,
  defaultNpmResolutionDeps,
  resolveNpm,
} from "../main/services/devices/device-toolchain.ts";
import {
  createLocalDeviceHost,
  defaultLocalDeviceHostDeps,
} from "../main/services/devices/local-device-host.ts";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

if (process.platform !== "darwin") {
  console.error("Simulator acceptance needs macOS with Xcode.");
  process.exit(2);
}
if (!args.includes("--allow-npm-install")) {
  console.error("This installs expo-device-hub from npm. Re-run with --allow-npm-install to consent.");
  process.exit(2);
}

const explicitBaseDir = option("--base-dir");
const baseDir = explicitBaseDir ?? (await mkdtemp(path.join(os.tmpdir(), "aiden-devices-acceptance-")));
const started = Date.now();
const step = (message) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const check = (condition, message) => {
  if (!condition) throw new Error(`Acceptance failed: ${message}`);
  step(`✓ ${message}`);
};

const host = createLocalDeviceHost(
  defaultLocalDeviceHostDeps({
    baseDir,
    resolveNpmRunner: async () => {
      const npm = await resolveNpm(defaultNpmResolutionDeps);
      return npm ? createNpmRunner(npm) : null;
    },
  }),
);
const service = createDeviceService({
  baseDir,
  host,
  startProxy: (resolveHub) => startDeviceHubProxy({ resolveHub, allowedOrigins: ["file://"] }),
  fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
});
service.onState((state) => {
  const detail = state.hostStatuses.local?.detail;
  step(`state: ${state.hostStatus}${detail ? ` (${detail})` : ""}`);
});

let exitCode = 0;
try {
  step(`tools folder: ${baseDir}`);
  const initial = await service.load();
  check(initial.hostStatus !== "ready", "loading does not start the hub");

  const ready = await service.grantConsent("streaming");
  if (ready.hostStatus !== "ready") {
    throw new Error(`Host did not become ready: ${ready.unavailableReason ?? ready.hostStatuses.local?.detail}`);
  }
  check(ready.devices.length > 0, `simctl listed ${ready.devices.length} iOS simulators`);

  const udid = option("--udid");
  const device =
    (udid && ready.devices.find((entry) => entry.id === udid)) ||
    ready.devices.find((entry) => entry.booted) ||
    ready.devices.find((entry) => entry.kind === "iphone") ||
    ready.devices[0];
  step(`using ${device.name} (${device.version}, ${device.id}${device.booted ? ", booted" : ""})`);

  const session = await service.open({ chatId: "acceptance", deviceId: device.id, openedBy: "user" });
  check(session.deviceId === device.id, "boot and stream helper attach succeeded");

  const png = await service.screenshot({ hostId: device.hostId, deviceId: device.id });
  check(png.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), `screenshot is a PNG (${png.length} bytes)`);
  const screenshotPath = path.join(os.tmpdir(), `aiden-devices-acceptance-${Date.now()}.png`);
  await writeFile(screenshotPath, png);
  step(`screenshot saved to ${screenshotPath}`);

  const grant = await service.streamGrant();
  const proxied = (pathname, init) => fetch(`${grant.origin}${pathname}`, { ...init, redirect: "error" });
  check((await proxied("/api/devices")).status === 401, "proxy refuses a request without a grant");
  check((await proxied(`/api/exec?t=${grant.token}`, { method: "POST" })).status === 404, "proxy never exposes exec");
  const listing = await proxied(`/api/devices?t=${grant.token}`, { headers: { origin: "file://" } });
  check(listing.ok, "proxy serves the hub device list with a grant");
  check(listing.headers.get("access-control-allow-origin") === "file://", "proxy answers the packaged renderer origin");
  const config = await proxied(`/vendor/serve-sim/helper/${device.id}/config?t=${grant.token}`);
  check(config.ok, "proxy reaches the stream helper for the device");

  await service.close({
    chatId: "acceptance",
    hostId: device.hostId,
    deviceId: device.id,
    shutdown: args.includes("--shutdown"),
  });
  check(service.sessionsForChat("acceptance").length === 0, "session closed");
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  await service.stop();
  step("helpers stopped");
  if (!explicitBaseDir) await rm(baseDir, { recursive: true, force: true });
}
process.exit(exitCode);
