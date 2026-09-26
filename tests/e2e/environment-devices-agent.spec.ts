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

// A real agent generation drives the Simulator through Aiden's device tools.
// As in the stream E2E, only the machine edges are fake: a pre-seeded
// expo-device-hub (device-hub-fake.mjs), a pre-seeded agent-device
// (agent-device-fake.mjs), and an `xcrun` on PATH. Nothing contacts npm.
const DEVICE_UDID = "5A1E2E00-0000-4000-8000-00000000A6E7";
const DEVICE_NAME = "iPhone 17 Pro";
const HUB_VERSION = "0.12.0";
const AGENT_VERSION = "0.21.12";

const fakeRoot = mkdtempSync(path.join(os.tmpdir(), "aiden-e2e-device-agent-"));
const fakeBin = path.join(fakeRoot, "bin");
const hubLog = path.join(fakeRoot, "hub.log");
const agentLog = path.join(fakeRoot, "agent.log");
writeFileSync(hubLog, "");
writeFileSync(agentLog, "");
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
    "  *) exit 0 ;;",
    "esac",
    "",
  ].join("\n"),
);
chmodSync(path.join(fakeBin, "xcrun"), 0o755);

async function seedTool(baseDir: string, name: string, version: string, entry: string[], fake: string) {
  const installDir = path.join(baseDir, "tools", name, version);
  const entryPath = path.join(installDir, "node_modules", name, ...entry);
  await mkdir(path.dirname(entryPath), { recursive: true });
  const fakeUrl = pathToFileURL(path.join(REPOSITORY_ROOT, "tests", "e2e", fake)).href;
  await writeFile(entryPath, `import ${JSON.stringify(fakeUrl)};\n`);
  await writeFile(path.join(installDir, ".install-complete"), `${version}\n`);
}

async function seedInstalledFakes(userDataDir: string): Promise<void> {
  const baseDir = path.join(userDataDir, "devices");
  await seedTool(baseDir, "expo-device-hub", HUB_VERSION, ["dist", "server", "cli.mjs"], "device-hub-fake.mjs");
  await seedTool(baseDir, "agent-device", AGENT_VERSION, ["bin", "agent-device.mjs"], "agent-device-fake.mjs");
  await writeFile(
    path.join(baseDir, "consent.json"),
    `${JSON.stringify({ version: 1, streaming: true, agentAccess: false })}\n`,
  );
}

async function stopFakeDaemon(userDataDir: string): Promise<void> {
  try {
    const daemon = JSON.parse(
      await readFile(path.join(userDataDir, "devices", "agent-state", "daemon.json"), "utf8"),
    ) as { pid?: number };
    if (daemon.pid) process.kill(daemon.pid, "SIGTERM");
  } catch {
    // Already stopped by the app's shutdown.
  }
}

const toolNamesIn = (body: unknown): string[] =>
  ((body as { tools?: { function?: { name?: string } }[] } | null)?.tools ?? []).map(
    ({ function: tool }) => tool?.name ?? "",
  );

test.describe("Simulator agent tools", () => {
  // Local iOS Simulators need Xcode; devicesEnabled() is false off macOS.
  test.skip(process.platform !== "darwin", "iOS Simulator devices are macOS-only");
  test.use({
    workspaceSeed: true,
    appEnvironment: {
      AIDEN_EXPERIMENTAL_DEVICES: "1",
      AIDEN_E2E_FAKE_HUB_LOG: hubLog,
      AIDEN_E2E_FAKE_AGENT_LOG: agentLog,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });

  test("agent access admits device tools, pins agent-device on PATH, asks before closing, and revokes cleanly", async ({
    aiden,
  }) => {
    const { page, lmStudio } = aiden;
    try {
      await finishLmStudioOnboarding(page);
      await seedInstalledFakes(aiden.userDataDir);

      // Without agent access, a generation never sees device tools.
      await page.locator("textarea").fill("Hello before simulators.");
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.locator(".streaming-reveal")).toHaveCount(0);
      await expect(page.getByText(E2E_ASSISTANT_RESPONSE, { exact: true })).toHaveCount(1);
      const agentRequests = () => lmStudio.requests.filter(({ body }) => toolNamesIn(body).length > 0);
      expect(agentRequests().length).toBeGreaterThan(0);
      for (const { body } of agentRequests()) {
        expect(toolNamesIn(body).filter((name) => name.startsWith("device_"))).toEqual([]);
      }

      const tools = page.getByRole("complementary", { name: "Environment work surface" });
      if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
      await tools.getByRole("tab", { name: "Simulator", exact: true }).click();
      const panel = page.locator("#environment-devices-panel");
      await panel.getByRole("button", { name: "Start", exact: true }).click();
      const agentAccess = panel.getByRole("switch", { name: "Let Aiden use simulators" });
      await expect(agentAccess).toHaveAttribute("aria-checked", "false");
      await agentAccess.click();
      await expect(agentAccess).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });

      // Closed panel: device_open must bring the Simulator tab forward itself.
      await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
      await expect(tools).toBeHidden();

      const prompt = "Simulator agent scenario: open the phone and check it.";
      const calls = [
        { name: "device_list", arguments: {} },
        { name: "device_open", arguments: {} },
        { name: "device_screenshot", arguments: {} },
        { name: "run_command", arguments: { command: "command -v agent-device && agent-device --version" } },
        { name: "run_command", arguments: { command: "agent-device snapshot -i" } },
      ];
      const scenario = lmStudio.enqueueToolScenario!({
        prompt,
        calls,
        finalText: "The simulator agent scenario finished.",
      });
      await page.locator("textarea").first().fill(prompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(
        page.getByText("The simulator agent scenario finished.", { exact: true }).first(),
      ).toBeVisible({ timeout: 60_000 });
      expect(scenario.error).toBeUndefined();
      expect(scenario.completed).toBe(true);
      expect(scenario.issuedToolNames).toEqual(calls.map(({ name }) => name));

      const [listed, opened, , located, refused] = scenario.results.map(({ content }) => JSON.stringify(content));
      expect(listed).toContain(DEVICE_UDID);
      expect(opened).toContain(DEVICE_UDID);
      expect(opened).toContain("--config");
      expect(opened).toContain("--session");
      expect(opened).toContain("snapshot -i");
      expect(opened).not.toMatch(/adb|android/iu);
      expect(located).toMatch(/devices\/bin\/agent-device/u);
      expect(located).toContain("aiden e2e fake");
      expect(refused).toContain("Call device_open first");
      // The screenshot reached the model as an image.
      expect(JSON.stringify(lmStudio.requests.map(({ body }) => body))).toContain("data:image/png;base64,iVBORw0KGgo");

      // device_open revealed the Simulator tab with this chat's live viewer.
      await expect(tools).toBeVisible();
      await expect(tools.getByRole("tab", { name: "Simulator", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(panel.locator(".device-viewer-status")).toHaveText("Live");
      // The agent daemon was started, and the launcher kept its token out of the CLI's env.
      const agentCalls = (await readFile(agentLog, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { args: string[]; daemonEnv?: boolean });
      expect(agentCalls.some(({ args }) => args[0] === "devices")).toBe(true);
      expect(agentCalls.every(({ daemonEnv }) => !daemonEnv)).toBe(true);

      // Ask first holds device_close for review.
      await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
      await page.getByRole("button", { name: /^Workspace access: Full access/u }).click();
      await page
        .getByRole("radiogroup", { name: "Workspace access" })
        .getByRole("radio", { name: /^Workspace access: Ask first/u })
        .click();
      const closePrompt = "Simulator agent scenario: close the phone when I allow it.";
      const closing = lmStudio.enqueueToolScenario!({
        prompt: closePrompt,
        calls: [{ name: "device_close", arguments: {} }],
        finalText: "The simulator is closed.",
      });
      await page.locator("textarea").first().fill(closePrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      const allowOnce = page.getByRole("button", { name: "Allow once", exact: true });
      await expect(allowOnce).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText(/Close simulator in the Simulator tab\. It keeps running\./u)).toBeVisible();
      expect(closing.completed).toBe(false);
      await allowOnce.click();
      await expect(page.getByText("The simulator is closed.", { exact: true }).first()).toBeVisible({
        timeout: 45_000,
      });
      expect(closing.error).toBeUndefined();

      // Revoking agent access removes the tools from the next generation.
      if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
      await tools.getByRole("tab", { name: "Simulator", exact: true }).click();
      await expect(panel.getByRole("button", { name: `Open ${DEVICE_NAME}` })).toBeVisible();
      await agentAccess.click();
      await expect(agentAccess).toHaveAttribute("aria-checked", "false");
      await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
      const afterPrompt = "Simulator agent scenario: anything after revoke.";
      const after = lmStudio.enqueueToolScenario!({ prompt: afterPrompt, calls: [], finalText: "No simulator tools now." });
      await page.locator("textarea").first().fill(afterPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect(page.getByText("No simulator tools now.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
      expect(after.completed).toBe(true);
      const revoked = agentRequests().filter(({ body }) => JSON.stringify(body).includes(afterPrompt));
      expect(revoked.length).toBeGreaterThan(0);
      for (const { body } of revoked) {
        expect(toolNamesIn(body).filter((name) => name.startsWith("device_"))).toEqual([]);
      }
    } finally {
      await stopFakeDaemon(aiden.userDataDir);
    }
  });
});
