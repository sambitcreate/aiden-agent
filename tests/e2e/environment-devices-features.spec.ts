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

// The device power features against the real local host, proxy, stream client,
// and viewer. Like the stream spec, only the machine edges are faked: an
// "installed" hub that runs tests/e2e/device-hub-fake.mjs, and an `xcrun` on
// PATH that reports one booted simulator and logs every invocation. The save
// dialog is answered from the main process. Nothing contacts npm or Xcode, and
// the system clipboard is never touched.
const DEVICE_UDID = "5A1E2E00-0000-4000-8000-00000000E2E1";
const DEVICE_NAME = "iPhone 17 Pro";
const MSG_MULTI_TOUCH = 0x05;
const HUB_VERSION = "0.12.0";

const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "aiden-e2e-device-features-"));
const fakeBin = path.join(fakeRoot, "bin");
const hubLog = path.join(fakeRoot, "hub.log");
const xcrunLog = path.join(fakeRoot, "xcrun.log");
const savedScreenshot = path.join(fakeRoot, "saved", "simulator-shot.png");
writeFileSync(hubLog, "");
writeFileSync(xcrunLog, "");
mkdirSync(path.dirname(savedScreenshot), { recursive: true });
const simctlList = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      {
        udid: DEVICE_UDID,
        name: DEVICE_NAME,
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
      },
    ],
  },
});
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  path.join(fakeBin, "xcrun"),
  [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> '${xcrunLog}'`,
    '[ "$1" = "simctl" ] || exit 1',
    'case "$2" in',
    '  help) echo "usage: simctl"; exit 0 ;;',
    `  list) printf '%s\\n' '${simctlList}'; exit 0 ;;`,
    '  ui) [ -n "$5" ] && exit 0',
    '      case "$4" in appearance) echo light ;; content_size) echo large ;; increase_contrast) echo disabled ;; esac',
    "      exit 0 ;;",
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(path.join(fakeBin, "xcrun"), 0o755);

type HubLogEntry = {
  kind: "http" | "ws-open" | "ws-message";
  method?: string;
  path?: string;
  tag?: number;
  body?: { type?: string; x1?: number; x2?: number } | null;
};

async function readHubLog(): Promise<HubLogEntry[]> {
  return (await readFile(hubLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HubLogEntry);
}

async function simctlVerbs(): Promise<string[]> {
  return (await readFile(xcrunLog, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("simctl ") && !line.startsWith("simctl list") && !line.startsWith("simctl ui"))
    .filter((line) => !line.startsWith("simctl help") && !line.startsWith("simctl spawn"));
}

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

test.describe("Simulator power features", () => {
  test.skip(process.platform !== "darwin", "iOS Simulator devices are macOS-only");
  test.use({
    workspaceSeed: true,
    appEnvironment: {
      AIDEN_EXPERIMENTAL_DEVICES: "1",
      AIDEN_E2E_FAKE_HUB_LOG: hubLog,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });

  test("saves a screenshot, overlays element frames, pinches, shows the event log, and erases after confirming", async ({
    aiden,
  }) => {
    const { page, app } = aiden;
    await finishLmStudioOnboarding(page);
    await seedInstalledFakeHub(aiden.userDataDir);

    await page.locator("textarea").fill("Open a simulator for this chat.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".streaming-reveal")).toHaveCount(0);
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toHaveCount(1);

    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await tools.getByRole("button", { name: "More tools…", exact: true }).click();
    await tools.getByRole("button", { name: "Simulator", exact: true }).click();
    const panel = page.locator("#environment-devices-panel");
    await panel.getByRole("button", { name: "Start", exact: true }).click();
    await panel.getByRole("button", { name: `Open ${DEVICE_NAME}` }).click();
    const status = panel.locator(".device-viewer-status");
    await expect(status).toHaveText("Live");

    // Save screenshot… goes through the save dialog, which main answers here.
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as unknown as typeof dialog.showSaveDialog;
    }, savedScreenshot);
    const options = panel.getByRole("button", { name: "Screenshot options" });
    await options.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "Save screenshot…" }).click();
    await expect(page.getByText("Saved simulator-shot.png.")).toBeVisible();
    const png = await readFile(savedScreenshot);
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Option-drag sends two mirrored touches in one multi-touch packet.
    const screen = panel.locator(".device-viewer-screen");
    const box = (await screen.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5);
    await page.keyboard.down("Alt");
    await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
    await expect(panel.locator(".device-touch-dot")).toHaveCount(2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await expect
      .poll(async () =>
        (await readHubLog())
          .filter((entry) => entry.kind === "ws-message" && entry.tag === MSG_MULTI_TOUCH)
          .map((entry) => entry.body?.type),
      )
      .toEqual(expect.arrayContaining(["begin", "move", "end"]));
    const begin = (await readHubLog()).find((entry) => entry.tag === MSG_MULTI_TOUCH && entry.body?.type === "begin");
    expect((begin?.body?.x1 ?? 0) + (begin?.body?.x2 ?? 0)).toBeCloseTo(1, 5);

    // The accessibility overlay draws frames on the flat screen and names the hovered element.
    await panel.getByRole("button", { name: "Device tools" }).click();
    const overlaySwitch = panel.getByRole("switch", { name: "Overlay element frames" });
    await overlaySwitch.click();
    await expect(overlaySwitch).toHaveAttribute("aria-checked", "true");
    await expect(panel.locator(".device-ax-frame")).toHaveCount(2);
    await expect(panel.getByText("2 elements")).toBeVisible();
    // The drawer shrinks the stage, so the screen is measured again.
    const framed = (await screen.boundingBox())!;
    await page.mouse.move(framed.x + framed.width * 0.5, framed.y + framed.height * 0.27);
    await expect(panel.locator(".device-ax-label")).toContainText("General");
    await expect(panel.locator(".device-ax-label")).toContainText("Button");
    expect((await readHubLog()).some((entry) => entry.path === `/vendor/serve-sim/helper/${DEVICE_UDID}/ax`)).toBe(true);
    await overlaySwitch.click();
    await expect(panel.locator(".device-ax-frame")).toHaveCount(0);

    // The event log subscribes only once it is opened.
    const eventLogPath = "/vendor/serve-sim/api/event-log/events";
    expect((await readHubLog()).some((entry) => entry.path === eventLogPath)).toBe(false);
    await panel.getByRole("button", { name: "Event log" }).click();
    const log = panel.getByRole("log", { name: "Simulator events" });
    await expect(log).toContainText("Button home");
    await expect(log).toContainText("Touch begin 0.50,0.50");
    await panel.getByRole("textbox", { name: "Filter events" }).fill("home");
    await expect(log.getByRole("listitem")).toHaveCount(1);

    // Erase asks first, naming the simulator; cancelling runs nothing.
    await panel.getByRole("button", { name: "Erase all content and settings…" }).click();
    const confirm = page.getByRole("alertdialog", { name: `Erase ${DEVICE_NAME}?` });
    await expect(confirm).toContainText("All content and settings");
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toBeHidden();
    expect((await simctlVerbs()).some((line) => line.startsWith("simctl erase"))).toBe(false);

    await panel.getByRole("button", { name: "Erase all content and settings…" }).click();
    await page.getByRole("alertdialog", { name: `Erase ${DEVICE_NAME}?` }).getByRole("button", { name: "Erase" }).click();
    const offer = page.getByRole("dialog", { name: `${DEVICE_NAME} was erased` });
    await expect(offer).toBeVisible();
    expect(await simctlVerbs()).toEqual(
      expect.arrayContaining([`simctl shutdown ${DEVICE_UDID}`, `simctl erase ${DEVICE_UDID}`]),
    );
    const verbs = await simctlVerbs();
    expect(verbs.indexOf(`simctl shutdown ${DEVICE_UDID}`)).toBeLessThan(verbs.indexOf(`simctl erase ${DEVICE_UDID}`));
    await offer.getByRole("button", { name: "Boot" }).click();
    await expect(offer).toBeHidden();
    await expect(status).toHaveText("Live");
  });
});
