import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.describe("Simulator tool", () => {
  test.use({ workspaceSeed: true, appEnvironment: { AIDEN_EXPERIMENTAL_DEVICES: "1" } });

  test("stays unavailable off macOS even when the flag is set", async ({ aiden }) => {
    test.skip(process.platform === "darwin", "covered by the macOS test below");
    await finishLmStudioOnboarding(aiden.page);
    await aiden.page.locator("[data-environment-toggle]").click();
    const tools = aiden.page.getByRole("complementary", { name: "Environment work surface" });
    await tools.getByRole("button", { name: "More tools…", exact: true }).click();
    await expect(tools.getByRole("button", { name: "Simulator", exact: true })).toHaveCount(0);
    await expect(aiden.page.locator("#environment-devices-panel")).toHaveCount(0);
  });

  test("opens from the launcher, supports keyboard tab navigation, and hides without the flag", async ({ aiden }) => {
    test.skip(process.platform !== "darwin", "iOS Simulator devices are macOS-only");
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    const tools = () => page.getByRole("complementary", { name: "Environment work surface" });
    const tab = (name: string) => tools().getByRole("tablist", { name: "Environment views" }).getByRole("tab", { name, exact: true });
    await page.locator("[data-environment-toggle]").click();
    await tools().getByRole("button", { name: "More tools…", exact: true }).click();
    await tools().getByRole("button", { name: "Simulator", exact: true }).click();
    for (const width of [900, 560]) {
      await aiden.app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width);
      await tools().getByRole("button", { name: "New workspace tab" }).click();
      await expect(tab("New tab")).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(tab("Simulator")).toBeFocused();
      const devicesPanel = page.locator("#environment-devices-panel");
      await expect(devicesPanel).toBeVisible();
      await expect(devicesPanel.getByRole("button", { name: "Set up simulator streaming" })).toBeEnabled();
      await expect(devicesPanel).toContainText("node-datachannel");
    }
    page = await aiden.relaunch();
    await expect(tools()).toBeVisible();
    await expect(tab("New tab")).toHaveAttribute("aria-selected", "true");
    await tab("Simulator").click();
    await expect(page.locator("#environment-devices-panel")).toBeVisible();
    page = await aiden.relaunch(undefined, {});
    await expect(tools()).toBeVisible();
    await expect(tab("Simulator")).toHaveCount(0);
    await expect(page.locator("#environment-devices-panel")).toHaveCount(0);
    await expect(tab("New tab")).toHaveAttribute("aria-selected", "true");
  });
});
