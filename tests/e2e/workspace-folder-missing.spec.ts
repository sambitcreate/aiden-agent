import { rename } from "node:fs/promises";
import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==";

test("a moved workspace folder is named above the composer and the message waits until it is back", async ({
  aiden,
}) => {
  test.setTimeout(120_000);
  const { page, workspaceDir } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");
  await composer.fill("Hello before the folder moves");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1, { timeout: 15_000 });
  // Let the first response settle so the next Enter sends instead of queueing.
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 15_000 });

  const moved = `${workspaceDir}-moved`;
  await rename(workspaceDir, moved);
  const question = "Are you still there?";
  await composer.fill(question);
  await composer.press("Enter");

  const notice = page.getByRole("status", { name: "Workspace folder missing" });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("Aiden E2E workspace");
  await expect(notice).toContainText("moved, renamed or deleted");
  // Nothing was sent: the text stays in the composer and no reply arrives.
  await expect(composer).toHaveValue(question);
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1);

  await rename(moved, workspaceDir);
  await notice.getByRole("button", { name: "Check again" }).click();
  await expect(notice).toHaveCount(0);
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(2, { timeout: 15_000 });
});

test("Continue in a new chat carries a chat whose folder is gone, and the unsent message, into another workspace", async ({
  aiden,
}) => {
  test.setTimeout(120_000);
  const { page, workspaceDir } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea");
  await composer.fill("Hello before the folder moves");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 15_000 });
  // A second workspace to continue in, made after the chat so the chat stays in the seeded one.
  await page.evaluate(async () => {
    const bridge = (
      window as unknown as { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } }
    ).aidenAPI.ipc;
    await bridge.invoke("workspaces:create", { name: "Another workspace", permission: "ask" });
  });
  // Creating a workspace over IPC does not notify the window, so reload to list it.
  await page.reload();
  await expect(page.getByText("Hello before the folder moves")).toBeVisible();

  await rename(workspaceDir, `${workspaceDir}-moved`);
  const question = "Where were we?";
  await composer.fill(question);
  await composer.evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const clipboard = new DataTransfer();
    clipboard.items.add(new File([bytes], "clipboard.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }));
  }, ONE_PIXEL_PNG_BASE64);
  const removeImage = page.getByRole("button", { name: "Remove Pasted image.png" });
  await expect(removeImage).toBeVisible();
  await composer.press("Enter");
  const notice = page.getByRole("status", { name: "Workspace folder missing" });
  await expect(notice).toBeVisible({ timeout: 15_000 });

  await notice.getByRole("button", { name: "Continue in a new chat" }).click();
  await page.getByRole("menuitem", { name: "Another workspace" }).click();

  // The new chat has the conversation and the unsent message, and its folder is fine.
  await expect(notice).toHaveCount(0, { timeout: 15_000 });
  // The unsent message arrives with its image.
  await expect(composer).toHaveValue(question);
  await expect(removeImage).toBeVisible();
  await expect(page.getByText("Hello before the folder moves")).toBeVisible();
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1);
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(2, { timeout: 15_000 });
});
