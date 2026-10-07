import type { Page } from "@playwright/test";
import type { FakeOpenRouter } from "./fake-openrouter";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const NANO_BANANA_LABEL = "OpenRouter · Google: Nano Banana 2 (Gemini 3.1 Flash Image)";
const CONSENT_ONE_REQUEST = "Send 1 image request?";
const IMAGE_ONE = { name: "Generated image 1", exact: true };

async function openImages(page: Page) {
  await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Images", exact: true }).click();
}

async function newStarter(page: Page, prompt: string) {
  await finishLmStudioOnboarding(page);
  await openImages(page);
  await page.getByRole("button", { name: "New from Starter" }).first().click();
  const canvas = page.getByRole("region", { name: "Images canvas" });
  await expect(canvas).toBeVisible();
  await canvas.getByRole("textbox", { name: "Prompt text" }).fill(prompt);
  await expect(canvas.getByRole("button", { name: "Image model" })).toContainText("Nano Banana 2");
  return canvas;
}

/** Run All opens the consent sheet. Nothing is sent until its Generate button is pressed. */
async function reviewRun(page: Page) {
  await page.getByRole("button", { name: "Run All" }).click();
  const sheet = page.getByRole("dialog", { name: CONSENT_ONE_REQUEST });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(NANO_BANANA_LABEL);
  await expect(sheet).toContainText("Estimate unavailable");
  return sheet;
}

/** One successful run, then a second run whose request fails. The Output node still holds the first image. */
async function succeedThenFail(page: Page, openRouter: FakeOpenRouter, prompt: string) {
  const canvas = await newStarter(page, prompt);
  await (await reviewRun(page)).getByRole("button", { name: "Generate" }).click();
  await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();
  const panel = page.getByRole("region", { name: "Run" });
  await expect(panel).toContainText("Finished");
  openRouter.failNext();
  await (await reviewRun(page)).getByRole("button", { name: "Generate" }).click();
  await expect(panel).toContainText("Failed");
  expect(openRouter.imageRequests).toHaveLength(2);
  await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();
  return { canvas, panel };
}

test.describe("Create Images", () => {
  test.use({
    workspaceSeed: true,
    fakeOpenRouter: true,
    appEnvironment: { AIDEN_EXPERIMENTAL_CREATE_IMAGES: "1" },
  });

  test("a starter workflow generates one image only after explicit consent", async ({ aiden }) => {
    const canvas = await newStarter(aiden.page, "A red bicycle at dawn");
    const sheet = await reviewRun(aiden.page);
    expect(aiden.openRouter!.imageRequests).toEqual([]);
    await sheet.getByRole("button", { name: "Generate" }).click();
    await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();
    expect(aiden.openRouter!.imageRequests).toEqual([
      { model: "google/gemini-3.1-flash-image", prompt: "A red bicycle at dawn", references: 0 },
    ]);
    const panel = aiden.page.getByRole("region", { name: "Run" });
    await expect(panel).toContainText("Finished");
    await expect(panel).toContainText(/reported|Cost not reported/u);
  });

  test("cancelling the consent sheet sends nothing", async ({ aiden }) => {
    await newStarter(aiden.page, "A blue kite");
    const sheet = await reviewRun(aiden.page);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(aiden.page.getByRole("region", { name: "Run" })).toHaveCount(0);
    expect(aiden.openRouter!.imageRequests).toEqual([]);
  });

  test("Stop during a request records that it may have been billed", async ({ aiden }) => {
    aiden.openRouter!.hold();
    await newStarter(aiden.page, "A yellow balloon");
    await (await reviewRun(aiden.page)).getByRole("button", { name: "Generate" }).click();
    await expect.poll(() => aiden.openRouter!.imageRequests.length).toBe(1);
    const panel = aiden.page.getByRole("region", { name: "Run" });
    await panel.getByRole("button", { name: "Stop" }).click();
    await expect(panel).toContainText("Stopped");
    await expect(panel).toContainText("may have been billed");
    aiden.openRouter!.release();
    expect(aiden.openRouter!.imageRequests).toHaveLength(1);
  });

  test("Retry from here reruns the node and what follows it", async ({ aiden }) => {
    const openRouter = aiden.openRouter!;
    const { canvas, panel } = await succeedThenFail(aiden.page, openRouter, "A red kite");
    await panel.getByRole("button", { name: "Retry from here" }).click();
    const sheet = aiden.page.getByRole("dialog", { name: CONSENT_ONE_REQUEST });
    await expect(sheet).toContainText("everything after it will run");
    expect(openRouter.imageRequests).toHaveLength(2); // the consent sheet sent nothing
    await sheet.getByRole("button", { name: "Generate" }).click();
    await expect(panel).toContainText("Finished");
    expect(openRouter.imageRequests).toHaveLength(3);
    await expect(canvas.getByText("Out of date")).toHaveCount(0);
    await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();
  });

  test("Retry this node only keeps the previous output and marks it out of date", async ({ aiden }) => {
    const openRouter = aiden.openRouter!;
    const { canvas, panel } = await succeedThenFail(aiden.page, openRouter, "A blue kite");
    await panel.getByRole("button", { name: "Retry this node only" }).click();
    const sheet = aiden.page.getByRole("dialog", { name: CONSENT_ONE_REQUEST });
    await expect(sheet).toContainText("Only this node will run");
    expect(openRouter.imageRequests).toHaveLength(2);
    await sheet.getByRole("button", { name: "Generate" }).click();
    await expect(panel).toContainText("Finished");
    expect(openRouter.imageRequests).toHaveLength(3);
    // The Output node keeps the first run's image and says it is out of date until it runs.
    await expect(canvas.getByText("Out of date")).toBeVisible();
    await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();
  });

  test("a crash mid-run shows Interrupted, and a fresh consent sends exactly one more request", async ({ aiden }) => {
    aiden.openRouter!.hold();
    await newStarter(aiden.page, "A green lantern");
    await (await reviewRun(aiden.page)).getByRole("button", { name: "Generate" }).click();
    await expect.poll(() => aiden.openRouter!.imageRequests.length).toBe(1);

    // The process dies with the paid request on the wire: no quit path runs.
    process.kill(aiden.app.process().pid!, "SIGKILL");
    aiden.openRouter!.release();
    const page = await aiden.relaunch();

    await openImages(page);
    await page
      .getByRole("list", { name: "Image workflows" })
      .getByRole("button", { name: "Prompt to image", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "Run" });
    await expect(panel).toContainText("Interrupted when Aiden quit");
    await expect(panel).toContainText("may have been billed");
    expect(aiden.openRouter!.imageRequests).toHaveLength(1);

    await (await reviewRun(page)).getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("region", { name: "Images canvas" }).getByRole("img", IMAGE_ONE)).toBeVisible();
    expect(aiden.openRouter!.imageRequests).toHaveLength(2);
  });

  test("deleting a workflow names its image count and removes it after confirmation", async ({ aiden }) => {
    const canvas = await newStarter(aiden.page, "A paper crane");
    await (await reviewRun(aiden.page)).getByRole("button", { name: "Generate" }).click();
    await expect(canvas.getByRole("img", IMAGE_ONE)).toBeVisible();

    await openImages(aiden.page);
    await aiden.page.getByRole("button", { name: "More actions for Prompt to image" }).click();
    await aiden.page.getByRole("menuitem", { name: "Delete…" }).click();
    const confirm = aiden.page.getByRole("alertdialog", { name: "Delete “Prompt to image”?" });
    await expect(confirm).toContainText("1 generated image");
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(aiden.page.getByText("No image workflows yet", { exact: true })).toBeVisible();
    expect(aiden.openRouter!.imageRequests).toHaveLength(1);
  });

  test("a delete while a run is in flight is refused and the workflow stays", async ({ aiden }) => {
    aiden.openRouter!.hold();
    await newStarter(aiden.page, "A glass fish");
    await (await reviewRun(aiden.page)).getByRole("button", { name: "Generate" }).click();
    await expect.poll(() => aiden.openRouter!.imageRequests.length).toBe(1);

    await openImages(aiden.page);
    await aiden.page.getByRole("button", { name: "More actions for Prompt to image" }).click();
    await aiden.page.getByRole("menuitem", { name: "Delete…" }).click();
    try {
      await aiden.page.getByRole("alertdialog", { name: "Delete “Prompt to image”?" }).getByRole("button", { name: "Delete", exact: true }).click();
      await expect(aiden.page.getByRole("alert")).toContainText("Stop the run first, then delete this workflow.");
      await expect(aiden.page.getByRole("list", { name: "Image workflows" }).getByRole("button", { name: "Prompt to image", exact: true })).toBeVisible();
    } finally {
      // Let the held request finish so the app can quit without a native confirmation.
      aiden.openRouter!.release();
    }
    // The held run finished in the background; reopening the workflow shows its image.
    await aiden.page.getByRole("list", { name: "Image workflows" }).getByRole("button", { name: "Prompt to image", exact: true }).click();
    await expect(aiden.page.getByRole("region", { name: "Images canvas" }).getByRole("img", IMAGE_ONE)).toBeVisible();
  });
});
