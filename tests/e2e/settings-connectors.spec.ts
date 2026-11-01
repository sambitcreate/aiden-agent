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
    // A new local launch asks in a native review box first. Playwright can't click native
    // boxes, so answer it in the main process and keep what it was asked to show.
    await aiden.app.evaluate(({ dialog: nativeDialog }) => {
      const asked: string[] = [];
      (globalThis as { __aidenLaunchReviews?: string[] }).__aidenLaunchReviews = asked;
      nativeDialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.find((arg) => arg !== null && typeof arg === "object" && "buttons" in (arg as object)) as { detail?: string };
        asked.push(options.detail ?? "");
        return { response: 1, checkboxChecked: false };
      }) as typeof nativeDialog.showMessageBox;
    });
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();
    const reviews = await aiden.app.evaluate(() => (globalThis as { __aidenLaunchReviews?: string[] }).__aidenLaunchReviews ?? []);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(FAKE_SERVER);

    // Approving that review approves the command it showed, and Aiden connects in the background.
    const status = page.getByLabel("E2E Tools status");
    await expect(status).toContainText("Connected", { timeout: 20_000 });
    await expect(status).toContainText("Tools 2");
    await expect(page.getByRole("switch", { name: "Enable E2E Tools" })).toHaveAttribute("data-state", "checked");
  });
});
