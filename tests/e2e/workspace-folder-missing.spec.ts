import { rename } from "node:fs/promises";
import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

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
