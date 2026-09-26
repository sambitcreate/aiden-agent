import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const TAB_NAMES = ["Review", "Subagents", "Files", "Browser", "Simulator"];

test.describe("Simulator tab", () => {
  test.use({ workspaceSeed: true, appEnvironment: { AIDEN_EXPERIMENTAL_DEVICES: "1" } });

  test("stays hidden off macOS even when the flag is set", async ({ aiden }) => {
    test.skip(process.platform === "darwin", "covered by the macOS test below");
    const page = aiden.page;
    await finishLmStudioOnboarding(page);
    const tools = page.getByRole("complementary", { name: "Environment work surface" });
    if (!(await tools.isVisible())) await page.locator("[data-environment-toggle]").click();
    await expect(tools).toBeVisible();
    const tabs = tools.getByRole("tablist", { name: "Environment views" }).getByRole("tab");
    await expect(tabs).toHaveCount(TAB_NAMES.length - 1);
    await expect(tools.getByRole("tab", { name: "Simulator", exact: true })).toHaveCount(0);
    await expect(page.locator("#environment-devices-panel")).toHaveCount(0);
  });

  test("is the last keyboard-reachable Environment tab, persists, and hides without the flag", async ({
    aiden,
  }) => {
    test.skip(process.platform !== "darwin", "iOS Simulator devices are macOS-only");
    let page = aiden.page;
    await finishLmStudioOnboarding(page);
    const tools = () => page.getByRole("complementary", { name: "Environment work surface" });
    const tab = (name: string) => tools().getByRole("tab", { name, exact: true });

    for (const width of [900, 560]) {
      await aiden.app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
        width,
      );
      if (!(await tools().isVisible())) await page.locator("[data-environment-toggle]").click();
      await expect(tools()).toBeVisible();
      const tabs = tools().getByRole("tablist", { name: "Environment views" }).getByRole("tab");
      await expect(tabs).toHaveCount(TAB_NAMES.length);
      await expect(tabs.last()).toHaveAccessibleName("Simulator");

      await tab("Review").click();
      await page.keyboard.press("End");
      await expect(tab("Simulator")).toBeFocused();
      await expect(tab("Simulator")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowRight");
      await expect(tab("Review")).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(tab("Simulator")).toBeFocused();
      await page.keyboard.press("Home");
      await expect(tab("Review")).toBeFocused();
      await page.keyboard.press("End");
      await expect(tab("Simulator")).toBeFocused();

      const devicesPanel = page.locator("#environment-devices-panel");
      await expect(devicesPanel).toBeVisible();
      // Consent is explicit: the button is offered but never pressed here, so npm is not contacted.
      await expect(
        devicesPanel.getByRole("button", { name: "Set up simulator streaming" }),
      ).toBeEnabled();
      await expect(devicesPanel).toContainText("node-datachannel");
      if (width === 560) await expect(tab("Simulator")).toHaveAttribute("title", "Simulator");
    }

    page = await aiden.relaunch();
    await expect(tools()).toBeVisible();
    await expect(tab("Simulator")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#environment-devices-panel")).toBeVisible();

    page = await aiden.relaunch(undefined, {});
    await expect(tools()).toBeVisible();
    await expect(tab("Simulator")).toHaveCount(0);
    await expect(page.locator("#environment-devices-panel")).toHaveCount(0);
    await expect(tab("Review")).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("aiden-agent.environment.tab")))
      .toBe("devices");
  });
});
