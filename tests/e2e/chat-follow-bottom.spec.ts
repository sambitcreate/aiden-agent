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
  // Released blocks fade in place: opacity only, nothing slides.
  const motion = await page
    .locator(".streaming-reveal[data-streaming] > *")
    .last()
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return { property: style.transitionProperty, transform: style.transform, translate: style.translate };
    });
  expect(motion).toEqual({ property: "opacity", transform: "none", translate: "none" });
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
  // The settled reply keeps its tree and stops fading anything in.
  await expect(page.locator(".streaming-reveal").last()).not.toHaveAttribute("data-streaming", /.*/);
});

test("older transcript content remains findable, copyable and keyboard reachable with reduced motion", async ({ aiden }) => {
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await finishLmStudioOnboarding(aiden.page);
  const page = await aiden.relaunch(async () => {
    const folder = join(aiden.userDataDir, "chats");
    const indexPath = join(folder, "index.json");
    await mkdir(folder, { recursive: true });
    const index = JSON.parse(await readFile(indexPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return "[]"; throw error; }));
    const meta = { id: "long-transcript-fixture", title: "Long transcript fixture", createdAt: Date.now(), updatedAt: Date.now() };
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? "assistant" : "user", content: `History marker ${i}.\n\n${"A stable historical paragraph. ".repeat((i % 7 + 1) * 4)}`, createdAt: meta.createdAt + i }));
    await writeFile(join(folder, `${meta.id}.json`), JSON.stringify({ ...meta, messages }));
    await writeFile(indexPath, JSON.stringify([...index, meta]));
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("complementary").getByRole("button", { name: "Long transcript fixture", exact: true }).click();
  const viewport = page.locator("[data-follow]").first();
  await expect(page.getByText("History marker 99.", { exact: false })).toBeVisible();
  await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  const box = await viewport.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -500);
  await expect(viewport).toHaveAttribute("data-follow", "false");
  const found = await page.evaluate(() => (window as unknown as { find(text: string): boolean }).find("History marker 0."));
  expect(found).toBe(true);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("History marker 0.");
  const copy = page.getByRole("button", { name: "Copy message", exact: true }).first();
  await copy.focus();
  await expect(copy).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(copy).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(copy).toBeFocused();
  await expect(copy).toBeInViewport();
  await copy.press("Enter");
  await expect.poll(() => aiden.app.evaluate(({ clipboard }) => clipboard.readText())).toContain("History marker 0.");
  await page.getByRole("button", { name: "Scroll to bottom" }).click();
  await expect.poll(() => distanceFromBottom(viewport)).toBeLessThanOrEqual(1);
  await expect(page.getByText("History marker 99.", { exact: false })).toBeInViewport();
});
