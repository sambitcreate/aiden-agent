import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, E2E_ASSISTANT_RESPONSE, type CapturedLmStudioRequest } from "./fixtures";

test.use({ workspaceSeed: true, onboardingDone: true });

type StoredChat = {
  id: string;
  title: string;
  workspaceId?: string;
  botId?: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ role: string; content: string }>;
};

async function index(root: string): Promise<Omit<StoredChat, "messages">[]> {
  try {
    return JSON.parse(await readFile(path.join(root, "chats", "index.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function regularChats(root: string): Promise<StoredChat[]> {
  const metas = (await index(root)).filter(
    (chat) => !chat.botId && chat.workspaceId !== "assistant",
  );
  return Promise.all(
    metas.map(async (chat) =>
      JSON.parse(await readFile(path.join(root, "chats", `${chat.id}.json`), "utf8")),
    ),
  );
}

function lastUserText(request: CapturedLmStudioRequest): string | undefined {
  const body = request.body as {
    messages?: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string }>;
    }>;
  } | null;
  const user = body?.messages
    ?.slice()
    .reverse()
    .find((message) => message.role === "user");
  return typeof user?.content === "string"
    ? user.content
    : user?.content.map((part) => part.text ?? "").join("");
}

const completionRequests = (aiden: { lmStudio: { requests: CapturedLmStudioRequest[] } }) =>
  aiden.lmStudio.requests.filter((r) => r.url === "/v1/chat/completions");

test("send during a detached drain parks in the chat queue and delivers after the drain clears", async ({
  aiden,
}, testInfo) => {
  const { page, lmStudio } = aiden;
  const composer = page.locator("textarea");

  // Boot lands on a fresh draft (workspace seeded, no chats).
  await expect(composer).toBeVisible({ timeout: 30_000 });

  // Regression: normal send still works.
  await composer.fill("First message");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).first()).toBeVisible({ timeout: 30_000 });
  const committed = page
    .locator("[data-sidebar]")
    .getByRole("button", { name: /Deterministic E2E response/u });
  await expect(committed).toBeVisible();

  // Start a second generation and hold its SSE stream, then detach it by
  // navigating to a new draft.
  lmStudio.holdCompletions!();
  await composer.fill("held second");
  await composer.press("Enter");
  await expect(page.getByText("held second")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "New Agent", exact: true }).click();
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue("");

  // Return to the generating chat while the drain is still held.
  await committed.click();
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // The old detached-state banner must never appear, and the composer must be usable.
  await expect(page.getByText(/Response continues in the background/u)).toHaveCount(0);
  await expect(composer).toBeEditable();

  // Sending during the drain parks the message in the queue instead of throwing.
  await composer.fill("queued-probe");
  await composer.press("Enter");
  const queuedSection = page.locator('section[aria-label="Queued messages"]');
  await expect(queuedSection).toBeVisible({ timeout: 15_000 });
  await expect(queuedSection.getByText("1 queued")).toBeVisible();
  await expect(queuedSection.getByText("queued-probe")).toBeVisible();
  await expect(queuedSection.getByRole("button", { name: "Pause queue" })).toBeVisible();
  await expect(
    queuedSection.getByRole("button", { name: "Delete queued message 1" }),
  ).toBeVisible();
  await expect(queuedSection.getByRole("button", { name: "Edit queued message 1" })).toBeVisible();

  // Nothing was sent to the model yet — the send is parked locally.
  expect(completionRequests(aiden).filter((r) => lastUserText(r) === "queued-probe")).toEqual([]);

  await page.waitForTimeout(1200);
  await page.screenshot({ path: testInfo.outputPath("queued-parked.png") });

  // Regression: the queued-message delete control still works while parked.
  await composer.fill("queued-delete-me");
  await composer.press("Enter");
  await expect(queuedSection.getByText("2 queued")).toBeVisible();
  await queuedSection.getByRole("button", { name: "Delete queued message 2" }).click();
  await expect(queuedSection.getByText("1 queued")).toBeVisible();

  // Release the held stream → drain settles → the parked message delivers.
  lmStudio.releaseCompletions!();
  await expect
    .poll(
      async () =>
        completionRequests(aiden).filter((r) => lastUserText(r) === "queued-probe").length,
      { timeout: 30_000 },
    )
    .toBe(1);
  await expect(queuedSection).toHaveCount(0);
  await expect(page.getByText("queued-probe")).toBeVisible({ timeout: 30_000 });
  expect(completionRequests(aiden).filter((r) => lastUserText(r) === "queued-delete-me")).toEqual(
    [],
  );
  await page.screenshot({ path: testInfo.outputPath("queued-delivered.png") });
});

test("revisiting a discarded draft route resurrects a usable draft at the same id", async ({
  aiden,
}, testInfo) => {
  const { page, userDataDir } = aiden;
  const composer = page.locator("textarea");

  // Boot lands on a fresh draft /chat/<id>.
  await expect(composer).toBeVisible({ timeout: 30_000 });
  await expect(composer).toHaveAttribute("placeholder", /.+/u);
  await composer.fill("abandoned draft text");

  // Navigating to a non-chat route unmounts the pane and discards the draft.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Back to app" })).toBeVisible({ timeout: 15_000 });
  // Give the draft's discard microtask time to run.
  await page.waitForTimeout(1500);

  // Revisiting the same route must resurrect a fresh empty draft — no dead end.
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue("");
  await expect(composer).toBeEditable();
  await expect(page.getByText(/This chat is no longer available/u)).toHaveCount(0);
  await expect(page.getByText(/Start a new agent/u)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("resurrected-draft.png") });

  // Sending commits a real chat at the SAME route id.
  await composer.fill("resurrect-probe");
  await composer.press("Enter");
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await regularChats(userDataDir)).length, {
      timeout: 15_000,
    })
    .toBe(1);
  const chats = await regularChats(userDataDir);
  expect(
    chats[0]!.messages.some((m) => m.role === "user" && m.content.includes("resurrect-probe")),
  ).toBe(true);

  // Same-id proof: leave and return — the conversation is still on this route,
  // not a resurrected-empty draft (a different commit id would resurrect again).
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Back to app" }).click();
  await expect(page.getByText("resurrect-probe")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(E2E_ASSISTANT_RESPONSE).first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("resurrected-persisted.png") });
});
