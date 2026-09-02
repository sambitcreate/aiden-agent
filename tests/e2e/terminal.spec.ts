import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

test("workspace terminal opens a real PTY, runs a shell command, and persists output", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);

  const toggle = page.getByRole("button", { name: "Show terminal" });
  await expect(toggle).toBeEnabled();
  await toggle.click();

  const drawer = page.locator('.terminal-drawer[data-state="open"]');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Terminal 1", { exact: true })).toBeVisible();
  const hideTerminal = drawer.getByRole("button", { name: "Hide terminal" });
  await expect(hideTerminal).toBeVisible();

  await drawer.locator(".ghostty-screen").click();
  await page.keyboard.type("echo $((314159+271828)); pwd");
  await page.keyboard.press("Enter");

  const historyFile = path.join(
    aiden.userDataDir,
    "terminal-history",
    `${createHash("sha256").update(E2E_WORKSPACE_ID).digest("hex")}.log`,
  );
  await expect
    .poll(
      async () => {
        try {
          return await readFile(historyFile, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
          throw error;
        }
      },
      { timeout: 15_000 },
    )
    .toContain("585987");
  await expect.poll(() => readFile(historyFile, "utf8")).toContain(aiden.workspaceDir);

  await hideTerminal.click();
  await expect(page.getByRole("button", { name: "Show terminal" })).toBeVisible();
  await expect(page.locator(".terminal-drawer")).toHaveCount(0);
});
