import type { Page } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

// Computer Use in a keep-going round on screen. It drives real macOS apps
// through cua-driver, so it needs a Mac whose Accessibility and Screen
// Recording permissions are already granted to the Electron under test, and
// it runs only on that host display: set AIDEN_E2E_COMPUTER_USE_HOST=1.
test.skip(
  process.platform !== "darwin" || process.env.AIDEN_E2E_COMPUTER_USE_HOST !== "1",
  "Computer Use rounds run only on a macOS host with Computer Use permissions (AIDEN_E2E_COMPUTER_USE_HOST=1).",
);

const REVIEW_PROMPT = "You are now checking whether the goal set in this chat is done";

function invoke<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ channel, args }) => {
      const { ipc } = (
        window as unknown as {
          aidenAPI: { ipc: { invoke<T>(name: string, ...args: unknown[]): Promise<T> } };
        }
      ).aidenAPI;
      return ipc.invoke<T>(channel, ...args);
    },
    { channel, args },
  );
}

test("a round on screen can use Computer Use after the person allows it in the chat", async ({
  aiden,
}) => {
  test.setTimeout(180_000);
  const { lmStudio, page } = aiden;
  await finishLmStudioOnboarding(page);
  await invoke(page, "computerUse:setEnabled", true);
  lmStudio.answerToolFreeCompletions!(
    REVIEW_PROMPT,
    '{"verdict": "continue", "reason": "Finder has not been checked yet."}',
    { times: 1 },
  );
  lmStudio.answerToolFreeCompletions!(
    REVIEW_PROMPT,
    '{"verdict": "done", "reason": "Finder is listed."}',
  );
  const round = lmStudio.enqueueToolScenario!({
    prompt: "Keep going · round 2 of 50",
    calls: [{ name: "computer_use", arguments: { action: "list_apps" } }],
    finalText: "Finder is running.",
  });

  const composer = page.locator("textarea");
  await composer.fill("/goal Check that Finder is running");
  await composer.press("Enter");
  const bar = page.getByRole("group", { name: "Goal: Check that Finder is running" });
  await expect(bar).toBeVisible({ timeout: 15_000 });

  // The round is this window's own run, so Computer Use asks here, as for the person's own message.
  await page.getByRole("button", { name: "Allow in this chat" }).click({ timeout: 45_000 });
  await expect.poll(() => round.completed, { timeout: 60_000 }).toBe(true);
  expect(round.issuedToolNames).toEqual(["computer_use"]);
  expect(JSON.stringify(round.results[0]?.content ?? "")).not.toMatch(
    /not available in this (?:round|turn)/u,
  );
  await expect(bar).toHaveAttribute("data-goal-status", "done", { timeout: 30_000 });
});
