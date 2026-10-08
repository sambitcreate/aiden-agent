import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  E2E_ASSISTANT_RESPONSE,
  expect,
  finishLmStudioOnboarding,
  REPOSITORY_ROOT,
  test,
} from "./fixtures";

// The real local host, proxy, stream client, viewer, and adb actions run
// unchanged. Only the machine edges are faked: a pre-seeded "installed"
// expo-device-hub that runs tests/e2e/device-hub-fake.mjs (one running
// foldable emulator), an Android SDK folder whose adb and emulator are shell
// scripts that log their argv, and an `xcrun` that reports no Xcode, so this
// Mac can run Android only. Nothing here contacts npm, Xcode, or a real SDK.
const SERIAL = "emulator-5554";
const AVD = "Pixel_Fold_E2E";
const HUB_VERSION = "0.12.0";

const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "aiden-e2e-android-"));
const fakeBin = path.join(fakeRoot, "bin");
const sdk = path.join(fakeRoot, "sdk");
const hubLog = path.join(fakeRoot, "hub.log");
const adbLog = path.join(fakeRoot, "adb.log");
writeFileSync(hubLog, "");
writeFileSync(adbLog, "");

function script(file: string, lines: string[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, ["#!/bin/sh", ...lines, ""].join("\n"));
  chmodSync(file, 0o755);
}
script(path.join(fakeBin, "xcrun"), ["echo \"xcode-select: error: tool 'xcrun' requires Xcode\" >&2", "exit 72"]);
const emulatorLog = path.join(fakeRoot, "emulator.log");
const wipePid = path.join(fakeRoot, "wipe.pid");
writeFileSync(emulatorLog, "");
// The wipe boot runs until `adb emu kill` ends it, as a real headless emulator does.
script(path.join(sdk, "emulator", "emulator"), [
  '[ "$1" = "-list-avds" ] && echo ' + AVD + " && exit 0",
  `printf '%s\\n' "$*" >> '${emulatorLog}'`,
  `[ "$1" = "-avd" ] && echo $$ > '${wipePid}' && exec sleep 60`,
  "exit 0",
]);
script(path.join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"), ["exit 0"]);
script(path.join(sdk, "platform-tools", "adb"), [
  `printf '%s\\n' "$*" >> '${adbLog}'`,
  'case "$*" in',
  `  devices) printf 'List of devices attached\\n${SERIAL}\\tdevice\\n' ;;`,
  '  *"getprop sys.boot_completed") echo 1 ;;',
  `  *"emu kill") kill "$(cat '${wipePid}')" 2>/dev/null; echo OK ;;`,
  '  *"cmd uimode night") echo "Night mode: no" ;;',
  '  *"settings get system font_scale") echo 1.0 ;;',
  '  *"settings get global animator_duration_scale") echo 1.0 ;;',
  '  *"settings get global wifi_on") echo 1 ;;',
  '  *"dumpsys window") echo "  mCurrentFocus=Window{1a2b u0 com.example.shop/com.example.shop.MainActivity}" ;;',
  "esac",
  "exit 0",
]);

type HubLogEntry = {
  kind: "http" | "ws-open" | "ws-message" | "fold" | "shutdown" | "text" | "logcat-closed";
  method?: string;
  path?: string;
  query?: string;
  origin?: string | null;
  cookie?: string | null;
  platform?: string;
  posture?: string;
  body?: Record<string, unknown> | null;
};

async function readHubLog(): Promise<HubLogEntry[]> {
  const text = await readFile(hubLog, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HubLogEntry);
}

const gestures = async () =>
  (await readHubLog())
    .filter((entry) => entry.kind === "ws-message" && entry.platform === "android" && entry.body?.type !== "reset-video")
    .map((entry) => entry.body);

async function seedInstalledFakeHub(userDataDir: string): Promise<void> {
  const baseDir = path.join(userDataDir, "devices");
  const installDir = path.join(baseDir, "tools", "expo-device-hub", HUB_VERSION);
  const entryDir = path.join(installDir, "node_modules", "expo-device-hub", "dist", "server");
  await mkdir(entryDir, { recursive: true });
  const fakeHub = pathToFileURL(path.join(REPOSITORY_ROOT, "tests", "e2e", "device-hub-fake.mjs")).href;
  await writeFile(path.join(entryDir, "cli.mjs"), `import ${JSON.stringify(fakeHub)};\n`);
  await writeFile(path.join(installDir, ".install-complete"), `${HUB_VERSION}\n`);
  await writeFile(
    path.join(baseDir, "consent.json"),
    `${JSON.stringify({ version: 1, streaming: true, agentAccess: false })}\n`,
  );
}

test.describe("Android emulator", () => {
  test.skip(process.platform !== "darwin", "Simulator devices are macOS-only");
  test.use({
    workspaceSeed: true,
    appEnvironment: {
      AIDEN_EXPERIMENTAL_DEVICES: "1",
      AIDEN_E2E_FAKE_HUB_LOG: hubLog,
      ANDROID_HOME: sdk,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });

  test("lists, streams, drives, folds, and configures an emulator on a Mac without Xcode", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await seedInstalledFakeHub(aiden.userDataDir);

    await page.locator("textarea").fill("Open an emulator for this chat.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".streaming-reveal")).toHaveCount(0);
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toHaveCount(1);

    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await tools.getByRole("button", { name: "More tools…", exact: true }).click();
    await tools.getByRole("button", { name: "Device", exact: true }).click();
    const panel = page.locator("#environment-devices-panel");
    await panel.getByRole("button", { name: "Start", exact: true }).click();

    // Each platform has its own section; the one this Mac cannot run says why.
    const ios = panel.getByRole("region", { name: "iOS Simulators" });
    await expect(ios).toContainText("Xcode was not found.");
    const android = panel.getByRole("region", { name: "Android Emulators" });
    await expect(android).toContainText("Android 15.0 · Booted");
    await android.getByRole("button", { name: `Open ${AVD}` }).click();

    const status = panel.locator(".device-viewer-status");
    await expect(status).toHaveText("Live");
    const rail = panel.getByRole("toolbar", { name: "Emulator controls" });
    for (const name of ["Back", "Home", "Recents", "Power"]) await expect(rail.getByRole("button", { name })).toBeEnabled();

    // Touches, keys, and hardware buttons travel as serve-emu JSON gestures.
    const screen = panel.getByRole("application");
    await screen.click();
    await page.keyboard.press("a");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await rail.getByRole("button", { name: "Recents" }).click();
    await expect
      .poll(async () => (await gestures()).map((body) => (body?.type === "touch" ? `touch:${String(body.action)}` : JSON.stringify(body))))
      .toEqual([
        "touch:down",
        "touch:up",
        JSON.stringify({ type: "text", text: "a" }),
        JSON.stringify({ type: "key", keycode: 66 }),
        JSON.stringify({ type: "back" }),
        JSON.stringify({ type: "recents" }),
      ]);

    // The foldable reports a hinge, so the flat view offers Fold and Unfold.
    const unfold = panel.getByRole("button", { name: "Unfold device", exact: true });
    await expect(unfold).toHaveAttribute("aria-pressed", "true");
    await panel.getByRole("button", { name: "Fold device", exact: true }).click();
    await expect
      .poll(async () => (await readHubLog()).filter((entry) => entry.kind === "fold").map((entry) => entry.posture))
      .toEqual(["closed"]);
    // The encoder restarts at the outer display's size; the stream recovers and the posture is read back.
    await expect(panel.getByRole("button", { name: "Fold device", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(status).toHaveText("Live");
    await expect(panel.locator(".device-viewer-screen")).toHaveAttribute("style", /aspect-ratio:\s*2/u);

    // The drawer offers the emulator's own settings, run as adb argv.
    await panel.getByRole("button", { name: "Device tools" }).click();
    const drawer = panel.locator("#device-tools");
    await expect(drawer.getByRole("heading", { name: "Emulator" })).toBeVisible();
    await expect(drawer).toContainText("com.example.shop");
    await expect(drawer.getByText("Push notification")).toHaveCount(0);
    await drawer.getByRole("switch", { name: "Network (Wi-Fi and data)" }).click();
    await expect
      .poll(async () => (await readFile(adbLog, "utf8")).split("\n"))
      .toEqual(expect.arrayContaining([`-s ${SERIAL} shell svc wifi disable`, `-s ${SERIAL} shell svc data disable`]));
    await drawer.getByRole("button", { name: "Close device tools" }).click();

    await panel.getByRole("button", { name: "Screenshot to chat" }).click();
    await expect(page.getByRole("button", { name: /^Remove .*\.png$/u })).toHaveCount(1);

    // The grant never reaches the hub, and serve-emu sees the hub's own origin.
    const entries = await readHubLog();
    expect(entries.some((entry) => entry.kind === "ws-open" && entry.path === "/vendor/serve-emu/ws")).toBe(true);
    expect(entries.some((entry) => entry.path === "/vendor/serve-emu/api/screenshot" && entry.method === "GET")).toBe(true);
    for (const entry of entries) {
      expect(entry.query ?? "").not.toMatch(/[?&](t|host)=/u);
      expect(entry.cookie ?? null).toBeNull();
      if (entry.origin) expect(entry.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    }

    await panel.getByRole("button", { name: "Close emulator" }).click();
    await expect(android.getByRole("button", { name: `Open ${AVD}` })).toBeVisible();
  });

  test("saves a screenshot, overlays element frames, follows logcat, pastes, and erases an emulator", async ({ aiden }) => {
    const { page, app } = aiden;
    await finishLmStudioOnboarding(page);
    await seedInstalledFakeHub(aiden.userDataDir);
    const savedScreenshot = path.join(fakeRoot, "emulator-shot.png");

    await page.locator("textarea").fill("Open an emulator for this chat.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".streaming-reveal")).toHaveCount(0);
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toHaveCount(1);
    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await tools.getByRole("button", { name: "More tools…", exact: true }).click();
    await tools.getByRole("button", { name: "Device", exact: true }).click();
    const panel = page.locator("#environment-devices-panel");
    await panel.getByRole("button", { name: "Start", exact: true }).click();
    await panel.getByRole("region", { name: "Android Emulators" }).getByRole("button", { name: `Open ${AVD}` }).click();
    await expect(panel.locator(".device-viewer-status")).toHaveText("Live");

    // Save screenshot… captures through serve-emu and writes the file main's save dialog chose.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
    }, savedScreenshot);
    const options = panel.getByRole("button", { name: "Screenshot options" });
    await options.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Save screenshot…" }).click();
    await expect(page.getByText("Saved emulator-shot.png.")).toBeVisible();
    expect([...(await readFile(savedScreenshot)).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // Recording is offered with the emulator's three-minute cap.
    await expect(panel.getByRole("button", { name: "Record screen" })).toHaveAttribute("title", /up to 3 minutes/u);

    // The overlay draws serve-emu's uiautomator nodes, skipping the full-screen root.
    await panel.getByRole("button", { name: "Device tools" }).click();
    const overlaySwitch = panel.getByRole("switch", { name: "Overlay element frames" });
    await overlaySwitch.click();
    await expect(panel.locator(".device-ax-frame")).toHaveCount(2);
    await expect(panel.getByText("2 elements")).toBeVisible();
    const screen = panel.locator(".device-viewer-screen");
    const box = (await screen.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * (1575 / 2160));
    await expect(panel.locator(".device-ax-label")).toContainText("Add to cart");
    await expect(panel.locator(".device-ax-label")).toContainText("Button");
    expect(
      (await readHubLog()).some((entry) => entry.path === "/vendor/serve-emu/api/accessibility" && entry.query === `?device=${SERIAL}`),
    ).toBe(true);
    await overlaySwitch.click();
    await expect(panel.locator(".device-ax-frame")).toHaveCount(0);

    // Logcat streams only while the section is open, and can follow the frontmost app.
    const logcatOpens = async () => (await readHubLog()).filter((entry) => entry.path === "/vendor/serve-emu/api/logcat");
    const before = (await logcatOpens()).length;
    await panel.getByRole("button", { name: "Event log", exact: true }).click();
    const log = panel.getByRole("log", { name: "Emulator logcat" });
    await expect(log).toContainText("E Shop: Cart failed to load");
    await expect(log).toContainText("I ActivityTaskManager: START u0");
    await panel.getByRole("textbox", { name: "Filter events" }).fill("error");
    await expect(log.getByRole("listitem")).toHaveCount(1);
    await panel.getByRole("switch", { name: "Only the frontmost app" }).click();
    await expect
      .poll(async () => (await logcatOpens()).slice(before).map((entry) => entry.query))
      .toEqual([`?device=${SERIAL}`, `?device=${SERIAL}&package=com.example.shop`]);
    // Closing the section ends the request, which is what stops serve-emu's logcat child.
    await panel.getByRole("button", { name: "Event log", exact: true }).click();
    await expect
      .poll(async () => (await readHubLog()).filter((entry) => entry.kind === "logcat-closed").length)
      .toBeGreaterThanOrEqual(2);

    // Paste types the Mac clipboard into the emulator; Copy from device explains why it cannot.
    await app.evaluate(({ clipboard }) => clipboard.writeText("hello emulator"));
    await panel.getByRole("button", { name: "Paste to device" }).click();
    await expect
      .poll(async () => (await readHubLog()).filter((entry) => entry.kind === "text").map((entry) => entry.body))
      .toEqual([{ text: "hello emulator" }]);
    const copy = panel.getByRole("button", { name: "Copy from device" });
    await expect(copy).toBeDisabled();
    await expect(copy).toHaveAccessibleDescription("Android Emulators do not let adb read their clipboard.");

    // Erase asks first; then the hub shuts the emulator down and one headless boot wipes it.
    await panel.getByRole("button", { name: "Erase all content and settings…" }).click();
    const confirm = page.getByRole("alertdialog", { name: `Erase ${AVD}?` });
    await expect(confirm).toContainText("The emulator shuts down first");
    await confirm.getByRole("button", { name: "Erase" }).click();
    await expect(page.getByText(`${AVD} was erased. It is shut down.`)).toBeVisible({ timeout: 30_000 });
    expect((await readHubLog()).filter((entry) => entry.kind === "shutdown").map((entry) => entry.body)).toEqual([
      { platform: "android", id: SERIAL, name: AVD },
    ]);
    expect((await readFile(emulatorLog, "utf8")).trim().split("\n")).toEqual([
      `-avd ${AVD} -wipe-data -no-snapshot-load -no-window -no-audio -no-boot-anim -port 5556`,
    ]);
    expect((await readFile(adbLog, "utf8")).split("\n")).toEqual(
      expect.arrayContaining(["-s emulator-5556 shell getprop sys.boot_completed", "-s emulator-5556 emu kill"]),
    );
  });
});
