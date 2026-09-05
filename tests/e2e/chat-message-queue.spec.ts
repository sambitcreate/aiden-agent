import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  expectSquircleButtons,
  finishLmStudioOnboarding,
  REPOSITORY_ROOT,
  test,
  type CapturedLmStudioRequest,
} from "./fixtures";

function lastUserText(request: CapturedLmStudioRequest): string | undefined {
  const body = request.body as {
    messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  } | null;
  const user = body?.messages
    ?.slice()
    .reverse()
    .find((message) => message.role === "user");
  return typeof user?.content === "string"
    ? user.content
    : user?.content.map((part) => part.text ?? "").join("");
}

test("composer squircle follows resizing and draft growth without clipping access controls", async ({
  aiden,
}) => {
  const { page } = aiden;
  await expectSquircleButtons(page);
  await finishLmStudioOnboarding(page);
  await expectSquircleButtons(page);
  const shell = page.locator(".composer-shell");
  const composer = page.locator("textarea");
  expect(await page.evaluate(() => CSS.supports("corner-shape", "squircle"))).toBe(true);
  const assertShape = async () => {
    await expect(shell).toHaveCSS("corner-shape", "squircle");
    await expect(shell).toHaveCSS("border-top-left-radius", "40px");
    await expect(shell).toHaveCSS("overflow", "visible");
    await expect(shell).toHaveCSS("clip-path", "none");
    expect(await shell.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  };
  await assertShape();
  const initial = await shell.boundingBox();
  await composer.fill(Array.from({ length: 8 }, (_, index) => `Draft line ${index + 1}`).join("\n"));
  await expect.poll(async () => (await shell.boundingBox())!.height).toBeGreaterThan(initial!.height);
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 720));
  await expect.poll(async () => (await shell.boundingBox())!.width).toBeLessThan(initial!.width);
  await assertShape();
  await composer.fill("");
  const access = page.getByRole("button", { name: /^Workspace access: Ask first/u });
  await access.click();
  const options = page.getByRole("radiogroup", { name: "Workspace access" });
  const noAccess = options.getByRole("radio", { name: /^Workspace access: No access/u });
  // Clicking a choice above the shell also verifies that overflow is hit-testable.
  await expect(options).toBeVisible();
  await expectSquircleButtons(page);
  expect((await options.boundingBox())!.y).toBeLessThan((await shell.boundingBox())!.y);
  await noAccess.click();
  await expect(page.getByRole("button", { name: /^Workspace access: No access/u })).toBeVisible();
  await composer.fill("");
  await assertShape();
  await page.screenshot({ path: test.info().outputPath("squircle-composer.png") });
});

test("workspace bar auto-hides after sending and its appearance setting survives relaunch", async ({
  aiden,
}) => {
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const bar = () => page.locator(".composer-context-collapse");
  await expect(bar()).toBeVisible();
  await page.locator("textarea").fill("Hide the bar after this persisted user message.");
  await expect(bar()).toHaveAttribute("data-collapsed", "false");
  await page.locator("textarea").press("Enter");
  await expect(bar()).toHaveAttribute("data-collapsed", "true");
  await expect(bar()).toHaveAttribute("inert", "");
  await expect(bar()).toHaveAttribute("aria-hidden", "true");
  await expect(bar()).toBeHidden();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();

  const openAppearance = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings" })
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
  };
  const openSentChat = async () => {
    const back = page.getByRole("button", { name: "Back to app", exact: true });
    if (await back.isVisible()) await back.click();
    await page
      .locator("[data-sidebar]")
      .getByRole("button", { name: /^Deterministic E2E response/u })
      .click();
  };
  await openAppearance();
  const toggle = page.getByRole("switch", { name: "Auto-hide workspace bar", exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect
    .poll(async () => {
      const stored = JSON.parse(
        await readFile(path.join(aiden.userDataDir, "settings.json"), "utf8"),
      );
      return stored.settings?.appearance?.autoHideComposerContext;
    })
    .toBe(false);
  await openSentChat();
  await expect(bar()).toBeVisible();
  await expect(bar()).toHaveAttribute("data-collapsed", "false");

  page = await aiden.relaunch();
  await openSentChat();
  await expect(bar()).toBeVisible();
  await openAppearance();
  await expect(
    page.getByRole("switch", { name: "Auto-hide workspace bar", exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole("radiogroup", { name: "Reduce motion", exact: true })
    .getByRole("radio", { name: "On", exact: true })
    .click();
  await page.getByRole("switch", { name: "Auto-hide workspace bar", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await openSentChat();
  await expect(bar()).toBeHidden();
  expect(
    await bar().evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).transitionDuration),
    ),
  ).toBeLessThan(0.001);
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(bar()).toBeVisible();
});

test("an unsuccessful first message save keeps the workspace bar and draft visible", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await aiden.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("chats:appendMessage");
    ipcMain.handle("chats:appendMessage", () => {
      throw new Error("Queue test: message save rejected");
    });
  });
  await page.locator("textarea").fill("Keep this draft after a failed save.");
  await page.locator("textarea").press("Enter");
  await expect(page.getByText(/Queue test: message save rejected/u)).toBeVisible();
  await expect(page.locator("textarea")).toHaveValue("Keep this draft after a failed save.");
  await expect(page.locator(".composer-context-collapse")).toBeVisible();
  await expect(page.locator(".composer-context-collapse")).toHaveAttribute(
    "data-collapsed",
    "false",
  );
});

test("queued messages edit, reorder, delete and steer without changing the composer draft", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.holdCompletions!();
  const composer = page.locator("textarea");
  await composer.fill("First response held for queue controls.");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await composer.fill("Queued first");
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await composer.fill("Queued second");
  await page.getByRole("button", { name: "Queue message", exact: true }).click();
  const queue = page.getByRole("region", { name: "Queued messages", exact: true });
  await expect(queue.getByRole("listitem")).toHaveCount(2);
  await composer.fill("My separate unsent draft");
  await page.screenshot({ path: test.info().outputPath("queued-messages.png") });

  await queue.getByRole("button", { name: "Edit queued message 2", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit queued message", exact: true });
  const editText = editor.getByRole("textbox", { name: "Queued message text" });
  await expect(editText).toHaveValue("Queued second");
  await expectSquircleButtons(page);
  await page.screenshot({ path: test.info().outputPath("queued-message-editor.png") });
  await editText.fill("Discard this edit");
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(
    queue.getByRole("button", { name: "Edit queued message 2", exact: true }),
  ).toBeFocused();
  await queue.getByRole("button", { name: "Edit queued message 2", exact: true }).click();
  await expect(editText).toHaveValue("Queued second");
  await editText.fill("Edited priority message");
  await editor.getByRole("button", { name: "Move up", exact: true }).click();
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(queue.getByRole("listitem").first()).toContainText("Edited priority message");
  await expect(composer).toHaveValue("My separate unsent draft");

  // Keyboard ordering uses the same path as dragging and retains the focused row.
  const reorder = queue.getByRole("button", { name: "Reorder queued message 1", exact: true });
  await reorder.focus();
  await reorder.press("Alt+ArrowDown");
  await expect(queue.getByRole("listitem").last()).toContainText("Edited priority message");
  await queue.getByRole("button", { name: "Steer with queued message 2", exact: true }).click();
  await expect
    .poll(
      () =>
        lmStudio.requests.filter((request) => lastUserText(request) === "Edited priority message")
          .length,
    )
    .toBe(1);
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue.getByRole("listitem")).toContainText("Queued first");
  await expect(composer).toHaveValue("My separate unsent draft");
  await queue.getByRole("button", { name: "Delete queued message 1", exact: true }).click();
  await expect(queue).toBeHidden();
  await expect(composer).toBeFocused();
  lmStudio.releaseCompletions!();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  expect(
    lmStudio.requests.filter((request) => lastUserText(request) === "Queued first"),
  ).toHaveLength(0);
});

test("a response finishing while the queue editor is open waits for the saved edit", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.holdCompletions!();
  const composer = page.locator("textarea");
  await composer.fill("Hold until the queued editor opens.");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await composer.fill("Original queued text");
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await page.getByRole("button", { name: "Edit queued message 1", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit queued message", exact: true });
  await editor.getByRole("textbox", { name: "Queued message text" }).fill("Saved after completion");
  lmStudio.releaseCompletions!();
  await expect(
    page.getByRole("button", { name: "Stop generating", includeHidden: true }),
  ).toBeHidden();
  expect(
    lmStudio.requests.filter((request) => lastUserText(request) === "Original queued text"),
  ).toHaveLength(0);
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      () =>
        lmStudio.requests.filter((request) => lastUserText(request) === "Saved after completion")
          .length,
    )
    .toBe(1);
  await expect(page.getByRole("region", { name: "Queued messages" })).toBeHidden();
});

test("switching chats retains the queue without delivering it into another conversation", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.holdCompletions!();
  const composer = page.locator("textarea");
  await composer.fill("Original chat before navigating.");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  await composer.fill("Only send in the original chat");
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await page.getByRole("button", { name: "Pause queue", exact: true }).click();
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(page.getByRole("region", { name: "Queued messages" })).toBeHidden();
  await composer.fill("New chat draft");
  lmStudio.releaseCompletions!();
  await page
    .locator("[data-sidebar]")
    .getByRole("button", { name: /^Deterministic E2E response/u })
    .click();
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(queue).toContainText("Only send in the original chat");
  expect(
    lmStudio.requests.filter(
      (request) => lastUserText(request) === "Only send in the original chat",
    ),
  ).toHaveLength(0);
  await queue.getByRole("button", { name: "Resume queue", exact: true }).click();
  await expect(queue).toBeHidden();
  // The queue clears after durable append; the provider request starts asynchronously.
  await expect.poll(() => lmStudio.requests.some(
    (request) => lastUserText(request) === "Only send in the original chat",
  )).toBe(true);
  const request = lmStudio.requests.find(
    (request) => lastUserText(request) === "Only send in the original chat",
  );
  expect(JSON.stringify(request?.body)).toContain("Original chat before navigating.");
  expect(JSON.stringify(request?.body)).not.toContain("New chat draft");
});

test("queue keeps image attachments, pauses on Stop, and resumes FIFO exactly once", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  lmStudio.holdCompletions!();
  const composer = page.locator("textarea");
  await composer.fill("First response for stop and resume.");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();
  const image = (
    await readFile(path.join(REPOSITORY_ROOT, "renderer/assets/onboarding/aiden-workspace.png"))
  ).toString("base64");
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, image);
  await expect(
    page.getByRole("button", { name: "Remove Pasted image.png", exact: true }),
  ).toBeVisible();
  await composer.fill("Queued image first");
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await composer.fill("Queued text second");
  await expect(page.getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
  await composer.press("Enter");
  const queue = page.getByRole("region", { name: "Queued messages", exact: true });
  await expect(queue.getByRole("img", { name: "Pasted image.png" })).toBeVisible();
  await page.getByRole("button", { name: "Stop generating" }).click();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  await expect(queue.getByRole("button", { name: "Resume queue" })).toBeVisible();
  expect(
    lmStudio.requests.filter((request) => lastUserText(request)?.startsWith("Queued ")),
  ).toHaveLength(0);
  lmStudio.releaseCompletions!();
  await queue.getByRole("button", { name: "Resume queue" }).click();
  await expect(queue).toBeHidden();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  const queued = lmStudio.requests.filter((request) =>
    lastUserText(request)?.startsWith("Queued "),
  );
  expect(queued.map(lastUserText)).toEqual(["Queued image first", "Queued text second"]);
  expect(JSON.stringify(queued[0].body)).toContain(`data:image/png;base64,${image}`);
});
