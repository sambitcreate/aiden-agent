import { execFileSync } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { E2E_ASSISTANT_RESPONSE, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

function worktreePath(repository: string, branch: string): string {
  const lines = execFileSync("git", ["-C", repository, "worktree", "list", "--porcelain"], { encoding: "utf8" }).split("\n");
  const at = lines.indexOf(`branch refs/heads/${branch}`);
  const path = lines.slice(0, at).reverse().find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  if (at < 0 || !path) throw new Error(`No worktree on ${branch}`);
  return path;
}

test("a chat whose worktree folder was deleted waits, then restores the worktree or carries the message to the main checkout", async ({
  aiden,
}) => {
  test.setTimeout(150_000);
  const { page, workspaceDir } = aiden;
  execFileSync("git", ["init", "-b", "main", workspaceDir]);
  execFileSync("git", [
    "-C", workspaceDir,
    "-c", "user.email=e2e@example.com",
    "-c", "user.name=Aiden E2E",
    "commit", "--allow-empty", "-m", "init",
  ]);
  await finishLmStudioOnboarding(page);
  await page.locator('[role="group"][aria-label="Composer workspace bar"]').getByRole("button", { name: "main", exact: true }).click();
  await page.getByRole("radiogroup", { name: "Work in" }).getByRole("radio", { name: /^New worktree/u }).click();
  await page.keyboard.press("Escape");
  const composer = page.locator("textarea");
  await composer.fill("Fix the login bug");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Stop generating" })).toHaveCount(0, { timeout: 15_000 });

  // The worktree folder is deleted outside Aiden; its branch stays.
  const checkout = worktreePath(workspaceDir, "aiden/fix-the-login-bug");
  await rm(checkout, { recursive: true, force: true });
  const next = "Now add a test for it";
  await composer.fill(next);
  await composer.press("Enter");

  const notice = page.getByRole("status", { name: "Worktree folder missing" });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("aiden/fix-the-login-bug is still there");
  await expect(composer).toHaveValue(next);
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(1);

  // A new chat in the main checkout takes the unsent message along; this chat is left as it was.
  await notice.getByRole("button", { name: "New chat in main checkout" }).click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveValue(next);
  // It runs in the main checkout, not in another new worktree.
  await expect(page.locator("[data-draft-worktree-hint]")).toHaveCount(0);
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(0);

  // Back in the worktree chat, Restore puts the folder back on its branch and the message can go.
  await page.getByRole("button", { name: /^Expand workspace · aiden\/fix-the-login-bug/u }).click();
  await page.getByRole("complementary").getByRole("button", { name: /Worktree on aiden\/fix-the-login-bug$/u }).click();
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await notice.getByRole("button", { name: "Restore worktree" }).click();
  await expect(notice).toHaveCount(0, { timeout: 30_000 });
  expect((await stat(checkout)).isDirectory()).toBe(true);
  expect(execFileSync("git", ["-C", checkout, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe(
    "aiden/fix-the-login-bug",
  );
  await expect(composer).toHaveValue(next);
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toHaveCount(2, { timeout: 30_000 });
});
