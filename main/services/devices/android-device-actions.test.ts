import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { DeviceActionInput } from "../../../renderer/shared/devices.js";
import type { DeviceHostReady } from "./device-host.js";
import {
  androidActionCommands,
  deviceShellQuote,
  parseAndroidFocusedPackage,
  readAndroidDeviceSettings,
  runAndroidDeviceAction,
  textSizeFromAndroid,
} from "./android-device-actions.js";

const target = { hostId: "local", deviceId: "emulator-5554" };

function fakeReady(respond: (args: string[]) => { stdout?: string; stderr?: string; code?: number }) {
  const calls: string[][] = [];
  const ready = {
    nodePath: "/node",
    hub: { origin: "http://127.0.0.1:1" },
    helpers: { axSettings: null, serveSimCli: null },
    async run(command: string, args: readonly string[]) {
      calls.push([command, ...args]);
      const result = respond([...args]);
      return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
    },
  } satisfies DeviceHostReady;
  return { ready, calls };
}

/** What the device's own `sh` would see as argv after `adb shell` joins the words with spaces. */
function deviceArgv(words: readonly string[]): string[] {
  const script = 'for a in "$@"; do printf "%s\\0" "$a"; done';
  const result = spawnSync("/bin/sh", ["-c", `eval "set -- ${words.join(" ").replace(/["\\$`]/gu, "\\$&")}"; ${script}`], {
    encoding: "utf8",
  });
  return result.stdout.split("\0").slice(0, -1);
}

test("each Android action is adb with the serial first and no host shell", () => {
  const cases: Array<[DeviceActionInput, string[][]]> = [
    [{ ...target, type: "setAppearance", value: "dark" }, [["shell", "cmd", "uimode", "night", "yes"]]],
    [{ ...target, type: "setTextSize", value: "extra-large" }, [["shell", "settings", "put", "system", "font_scale", "1.3"]]],
    [
      { ...target, type: "setToggle", setting: "networkEnabled", value: false },
      [
        ["shell", "svc", "wifi", "disable"],
        ["shell", "svc", "data", "disable"],
      ],
    ],
    [
      { ...target, type: "setToggle", setting: "reduceMotion", value: true },
      [
        ["shell", "settings", "put", "global", "animator_duration_scale", "0"],
        ["shell", "settings", "put", "global", "transition_animation_scale", "0"],
        ["shell", "settings", "put", "global", "window_animation_scale", "0"],
      ],
    ],
    [
      { ...target, type: "setOrientation", value: "landscape_left" },
      [
        ["shell", "settings", "put", "system", "accelerometer_rotation", "1"],
        ["shell", "cmd", "window", "user-rotation", "free"],
        ["emu", "sensor", "set", "acceleration", "9.81:0:0"],
      ],
    ],
    // The emulator console takes longitude first.
    [{ ...target, type: "setLocation", latitude: 59.3293, longitude: 18.0686 }, [["emu", "geo", "fix", "18.0686", "59.3293"]]],
    [{ ...target, type: "clearLocation" }, []],
    [
      { ...target, type: "launchApp", appId: "com.example.my_app" },
      [["shell", "monkey", "-p", "com.example.my_app", "-c", "android.intent.category.LAUNCHER", "1"]],
    ],
    [{ ...target, type: "terminateApp", appId: "com.example.app" }, [["shell", "am", "force-stop", "com.example.app"]]],
  ];
  for (const [input, expected] of cases) {
    const commands = androidActionCommands(input);
    assert.ok(commands.every((command) => command.command === "adb"), input.type);
    assert.deepEqual(
      commands.map((command) => command.args),
      expected.map((args) => ["-s", "emulator-5554", ...args]),
      input.type,
    );
  }
});

test("a physical device rotates with the window-manager lock instead of the emulator sensor", () => {
  const [step] = androidActionCommands({ hostId: "local", deviceId: "R5CT1234", type: "setOrientation", value: "landscape_right" });
  assert.deepEqual(step?.args, ["-s", "R5CT1234", "shell", "cmd", "window", "user-rotation", "lock", "3"]);
});

test("a URL reaches the device's shell as one argument, metacharacters and all", () => {
  // Harmless substitutions: unquoted, they would change the argv instead of running anything that matters.
  const url = "https://example.test/a?b=1&c=$(echo pwned);d='x'`echo hi`";
  const [step] = androidActionCommands({ ...target, type: "openUrl", url });
  assert.deepEqual(step?.args.slice(0, 3), ["-s", "emulator-5554", "shell"]);
  // adb joins the words with spaces for the device's sh; it must split them back exactly.
  assert.deepEqual(deviceArgv(step!.args.slice(3)), ["am", "start", "-a", "android.intent.action.VIEW", "-d", url]);
  assert.equal(deviceShellQuote("com.example.app"), "com.example.app");
  assert.deepEqual(deviceArgv([deviceShellQuote("it's here")]), ["it's here"]);
});

test("a permission group grants each runtime permission and tolerates undeclared ones", async () => {
  const steps = androidActionCommands({
    ...target,
    type: "setPermission",
    permission: "location",
    decision: "reset",
    appId: "com.example.app",
  });
  assert.deepEqual(
    steps.map((step) => step.args.slice(3)),
    [
      ["pm", "revoke", "com.example.app", "android.permission.ACCESS_FINE_LOCATION"],
      ["pm", "revoke", "com.example.app", "android.permission.ACCESS_COARSE_LOCATION"],
    ],
  );
  // An app that never declared coarse location still succeeds.
  const { ready, calls } = fakeReady((args) => (args.includes("android.permission.ACCESS_COARSE_LOCATION") ? { code: 255 } : {}));
  await runAndroidDeviceAction(ready, {
    ...target,
    type: "setPermission",
    permission: "location",
    decision: "grant",
    appId: "com.example.app",
  });
  assert.equal(calls.length, 2);
});

test("actions Android cannot run are refused before anything runs", () => {
  for (const input of [
    { ...target, type: "sendPush", appId: "com.a.b", payload: "Hi" },
    { ...target, type: "setLiquidGlass", value: "clear" },
    { ...target, type: "setToggle", setting: "voiceOver", value: true },
    { ...target, type: "setPermission", permission: "faceid", decision: "grant", appId: "com.a.b" },
  ] satisfies DeviceActionInput[]) {
    assert.throws(() => androidActionCommands(input), /do not support/u, input.type);
  }
});

test("a failed step, or an emulator console KO, stops the action with the device's message", async () => {
  const failing = fakeReady(() => ({ code: 1, stderr: "Error: Unknown option\nadb: device offline" }));
  await assert.rejects(
    runAndroidDeviceAction(failing.ready, { ...target, type: "setAppearance", value: "light" }),
    /The emulator could not change the appearance: adb: device offline/u,
  );
  const ko = fakeReady(() => ({ stdout: "KO: unknown command\n" }));
  await assert.rejects(
    runAndroidDeviceAction(ko.ready, { ...target, type: "setLocation", latitude: 1, longitude: 2 }),
    /could not set the location: KO: unknown command/u,
  );
  // The network switch stops at the first refusal instead of leaving data and Wi-Fi out of step silently.
  const network = fakeReady((args) => (args.includes("wifi") ? { code: 1 } : {}));
  await assert.rejects(runAndroidDeviceAction(network.ready, { ...target, type: "setToggle", setting: "networkEnabled", value: true }));
  assert.equal(network.calls.length, 1);
});

test("settings read what adb reports and leave unreadable values unknown", async () => {
  const focus =
    "  mCurrentFocus=Window{1a2b3c u0 com.example.shop/com.example.shop.MainActivity}\n  mFocusedApp=ActivityRecord{9 u0 com.example.shop/.MainActivity t12}";
  const { ready } = fakeReady((args) => {
    const command = args.slice(3).join(" ");
    if (command === "cmd uimode night") return { stdout: "Night mode: yes\n" };
    if (command === "settings get system font_scale") return { stdout: "1.15\n" };
    if (command === "settings get global animator_duration_scale") return { stdout: "0.0\n" };
    if (command === "settings get global wifi_on") return { stdout: "0\n" };
    if (command === "dumpsys window") return { stdout: focus };
    return { code: 1 };
  });
  assert.deepEqual(await readAndroidDeviceSettings(ready, "emulator-5554"), {
    appearance: "dark",
    textSize: "large",
    reduceMotion: true,
    networkEnabled: false,
    foregroundApp: "com.example.shop",
  });
  const offline = fakeReady(() => ({ code: 1 }));
  assert.deepEqual(await readAndroidDeviceSettings(offline.ready, "emulator-5554"), {});
  const unset = fakeReady((args) => (args.includes("font_scale") || args.includes("animator_duration_scale") ? { stdout: "null" } : { code: 1 }));
  assert.deepEqual(await readAndroidDeviceSettings(unset.ready, "emulator-5554"), {});
});

test("font scales map onto the four shared text sizes", () => {
  assert.deepEqual([0.85, 1, 1.15, 1.3, 2].map(textSizeFromAndroid), ["small", "default", "large", "extra-large", "extra-large"]);
  assert.equal(parseAndroidFocusedPackage("mCurrentFocus=null"), undefined);
  assert.equal(parseAndroidFocusedPackage("mCurrentFocus=Window{1 u0 StatusBar}"), undefined);
});
