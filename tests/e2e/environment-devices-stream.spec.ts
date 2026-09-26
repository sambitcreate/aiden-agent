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

// The real local host, proxy, stream client, and viewer run unchanged. Only the
// machine edges are faked: a pre-seeded "installed" expo-device-hub entry that
// runs tests/e2e/device-hub-fake.mjs, and an `xcrun` on PATH that reports one
// booted simulator. Nothing here contacts npm or Xcode.
const DEVICE_UDID = "5A1E2E00-0000-4000-8000-00000000E2E0";
const DEVICE_NAME = "iPhone 17 Pro";
const MSG_TOUCH = 0x03;
const HUB_VERSION = "0.12.0";

const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "aiden-e2e-devices-"));
const fakeBin = path.join(fakeRoot, "bin");
const hubLog = path.join(fakeRoot, "hub.log");
writeFileSync(hubLog, "");
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
  path?: string;
  query?: string;
  origin?: string | null;
  cookie?: string | null;
  connection?: number;
  tag?: number;
  body?: { type?: string } | null;
};

async function readHubLog(): Promise<HubLogEntry[]> {
  const text = await readFile(hubLog, "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HubLogEntry);
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

test.describe("Simulator stream", () => {
  test.use({
    workspaceSeed: true,
    appEnvironment: {
      AIDEN_EXPERIMENTAL_DEVICES: "1",
      AIDEN_E2E_FAKE_HUB_LOG: hubLog,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });

  test("paints MJPEG through the proxy, sends touches, reconnects input, and attaches a screenshot", async ({
    aiden,
  }, testInfo) => {
    const { page } = aiden;
    const streamOrigins: (string | undefined)[] = [];
    page.on("request", (request) => {
      if (!request.url().includes("/stream.avcc")) return;
      void request.allHeaders().then((headers) => streamOrigins.push(headers.origin));
    });

    await finishLmStudioOnboarding(page);
    await seedInstalledFakeHub(aiden.userDataDir);

    // Opening a simulator needs a chat to attach it to.
    await page.locator("textarea").fill("Open a simulator for this chat.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".streaming-reveal")).toHaveCount(0);
    await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toHaveCount(1);

    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await tools.getByRole("tab", { name: "Simulator", exact: true }).click();
    const panel = page.locator("#environment-devices-panel");

    await panel.getByRole("button", { name: "Start", exact: true }).click();
    await panel.getByRole("button", { name: `Open ${DEVICE_NAME}` }).click();

    const screen = panel.getByRole("application");
    const status = panel.locator(".device-viewer-status");
    await expect(status).toHaveText("Live");
    const frame = panel.locator(".device-viewer-screen img");
    await expect
      .poll(() => frame.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await expect(frame).toHaveAttribute("src", /\/stream\.mjpeg\?t=[^&]+&host=local$/u);

    await screen.click();
    await expect
      .poll(async () =>
        (await readHubLog())
          .filter((entry) => entry.kind === "ws-message" && entry.tag === MSG_TOUCH)
          .map((entry) => `${entry.connection}:${entry.body?.type}`),
      )
      .toEqual(expect.arrayContaining(["1:begin", "1:end"]));

    // The fake hub drops the first input socket after that touch; the client reconnects.
    await expect
      .poll(async () => (await readHubLog()).filter((entry) => entry.kind === "ws-open").length)
      .toBeGreaterThanOrEqual(2);
    await expect(status).toHaveText("Live");
    await screen.click();
    await expect
      .poll(async () =>
        (await readHubLog()).some(
          (entry) =>
            entry.kind === "ws-message" &&
            entry.tag === MSG_TOUCH &&
            entry.connection !== 1 &&
            entry.body?.type === "end",
        ),
      )
      .toBe(true);

    await panel.getByRole("button", { name: "Screenshot to chat" }).click();
    await expect(page.getByRole("button", { name: /^Remove .*\.png$/u })).toHaveCount(1);

    // The grant never reaches the hub, and the proxy presents the hub's own origin.
    const entries = await readHubLog();
    expect(entries.some((entry) => entry.path?.endsWith("/stream.avcc"))).toBe(true);
    expect(entries.some((entry) => entry.path?.endsWith("/stream.mjpeg"))).toBe(true);
    for (const entry of entries) {
      expect(entry.query ?? "").not.toMatch(/[?&](t|host)=/u);
      expect(entry.cookie ?? null).toBeNull();
      if (entry.origin) expect(entry.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    }
    // Records what the renderer sends. The stream working at all proves the proxy
    // accepted it; any Origin that is present must be on the allowlist.
    const pageOrigin = await page.evaluate(() => location.origin);
    await testInfo.attach("renderer-stream-origin", {
      body: JSON.stringify({ pageOrigin, streamOrigins }),
    });
    expect(streamOrigins.length).toBeGreaterThan(0);
    for (const origin of streamOrigins) expect([undefined, "file://"]).toContain(origin);

    await panel.getByRole("button", { name: "Close simulator" }).click();
    await expect(panel.getByRole("button", { name: `Open ${DEVICE_NAME}` })).toBeVisible();
  });
});
