import type { Locator } from "@playwright/test";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const PROMPT = "Stream a long structured answer for the follow-the-bottom check.";

type Chunk = { text: string; marker: string };

/** Fifty deltas that grow the reply by headings, paragraphs, list items, and table rows. */
function replyChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  for (let index = 1; index <= 50; index += 1) {
    const step = index % 10;
    if (step === 1) chunks.push({ text: `## Section ${index}\n\n`, marker: `Section ${index}` });
    else if (step < 5) {
      chunks.push({
        text: `Paragraph ${index} explains one more step in enough words to wrap the line. `.repeat(2) + "\n\n",
        marker: `Paragraph ${index} explains`,
      });
    } else if (step < 8) {
      chunks.push({ text: `- List item ${index} with a short note\n${step === 7 ? "\n" : ""}`, marker: `List item ${index}` });
    } else if (step === 8) {
      chunks.push({ text: `| Step | Result |\n| --- | --- |\n| ${index} | row ${index} |\n`, marker: `row ${index}` });
    } else chunks.push({ text: `| ${index} | row ${index} |\n\n`, marker: `row ${index}` });
  }
  return chunks;
}

/** Waits until the reveal has caught up with `chunk` in the transcript. */
async function revealed(viewport: Locator, chunk: Chunk): Promise<void> {
  await expect
    .poll(() => viewport.evaluate((element, marker) => element.textContent?.includes(marker) ?? false, chunk.marker), {
      message: `"${chunk.marker}" is on screen`,
      timeout: 15_000,
    })
    .toBe(true);
}

function distanceFromBottom(viewport: Locator): Promise<number> {
  return viewport.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

test("the transcript follows a streaming reply until the reader scrolls up, and the jump lands at the bottom", async ({
  aiden,
}) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.enqueueStreamedReply, "needs the deterministic model to pace the stream");
  await finishLmStudioOnboarding(page);
  const reply = lmStudio.enqueueStreamedReply!(PROMPT);
  const chunks = replyChunks();

  const composer = page.locator("textarea");
  await composer.fill(PROMPT);
  await composer.press("Enter");
  const viewport = page.locator("[data-follow]").first();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  // Phase 1: every chunk lands with the transcript pinned to its last line.
  for (const [index, chunk] of chunks.slice(0, 40).entries()) {
    reply.push(chunk.text);
    await revealed(viewport, chunk);
    await expect
      .poll(() => distanceFromBottom(viewport), { message: `pinned after chunk ${index + 1}` })
      .toBeLessThanOrEqual(1);
  }
  await expect(viewport).toHaveAttribute("data-follow", "true");
  expect(
    await viewport.evaluate((element) => element.scrollHeight > element.clientHeight * 1.5),
    "the reply overflows the transcript",
  ).toBe(true);

  // Phase 2: a wheel-up is the reader's intent; growth must not pull them back.
  const box = await viewport.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -600);
  await expect(viewport).toHaveAttribute("data-follow", "false");
  let previous = -1;
  await expect
    .poll(async () => {
      const top = await viewport.evaluate((element) => element.scrollTop);
      const settled = top === previous;
      previous = top;
      return settled;
    })
    .toBe(true);
  const readingAt = previous;
  expect(await distanceFromBottom(viewport)).toBeGreaterThan(100);

  for (const chunk of chunks.slice(40, 46)) {
    reply.push(chunk.text);
    await revealed(viewport, chunk);
    expect(await viewport.evaluate((element) => element.scrollTop), "the reader keeps their place").toBe(readingAt);
  }
  await expect(viewport).toHaveAttribute("data-follow", "false");

  // Phase 3: the jump lands at the true bottom and follow resumes.
  const jump = page.getByRole("button", { name: "Scroll to bottom" });
  await expect(jump).toBeVisible();
  await jump.click();
  await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  await expect(viewport).toHaveAttribute("data-follow", "true");
  await expect(jump).toBeHidden();

  for (const chunk of chunks.slice(46)) {
    reply.push(chunk.text);
    await revealed(viewport, chunk);
    await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  }
  reply.finish();
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();
  await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  await expect(viewport).toHaveAttribute("data-follow", "true");
});
