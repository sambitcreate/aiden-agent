import type { Page } from "@playwright/test";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test, waitForToastsToClear } from "./fixtures";
import type { LmStudioEndpoint } from "./fixtures";

test.use({ workspaceSeed: true });

async function ipc<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ channel, args }) =>
      (
        window as unknown as {
          aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } };
        }
      ).aidenAPI.ipc.invoke(channel, ...args),
    { channel, args },
  ) as Promise<T>;
}

/** The last model request that carried `prompt`, as text, or "" before it is sent. */
function requestWith(lmStudio: LmStudioEndpoint, prompt: string): string {
  const matching = lmStudio.requests
    .map((request) => JSON.stringify(request.body ?? ""))
    .filter((body) => body.includes(prompt));
  return matching[matching.length - 1] ?? "";
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator("textarea").first().fill(text);
  await page.locator("textarea").first().press("Enter");
}

test("a skill switched off in Workspace settings is gone from the next message", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  await ipc(page, "skills:save", {
    id: "skill-release-notes",
    name: "Release notes",
    description: "Draft release notes from merged changes.",
    instructions: "Write release notes.",
    enabled: true,
  });

  await send(page, "Workspace settings check one");
  await expect(page.locator("[data-chat-title-menu]")).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => requestWith(lmStudio, "Workspace settings check one")).toContain("skill_release_notes");
  await waitForToastsToClear(page);

  // The row's ⋯ button shows on hover.
  await page.getByRole("button", { name: "Collapse Aiden E2E workspace" }).hover();
  await page.getByRole("button", { name: "Actions for Aiden E2E workspace" }).click();
  await page.getByRole("menuitem", { name: "Workspace settings…" }).click();
  const dialog = page.getByRole("dialog", { name: "Workspace settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Aiden E2E workspace");

  await dialog.getByRole("tab", { name: "Skills" }).click();
  const releaseNotes = dialog.getByRole("switch", { name: "Use Release notes in this workspace" });
  await expect(releaseNotes).toBeChecked();
  await releaseNotes.click();
  await expect(releaseNotes).not.toBeChecked();
  await expect(dialog.locator('[data-workspace-skill="release notes"]').getByText("Off here", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await ipc<{ disabledSkills?: string[] }>(page, "workspaces:get", E2E_WORKSPACE_ID)).disabledSkills)
    .toEqual(["release notes"]);

  // Arrow keys move between sections, and Done closes the dialog.
  await dialog.getByRole("tab", { name: "Skills" }).press("ArrowDown");
  await expect(dialog.getByRole("tab", { name: "Connectors" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("No connectors yet. Add one in Settings → Connectors.")).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await send(page, "Workspace settings check two");
  await expect.poll(() => requestWith(lmStudio, "Workspace settings check two")).not.toBe("");
  expect(requestWith(lmStudio, "Workspace settings check two")).not.toContain("skill_release_notes");

  // The shortcut opens the same settings for the workspace in use.
  await page.locator("textarea").first().click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Comma" : "Control+Shift+Comma");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
