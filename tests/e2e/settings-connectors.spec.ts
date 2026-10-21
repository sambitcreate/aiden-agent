import { fileURLToPath } from "node:url";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const FAKE_SERVER = fileURLToPath(new URL("./mcp-stdio-fake.mjs", import.meta.url));

test.describe("Settings → Connectors", () => {
  test("adds a custom local connector and shows its live status and tools", async ({ aiden }) => {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Connectors", exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Connectors", exact: true })).toBeVisible();
    // Hosted Figma can't be set up; it points at Figma Desktop instead.
    await expect(page.getByRole("button", { name: "Use Figma Desktop instead of Figma" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Set Up Figma", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Add custom connector" }).click();
    const dialog = page.getByRole("dialog", { name: "Add custom connector" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("group", { name: "Name" }).getByRole("textbox").fill("E2E Tools");
    await dialog.getByRole("group", { name: "Command" }).getByRole("textbox").fill(process.execPath);
    await dialog.getByRole("textbox", { name: "Arguments" }).fill(FAKE_SERVER);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    // Saving from the editor approves the command it showed, and Aiden connects in the background.
    const status = page.getByLabel("E2E Tools status");
    await expect(status).toContainText("Connected", { timeout: 20_000 });
    await expect(status).toContainText("Tools 2");
    await expect(page.getByRole("switch", { name: "Enable E2E Tools" })).toHaveAttribute("data-state", "checked");
  });
});
