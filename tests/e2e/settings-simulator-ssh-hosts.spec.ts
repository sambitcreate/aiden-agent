import path from "node:path";
import { expect, finishLmStudioOnboarding, readJsonFile, test } from "./fixtures";

type StoredHosts = { version: number; hosts: Array<{ id: string; label: string; target: string; port?: number }> };

test.describe("Settings → Simulator → SSH hosts", () => {
  test.use({ appEnvironment: { AIDEN_EXPERIMENTAL_DEVICES: "1" } });

  test("adds, validates, persists, and removes an SSH host without contacting it", async ({ aiden }) => {
    test.skip(process.platform !== "darwin", "iOS Simulator devices are macOS-only");
    let page = aiden.page;
    const hostsFile = path.join(aiden.userDataDir, "devices", "ssh-hosts.json");
    const openSimulatorSettings = async () => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Simulator", exact: true }).click();
      await expect(page.getByRole("heading", { name: "SSH hosts" })).toBeVisible();
    };
    await finishLmStudioOnboarding(page);
    await openSimulatorSettings();

    await page.getByRole("button", { name: "Add SSH host" }).click();
    const dialog = page.getByRole("dialog", { name: "Add SSH host" });
    await expect(dialog).toBeVisible();
    const target = dialog.getByLabel("SSH target");
    await target.fill("-oProxyCommand=touch /tmp/aiden-e2e");
    await expect(target).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByText(/not starting with a dash/u)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Test connection" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Save host" }).click();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Name").fill("Build Mac");
    await target.fill("me@build-mac.invalid");
    await dialog.getByLabel("Port").fill("2222");
    await expect(target).not.toHaveAttribute("aria-invalid", "true");
    await dialog.getByRole("button", { name: "Save host" }).click();
    await expect(dialog).toBeHidden();

    const row = page.locator("[data-ssh-host-id]").filter({ hasText: "Build Mac" });
    await expect(row).toContainText("me@build-mac.invalid, port 2222");
    await expect(row).toContainText("Not connected");
    // Streaming is off, so the host can be edited and tested but not connected.
    await expect(row.getByRole("button", { name: "Connect Build Mac" })).toBeDisabled();
    await expect
      .poll(async () => (await readJsonFile<StoredHosts>(hostsFile).catch(() => null))?.hosts.map((host) => host.target))
      .toEqual(["me@build-mac.invalid"]);

    page = await aiden.relaunch();
    await openSimulatorSettings();
    const reloaded = page.locator("[data-ssh-host-id]").filter({ hasText: "Build Mac" });
    await expect(reloaded).toContainText("Not connected");

    await reloaded.getByRole("button", { name: "More for Build Mac" }).click();
    await page.getByRole("menuitem", { name: "Remove…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Remove Build Mac?" });
    await confirm.getByRole("button", { name: "Remove host" }).click();
    await expect(page.locator("[data-ssh-host-id]")).toHaveCount(0);
    await expect.poll(async () => (await readJsonFile<StoredHosts>(hostsFile)).hosts).toEqual([]);
  });
});
