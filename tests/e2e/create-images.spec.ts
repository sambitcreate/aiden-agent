import type { Page } from "@playwright/test";
import type { WorkflowDocV1 } from "../../renderer/shared/images/schema";
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

/** Calls a Create Images channel from the editor's own document, as another surface would. */
async function invokeImages<T>(page: Page, channel: string, request: unknown): Promise<T> {
  return page.evaluate(
    ([name, payload]) =>
      (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc.invoke(
        name,
        payload,
      ),
    [channel, request] as const,
  ) as Promise<T>;
}

/** Saves a new revision of the Starter workflow from outside the open editor. */
async function saveElsewhere(page: Page, change: (doc: WorkflowDocV1) => WorkflowDocV1) {
  const { workflows } = await invokeImages<{ workflows: { id: string; title: string }[] }>(page, "imageWorkflows:list", {});
  const workflowId = workflows.find((workflow) => workflow.title === "Prompt to image")!.id;
  const { workflow } = await invokeImages<{ workflow: WorkflowDocV1 }>(page, "imageWorkflows:get", { workflowId });
  const saved = await invokeImages<{ ok: boolean }>(page, "imageWorkflows:save", {
    workflowId,
    baseRevision: workflow.revision,
    document: change(workflow),
  });
  expect(saved.ok).toBe(true);
}

const withPrompt = (text: string) => (doc: WorkflowDocV1): WorkflowDocV1 => ({
  ...doc,
  nodes: doc.nodes.map((node) => (node.type === "prompt" ? { ...node, data: { text } } : node)),
});

async function openStarterFromList(page: Page) {
  await page.getByRole("list", { name: "Image workflows" }).getByRole("button", { name: "Prompt to image", exact: true }).click();
  const canvas = page.getByRole("region", { name: "Images canvas" });
  await expect(canvas).toBeVisible();
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

  // Network posture: Create Images reaches OpenRouter only for consented image requests.
  test.afterEach(async ({ aiden }) => {
    expect(aiden.openRouter!.otherRequests).toEqual([]);
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
    // The fake reports token usage, which Aiden prices from the bundled catalog: exactly one cost line.
    await expect(panel).toContainText(/\$\d+\.\d{4} reported/u);
    // Focus returns to the run action, which became Stop and then Run All again; it is never lost.
    await expect(aiden.page.getByRole("button", { name: "Run All" })).toBeFocused();
  });

  test("cancelling the consent sheet sends nothing", async ({ aiden }) => {
    await newStarter(aiden.page, "A blue kite");
    const sheet = await reviewRun(aiden.page);
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
    await expect(aiden.page.getByRole("region", { name: "Run" })).toHaveCount(0);
    expect(aiden.openRouter!.imageRequests).toEqual([]);
  });

  test("Stop aborts the request on the wire, records it may have been billed, and sends nothing after it", async ({ aiden }) => {
    const { page } = aiden;
    const openRouter = aiden.openRouter!;
    await newStarter(page, "A yellow balloon");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await openImages(page);
    // A second Generate step that waits for the first one's image, so a request remains after Stop.
    await saveElsewhere(page, (doc) => {
      const prompt = doc.nodes.find((node) => node.type === "prompt")!;
      const first = doc.nodes.find((node) => node.type === "generate-image")!;
      const second = { ...first, id: "second-step", position: { x: first.position.x, y: first.position.y + 320 } };
      return {
        ...doc,
        nodes: [...doc.nodes, second],
        edges: [
          ...doc.edges,
          { id: "second-prompt", source: prompt.id, sourcePort: "text", target: second.id, targetPort: "prompt" },
          { id: "second-reference", source: first.id, sourcePort: "images", target: second.id, targetPort: "references" },
        ],
      };
    });
    await openStarterFromList(page);

    openRouter.hold();
    await page.getByRole("button", { name: "Run All" }).click();
    await page.getByRole("dialog", { name: "Send 2 image requests?" }).getByRole("button", { name: "Generate" }).click();
    await expect.poll(() => openRouter.imageRequests.length).toBe(1);
    const panel = page.getByRole("region", { name: "Run" });
    await panel.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => openRouter.abortedRequests).toBe(1);
    // The headline reads Stopped only once the run has ended, so no request can follow it.
    await expect(panel.getByRole("status")).toHaveText("Stopped");
    openRouter.release();
    expect(openRouter.imageRequests).toHaveLength(1);

    const requests = panel.getByRole("list", { name: "Image requests in this run" }).getByRole("listitem");
    await expect(requests).toHaveCount(2);
    await expect(requests.nth(0)).toContainText("may have been billed");
    await expect(requests.nth(1)).toContainText("Stopped");
    await expect(requests.nth(1)).not.toContainText("billed");
  });

  test("Retry from here reruns the node and what follows it", async ({ aiden }) => {
    const openRouter = aiden.openRouter!;
    const { canvas, panel } = await succeedThenFail(aiden.page, openRouter, "A red kite");
    const firstImage = await canvas.getByRole("img", IMAGE_ONE).getAttribute("src");
    await panel.getByRole("button", { name: "Retry from here" }).click();
    const sheet = aiden.page.getByRole("dialog", { name: CONSENT_ONE_REQUEST });
    await expect(sheet).toContainText("everything after it will run");
    expect(openRouter.imageRequests).toHaveLength(2); // the consent sheet sent nothing
    await sheet.getByRole("button", { name: "Generate" }).click();
    await expect(panel).toContainText("Finished");
    expect(openRouter.imageRequests).toHaveLength(3);
    // The Output node ran too: it now shows the retried request's image, not the first run's.
    await expect(canvas.getByRole("img", IMAGE_ONE)).not.toHaveAttribute("src", firstImage!);
    await expect(canvas.getByText("Out of date")).toHaveCount(0);
  });

  test("Retry this node only keeps the previous output and marks it out of date", async ({ aiden }) => {
    const openRouter = aiden.openRouter!;
    const { canvas, panel } = await succeedThenFail(aiden.page, openRouter, "A blue kite");
    const firstImage = await canvas.getByRole("img", IMAGE_ONE).getAttribute("src");
    await panel.getByRole("button", { name: "Retry this node only" }).click();
    const sheet = aiden.page.getByRole("dialog", { name: CONSENT_ONE_REQUEST });
    await expect(sheet).toContainText("Only this node will run");
    expect(openRouter.imageRequests).toHaveLength(2);
    await sheet.getByRole("button", { name: "Generate" }).click();
    await expect(panel).toContainText("Finished");
    expect(openRouter.imageRequests).toHaveLength(3);
    // The Output node keeps the first run's image and says it is out of date until it runs.
    await expect(canvas.getByText("Out of date")).toBeVisible();
    await expect(canvas.getByRole("img", IMAGE_ONE)).toHaveAttribute("src", firstImage!);
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
    await expect(confirm).toContainText("and 1 image.");
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

  test("deleting a node is one undo step that restores it with its connections", async ({ aiden }) => {
    const canvas = await newStarter(aiden.page, "A copper kettle");
    const nodes = canvas.locator(".react-flow__node");
    const edges = canvas.locator(".react-flow__edge");
    await expect(nodes).toHaveCount(3);
    await expect(edges).toHaveCount(2);
    await canvas.getByText("Generate Image", { exact: true }).click();
    await aiden.page.keyboard.press("Backspace");
    await expect(nodes).toHaveCount(2);
    await expect(edges).toHaveCount(0);
    await aiden.page.getByRole("button", { name: "Undo" }).click();
    await expect(nodes).toHaveCount(3);
    await expect(edges).toHaveCount(2);
  });

  test("an edit that cannot be saved keeps the editor open until the user chooses", async ({ aiden }) => {
    const { page } = aiden;
    const canvas = await newStarter(page, "A red bicycle");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await saveElsewhere(page, withPrompt("Saved elsewhere"));
    const prompt = canvas.getByRole("textbox", { name: "Prompt text" });
    await prompt.fill("My local edit");
    await expect(page.getByText("Changed elsewhere", { exact: true })).toBeVisible();

    // Leaving would lose the edit, so the editor asks; staying keeps it and quit stays guarded.
    await openImages(page);
    const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Cancel" }).click();
    await expect(leave).toBeHidden();
    await expect(prompt).toHaveValue("My local edit");
    await expect(page.locator("html")).toHaveAttribute("data-aiden-dirty", "1");

    await page.getByRole("button", { name: "Keep My Version" }).click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await openImages(page);
    await expect(leave).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-aiden-dirty", "0");
    await expect((await openStarterFromList(page)).getByRole("textbox", { name: "Prompt text" })).toHaveValue("My local edit");
  });

  test("reloading after a conflict asks before it discards the local edit", async ({ aiden }) => {
    const { page } = aiden;
    const canvas = await newStarter(page, "A green bicycle");
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await saveElsewhere(page, withPrompt("Saved elsewhere"));
    const prompt = canvas.getByRole("textbox", { name: "Prompt text" });
    await prompt.fill("My local edit");
    await page.getByRole("button", { name: "Discard and Reload…" }).click();
    const discard = page.getByRole("alertdialog", { name: "Discard your changes?" });
    await discard.getByRole("button", { name: "Cancel" }).click();
    await expect(prompt).toHaveValue("My local edit");

    await page.getByRole("button", { name: "Discard and Reload…" }).click();
    await discard.getByRole("button", { name: "Discard and Reload" }).click();
    await expect(canvas.getByRole("textbox", { name: "Prompt text" })).toHaveValue("Saved elsewhere");
    await expect(page.locator("html")).toHaveAttribute("data-aiden-dirty", "0");
  });

  test("quitting right after an edit saves it instead of stopping on the unsaved prompt", async ({ aiden }) => {
    await newStarter(aiden.page, "A quick quit");
    await expect(aiden.page.getByText("Unsaved changes", { exact: true })).toBeVisible();
    const page = await aiden.relaunch();
    await openImages(page);
    await expect((await openStarterFromList(page)).getByRole("textbox", { name: "Prompt text" })).toHaveValue("A quick quit");
  });
});
