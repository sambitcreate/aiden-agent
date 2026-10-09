import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, finishLmStudioOnboarding, test } from "./fixtures";

type StoredAttachment = { id: string; mimeType: string; kind: string; size: number; data?: string };
type StoredMessage = {
  id: string;
  role: string;
  attachments?: StoredAttachment[];
  uiVisuals?: { id: string; title: string }[];
  htmlArtifacts?: { mediaId: string; title: string }[];
  visualSnapshots?: { visualId: string; attachmentId: string }[];
};

async function latestAssistant(root: string): Promise<StoredMessage | undefined> {
  let metas: { id: string; botId?: string; workspaceId?: string }[] = [];
  try {
    metas = JSON.parse(await readFile(path.join(root, "chats", "index.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  for (const meta of metas.filter((chat) => !chat.botId && chat.workspaceId !== "assistant")) {
    const chat = JSON.parse(await readFile(path.join(root, "chats", `${meta.id}.json`), "utf8")) as { messages: StoredMessage[] };
    const assistant = [...chat.messages].reverse().find((message) => message.role === "assistant");
    if (assistant?.uiVisuals?.length) return assistant;
  }
  return undefined;
}

function pngSize(data: string): { width: number; height: number } {
  const bytes = Buffer.from(data, "base64");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const MARKUP = `<Visual title="Plan options" state={{plan: "team"}}>
  <Tabs bind="plan" label="Plan" options={[{value:"solo",label:"Solo"},{value:"team",label:"Team"}]} />
  <If test={$plan == "solo"}><Stat label="Price" value={12} format="currency" /></If>
  <If test={$plan == "team"}><Stat label="Price" value={60} format="currency" /></If>
  <Button variant="accent" action={sendPrompt("Start the " + $plan + " plan")}>Choose plan</Button>
</Visual>`;

const HTML = `<div style="padding:12px"><h2 style="margin:0">Weekly total</h2><p>1,460 users</p></div>`;

test("a reply draws native and HTML visuals inline, and both get snapshots for phones", async ({ aiden }) => {
  const { page, lmStudio, userDataDir, app } = aiden;
  await finishLmStudioOnboarding(page);
  const prompt = "Inline visuals scenario: show my plan options and weekly total.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      { name: "render_ui", arguments: { title: "Plan options", markup: MARKUP } },
      { name: "render_artifact", arguments: { title: "Weekly total", html: HTML } },
    ],
    finalText: "Here are your plan options and weekly total.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Here are your plan options and weekly total.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  expect(scenario.error).toBeUndefined();
  expect(scenario.issuedToolNames).toEqual(["render_ui", "render_artifact"]);

  // The native visual draws with Aiden's components and works without the model.
  const native = page.getByRole("figure", { name: "Plan options" });
  await expect(native).toBeVisible();
  await expect(native.getByText("$60.00")).toBeVisible();
  await native.getByRole("tab", { name: "Solo" }).click();
  await expect(native.getByText("$12.00")).toBeVisible();
  // A follow-up waits for the user's confirmation.
  await native.getByRole("button", { name: "Choose plan" }).click();
  await expect(page.getByRole("group", { name: "Follow-up suggested by Plan options" })).toContainText("Start the solo plan");

  // The HTML visual renders in its sandboxed frame.
  await expect(page.locator('iframe[title="Weekly total"]')).toBeVisible();

  // Both visuals get snapshot images, stored as reserved attachments.
  await expect.poll(async () => (await latestAssistant(userDataDir))?.visualSnapshots?.length ?? 0, { timeout: 30_000 }).toBe(2);
  const message = (await latestAssistant(userDataDir))!;
  for (const ref of message.visualSnapshots ?? []) {
    const attachment = message.attachments?.find((candidate) => candidate.id === ref.attachmentId);
    expect(attachment?.kind).toBe("image");
    expect(attachment?.mimeType).toBe("image/png");
    const size = pngSize(attachment!.data!);
    expect(size.width).toBeGreaterThanOrEqual(720);
    expect(size.height).toBeGreaterThan(64);
    await test.info().attach(`snapshot-${ref.visualId}.png`, {
      body: Buffer.from(attachment!.data!, "base64"),
      contentType: "image/png",
    });
  }
  // The desktop never shows the snapshot as a second image.
  await expect(page.locator('img[alt*="Plan options"]')).toHaveCount(0);
  // The hidden capture window never became a visible application window.
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((window) => window.isVisible()).length);
  expect(visible).toBe(1);
});
