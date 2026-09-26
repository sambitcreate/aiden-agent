import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceActionInput } from "../../../renderer/shared/devices.js";
import type { DeviceHostReady } from "./device-host.js";
import {
  DeviceActionUnavailableError,
  iosActionCommand,
  readDeviceSettings,
  runDeviceAction,
  textSizeFromIos,
} from "./device-actions.js";

const target = { hostId: "local", deviceId: "UDID-1" };

const AX = "/tools/serve-sim/dist/simax/serve-sim-ax-settings";
const CLI = "/tools/serve-sim/dist/serve-sim.js";
const helpers = { axSettings: AX, serveSimCli: CLI };

interface Call {
  command: string;
  args: string[];
  options: { stdin?: string; env?: Record<string, string> } | undefined;
}

function fakeReady(
  respond: (args: string[]) => { stdout?: string; stderr?: string; code?: number } | Error,
  withHelpers: DeviceHostReady["helpers"] = helpers,
): DeviceHostReady & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    nodePath: "/node",
    hub: { origin: "http://127.0.0.1:1" },
    helpers: withHelpers,
    async run(command: string, args: string[], options?: Call["options"]) {
      calls.push({ command, args, options });
      const result = respond(args);
      if (result instanceof Error) throw result;
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
    },
  } as unknown as DeviceHostReady & { calls: Call[] };
}

test("each simctl action is one argv with the UDID after the verb", () => {
  const cases: Array<[DeviceActionInput, string[]]> = [
    [{ ...target, type: "setAppearance", value: "dark" }, ["simctl", "ui", "UDID-1", "appearance", "dark"]],
    [
      { ...target, type: "setTextSize", value: "large" },
      ["simctl", "ui", "UDID-1", "content_size", "extra-extra-large"],
    ],
    [
      { ...target, type: "setToggle", setting: "increaseContrast", value: false },
      ["simctl", "ui", "UDID-1", "increase_contrast", "disabled"],
    ],
    [{ ...target, type: "openUrl", url: "myapp://x" }, ["simctl", "openurl", "UDID-1", "myapp://x"]],
    [{ ...target, type: "launchApp", appId: "com.a.b" }, ["simctl", "launch", "UDID-1", "com.a.b"]],
    [{ ...target, type: "terminateApp", appId: "com.a.b" }, ["simctl", "terminate", "UDID-1", "com.a.b"]],
    [
      { ...target, type: "setPermission", permission: "photos", decision: "revoke", appId: "com.a.b" },
      ["simctl", "privacy", "UDID-1", "revoke", "photos", "com.a.b"],
    ],
    [
      { ...target, type: "setLocation", latitude: 51.5, longitude: -0.12 },
      ["simctl", "location", "UDID-1", "set", "51.5,-0.12"],
    ],
    [{ ...target, type: "clearLocation" }, ["simctl", "location", "UDID-1", "clear"]],
  ];
  for (const [input, argv] of cases) {
    assert.deepEqual(iosActionCommand({ nodePath: "/node", helpers }, input), { command: "xcrun", args: argv });
  }
});

test("accessibility switches spawn serve-sim's helper inside the simulator", () => {
  const ready = { nodePath: "/node", helpers };
  const spawn = (...rest: string[]) => ({ command: "xcrun", args: ["simctl", "spawn", "UDID-1", AX, ...rest] });
  assert.deepEqual(
    iosActionCommand(ready, { ...target, type: "setToggle", setting: "voiceOver", value: true }),
    spawn("set", "voiceover", "on"),
  );
  assert.deepEqual(
    iosActionCommand(ready, { ...target, type: "setToggle", setting: "reduceMotion", value: false }),
    spawn("set", "reduce-motion", "off"),
  );
  assert.deepEqual(iosActionCommand(ready, { ...target, type: "setLiquidGlass", value: "tinted" }), spawn("set", "liquid-glass", "tinted"));
  assert.deepEqual(iosActionCommand(ready, { ...target, type: "setColorFilter", value: "grayscale" }), spawn("set", "color-filter", "grayscale"));
  assert.throws(
    () => iosActionCommand({ nodePath: "/node", helpers: { axSettings: null, serveSimCli: CLI } }, {
      ...target,
      type: "setToggle",
      setting: "showBorders",
      value: true,
    }),
    DeviceActionUnavailableError,
  );
});

test("notification permission runs serve-sim's CLI as Node", () => {
  assert.deepEqual(
    iosActionCommand(
      { nodePath: "/node", helpers },
      { ...target, type: "setPermission", permission: "notifications", decision: "grant", appId: "com.a.b" },
    ),
    {
      command: "/node",
      args: [CLI, "permissions", "grant", "notifications", "com.a.b", "-d", "UDID-1"],
      options: { env: { ELECTRON_RUN_AS_NODE: "1" } },
    },
  );
  assert.throws(
    () => iosActionCommand({ nodePath: "/node", helpers: { axSettings: AX, serveSimCli: null } }, {
      ...target,
      type: "setPermission",
      permission: "notifications",
      decision: "grant",
      appId: "com.a.b",
    }),
    DeviceActionUnavailableError,
  );
});

test("a push sends its APNs payload on stdin; a bare string becomes the alert", async () => {
  const ready = fakeReady(() => ({}));
  await runDeviceAction(ready, { ...target, type: "sendPush", appId: "com.a.b", payload: "Hi" });
  await runDeviceAction(ready, { ...target, type: "sendPush", appId: "com.a.b", payload: { aps: { badge: 2 } } });
  assert.deepEqual(ready.calls[0]!.args, ["simctl", "push", "UDID-1", "com.a.b", "-"]);
  assert.equal(ready.calls[0]!.options?.stdin, JSON.stringify({ aps: { alert: "Hi" } }));
  assert.equal(ready.calls[1]!.options?.stdin, JSON.stringify({ aps: { badge: 2 } }));
});

test("a failed action surfaces the last stderr line", async () => {
  const ready = fakeReady(() => ({ code: 1, stderr: "noise\nInvalid device: UDID-1\n" }));
  await assert.rejects(
    runDeviceAction(ready, { ...target, type: "clearLocation" }),
    /could not clear the location: Invalid device: UDID-1/u,
  );
});

test("a successful action runs once", async () => {
  const ready = fakeReady(() => ({}));
  await runDeviceAction(ready, { ...target, type: "setAppearance", value: "light" });
  assert.equal(ready.calls.length, 1);
});

test("the settings read maps simctl and helper values and degrades failures to unknown", async () => {
  const ready = fakeReady((args) => {
    if (args[1] === "spawn") {
      return {
        stdout: JSON.stringify({
          "reduce-motion": "on",
          "show-borders": "off",
          "reduce-transparency": "off",
          voiceover: "off",
          "color-filter": "none",
          "liquid-glass": "clear",
        }),
      };
    }
    if (args[3] === "appearance") return { stdout: "Dark\n" };
    if (args[3] === "content_size") return { stdout: "accessibility-extra-large\n" };
    return new Error("timed out");
  });
  assert.deepEqual(await readDeviceSettings(ready, "UDID-1"), {
    appearance: "dark",
    textSize: "extra-large",
    reduceMotion: true,
    reduceTransparency: false,
    showBorders: false,
    voiceOver: false,
    liquidGlass: "clear",
    colorFilter: "none",
  });

  const unknown = fakeReady((args) => (args[1] === "spawn" ? { stdout: "not json" } : { stdout: "unsupported" }));
  assert.deepEqual(await readDeviceSettings(unknown, "UDID-1"), { textSize: "default" });

  const failed = fakeReady(() => ({ code: 2 }));
  assert.deepEqual(await readDeviceSettings(failed, "UDID-1"), {});

  const noHelper = fakeReady(() => ({ stdout: "light" }), { axSettings: null, serveSimCli: null });
  await readDeviceSettings(noHelper, "UDID-1");
  assert.ok(noHelper.calls.every((call) => call.args[1] !== "spawn"));
});

test("iOS content-size categories map onto the four shared steps", () => {
  assert.equal(textSizeFromIos("large"), "default");
  assert.equal(textSizeFromIos("medium"), "small");
  assert.equal(textSizeFromIos("extra-large"), "large");
  assert.equal(textSizeFromIos("accessibility-medium"), "extra-large");
});
