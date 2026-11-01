import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const CONTINUE_REQUEST = "Your previous reply was cut off before it finished.";

function agentCompletions(requests: { url: string; body: unknown }[], prompt: string) {
  return requests.filter(
    (request) =>
      request.url === "/v1/chat/completions" &&
      JSON.stringify((request.body as { messages?: unknown } | null)?.messages ?? "").includes(prompt) &&
      Boolean((request.body as { tools?: unknown[] } | null)?.tools?.length),
  );
}

test("a reply cut off by the output limit continues on its own and reads as one answer", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.cutOffCompletions, "needs the deterministic model to stop at its output limit");
  const prompt = "Tell the fox story in full.";
  await finishLmStudioOnboarding(page);
  lmStudio.cutOffCompletions!(prompt, [
    { text: "Once upon a ti", end: "length" },
    { text: "me a fox crossed the river", end: "length" },
    { text: " and came home.", end: "stop" },
  ]);

  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");

  await expect(page.getByText("Once upon a time a fox crossed the river and came home.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-provider-failure]")).toHaveCount(0);
  const completions = agentCompletions(lmStudio.requests, prompt);
  expect(completions).toHaveLength(3);
  // Each continuation carries what was written, then Aiden's request to continue.
  const last = (completions[2]!.body as { messages: Array<{ role: string; content: unknown }> }).messages;
  expect(JSON.stringify(last[last.length - 1]?.content)).toContain(CONTINUE_REQUEST);
  expect(JSON.stringify(last[last.length - 2]?.content)).toContain("me a fox crossed the river");
  // The request to continue never shows in the chat.
  await expect(page.getByText(CONTINUE_REQUEST)).toHaveCount(0);
});

test("a stream that drops mid-answer keeps what it wrote and finishes the answer", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.cutOffCompletions, "needs the deterministic model to drop a stream");
  const prompt = "Explain the tides briefly.";
  await finishLmStudioOnboarding(page);
  lmStudio.cutOffCompletions!(prompt, [
    { text: "The Moon pulls the oceans", end: "drop" },
    { text: " toward it, twice a day.", end: "stop" },
  ]);

  const composer = page.locator("textarea");
  await composer.fill(prompt);
  await composer.press("Enter");

  // The kept text stays on screen through the retry wait.
  await expect(page.getByText(/Trying again in \ds \(2 of 6\)/u)).toBeVisible();
  await expect(page.getByText("The Moon pulls the oceans", { exact: true })).toBeVisible();
  await expect(page.getByText("The Moon pulls the oceans toward it, twice a day.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-provider-failure]")).toHaveCount(0);
  expect(agentCompletions(lmStudio.requests, prompt)).toHaveLength(2);
  await expect(page.getByText(CONTINUE_REQUEST)).toHaveCount(0);
});
