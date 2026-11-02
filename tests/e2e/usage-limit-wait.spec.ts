import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, finishLmStudioOnboarding, test, E2E_ASSISTANT_RESPONSE } from "./fixtures";

import type {} from "../../renderer/global";

const PROMPT = "Answer once the rate limit clears.";

function isPromptCompletion({ url, body }: { url: string; body?: unknown }): boolean {
  const request = body as { messages?: unknown; tools?: unknown[] } | null;
  return url === "/v1/chat/completions" && Boolean(request?.tools?.length) &&
    JSON.stringify(request?.messages ?? "").includes(PROMPT);
}

test("a reply the provider turns away at its rate limit waits with the same model, and Retry now sends it", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  test.skip(!lmStudio.rateLimitCompletions, "needs the deterministic model to answer 429");
  await finishLmStudioOnboarding(page);
  // An hour away: well inside the default six-hour longest wait, so the reply waits.
  lmStudio.rateLimitCompletions!(PROMPT, 1, { "retry-after": "3600" });
  const completions = () => lmStudio.requests.filter(isPromptCompletion);

  const composer = page.locator("textarea");
  await composer.fill(PROMPT);
  await composer.press("Enter");

  const waiting = page.getByText(/Waiting for .+’s usage limit · next try/u);
  await expect(waiting).toBeVisible();
  expect(completions()).toHaveLength(1);
  // The rejection is not a failed reply: nothing the provider said is shown, and Stop still works.
  await expect(page.getByText("Rate limit reached for requests")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeVisible();

  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toBeVisible();
  await expect(waiting).toHaveCount(0);
  const sent = completions();
  expect(sent).toHaveLength(2);
  const model = (request: (typeof sent)[number]) => (request.body as { model?: unknown }).model;
  expect(model(sent[1]!), "the retry keeps the model").toBe(model(sent[0]!));
});

test("lowering the chat cap during a provider wait shows the spending refusal and sends no retry", async ({ aiden }) => {
  test.skip(!aiden.lmStudio.rateLimitCompletions, "needs the deterministic model to answer 429");
  let page = aiden.page;
  await finishLmStudioOnboarding(page);
  const seed = "Chat with prior spending";
  await page.locator("textarea").fill(seed);
  await page.locator("textarea").press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE)).toBeVisible();
  const chatId = await page.evaluate(async () => {
    const chats = await window.aidenAPI.ipc.invoke("chats:list") as { id: string }[];
    return chats[0]!.id;
  });
  // Give the local provider's chat a balance from an earlier paid request.
  page = await aiden.relaunch(() => writeFile(path.join(aiden.userDataDir, "spending.json"), JSON.stringify({
    version: 1, chats: { [chatId]: { spentUsd: 1, extraUsd: 0 } }, bots: {}, botLimits: {}, runs: {},
  })));
  await page.getByText(seed).first().click();
  aiden.lmStudio.rateLimitCompletions!(PROMPT, 1, { "retry-after": "3600" });
  await page.locator("textarea").fill(PROMPT);
  await page.locator("textarea").press("Enter");
  await expect(page.getByRole("button", { name: "Retry now" })).toBeVisible();
  await page.evaluate(() => window.aidenAPI.ipc.invoke("settings:set", { spendingLimits: { chatUsd: 1 } }));
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByText("This chat reached its $1.00 spending limit. Allow more to keep going.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow $1.00 more" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
  expect(aiden.lmStudio.requests.filter(isPromptCompletion)).toHaveLength(1);
});
