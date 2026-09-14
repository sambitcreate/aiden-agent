import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { DIRECTIONS, validLook } from "../src/model";
test("all ten directions change the preview and reset their settings", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  for (const direction of DIRECTIONS) {
    await page
      .locator(".direction")
      .filter({ hasText: direction.name })
      .click();
    await expect(page.locator("h1")).toHaveText(`${direction.name}.`);
    await expect(page.getByLabel("Current terminal preview")).toHaveAttribute(
      "data-layout",
      direction.look.layout.arrangement,
    );
  }
  expect(errors).toEqual([]);
});
test("DialKit values change the actual preview, save, reload, restore and export", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator(".direction").filter({ hasText: "Midnight" }).click();
  await page.getByRole("button", { name: "Mode Dark", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator(".preview-label em")).toHaveText("Modified");
  await page
    .getByLabel("YOUR CUSTOMIZATION NOTES")
    .fill("Keep the split view in daylight.");
  await page.getByRole("button", { name: "Save look", exact: true }).click();
  await page.getByLabel("Look name").fill("My daylight split");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save look" })
    .click();
  await page.reload();
  await expect(page.locator("h1")).toHaveText("Midnight.");
  await page.locator(".direction").filter({ hasText: "Quiet" }).click();
  await page
    .getByRole("button", { name: "My daylight split", exact: true })
    .click();
  await expect(page.getByLabel("Current terminal preview")).toHaveAttribute(
    "data-layout",
    "split",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export brief" }).click();
  const download = await downloadPromise;
  const brief = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(brief.settings.appearance.mode).toBe("light");
  expect(brief.notes).toBe("Keep the split view in daylight.");
  expect(brief.scope).toContain("Do not apply");
  expect(validLook(brief.settings)).toBe(true);
});
test("comparison, demo approval, prompt and replay work", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByLabel("Comparison baseline").selectOption("paper");
  await expect(page.getByLabel("Baseline terminal preview")).toHaveAttribute(
    "data-layout",
    "journal",
  );
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await page.getByRole("button", { name: "Approval", exact: true }).click();
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(page.getByText("Allowed once — preview only.")).toBeVisible();
  await page
    .getByLabel("Current demo prompt", { exact: true })
    .fill("More space please");
  await page.getByLabel("Send Current demo prompt").click();
  await expect(
    page.getByText("More space please", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Pause preview").click();
  await expect(page.getByLabel("Current terminal preview")).toHaveAttribute(
    "data-motion",
    "none",
  );
  await page.getByLabel("Replay preview").click();
  await expect(
    page.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeVisible();
});
test("small screens fit, reduced motion is honored, corrupt saved data is ignored", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "aiden-cli-studio:v1:saved",
      '[{"id":"broken","look":null}]',
    ),
  );
  await page.goto("/");
  for (const direction of DIRECTIONS) {
    await page
      .locator(".direction")
      .filter({ hasText: direction.name })
      .click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(page.locator(".saved-row")).toHaveCount(0);
  expect(
    await page
      .locator(".live-dot")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});
