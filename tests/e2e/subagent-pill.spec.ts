import type { Page } from "playwright";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

/** Scrolls the transcript that holds `inside` to its top, as reading back up the chat does. */
async function scrollTranscriptToTop(page: Page, inside: string) {
  await page.locator(inside).first().evaluate((element) => {
    let node: HTMLElement | null = element.parentElement;
    while (node && !(node.scrollHeight > node.clientHeight && /auto|scroll/u.test(getComputedStyle(node).overflowY))) {
      node = node.parentElement;
    }
    node?.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  });
}

test("one subagent indicator at a time: the card while it is on screen, the pill once it scrolls away", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  const composer = page.locator("textarea").first();

  // An earlier answer long enough that the transcript can scroll away from the card.
  const earlierPrompt = "Subagent pill test: write a long note first.";
  const earlier = lmStudio.enqueueStreamedReply!(earlierPrompt);
  await composer.fill(earlierPrompt);
  await page.getByRole("button", { name: "Send message" }).click();
  for (let index = 1; index <= 40; index += 1) earlier.push(`Paragraph ${index} of the earlier note.\n\n`);
  earlier.finish();
  await expect(page.getByText("Paragraph 40 of the earlier note.")).toBeVisible();

  // Two scouts whose replies the test holds open, so the batch keeps working.
  const alpha = lmStudio.enqueueStreamedReply!("E2E pill child alpha");
  const beta = lmStudio.enqueueStreamedReply!("E2E pill child beta");
  const prompt = "Subagent pill test: split the survey across two scouts.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      {
        name: "subagent",
        arguments: {
          tasks: [
            { role: "scout", label: "Survey the notes", task: "E2E pill child alpha" },
            { role: "scout", label: "Survey the tests", task: "E2E pill child beta" },
          ],
        },
      },
    ],
    finalText: "Both scouts reported back.",
  });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const cardHeader = page.getByRole("button", { name: /^Kicked off 2 scouts\./u });
  const pill = page.locator("[data-subagent-pill]");
  await expect(cardHeader).toBeVisible();
  // The card is the only indicator while it is on screen: no launch row, pill or toolbar count.
  await expect(pill).toHaveCount(0);
  await expect(page.getByText("Subagent", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /subagents? running/u })).toHaveCount(0);

  // Reading back up the chat moves the card away, and the pill takes over.
  await scrollTranscriptToTop(page, "[data-subagent-group]");
  await expect(page.getByText("Paragraph 1 of the earlier note.")).toBeInViewport();
  await expect(pill).toHaveCount(1);
  await expect(pill).toContainText(/working|starting|queued/u);

  // Show in chat brings the card back, and the pill steps aside again.
  await pill.getByRole("button", { name: /subagent details/u }).click();
  const tray = page.getByRole("dialog", { name: "Subagents" });
  await expect(tray).toBeVisible();
  await tray.getByRole("button", { name: "Show in chat" }).click();
  await expect(tray).toBeHidden();
  await expect(page.locator("[data-subagent-group]").first()).toBeInViewport();
  await expect(pill).toHaveCount(0);

  // The tray's shortcut still opens it while the card stands in for the pill.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+S" : "Control+Shift+S");
  await expect(tray).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tray).toBeHidden();
  await expect(pill).toHaveCount(0);

  // The batch finishes in view: its summary was seen, so no finished pill waits for later.
  alpha.push("The notes are fine.");
  alpha.finish();
  beta.push("The tests are fine.");
  beta.finish();
  await expect(page.getByText("Both scouts reported back.")).toBeVisible();
  expect(scenario.error).toBeUndefined();
  await expect(page.getByRole("button", { name: /^Ran 2 scouts\./u })).toBeVisible();
  await scrollTranscriptToTop(page, "[data-subagent-group]");
  await expect(page.getByText("Paragraph 1 of the earlier note.")).toBeInViewport();
  await expect(pill).toHaveCount(0);
});
