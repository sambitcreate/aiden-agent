import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import type { ElectronApplication, Page } from "@playwright/test";
import {
  capture,
  chooseWorkspace,
  designCanvas,
  sendFirstMessage,
  setDisplayWidth,
  setWindowWidth,
  typeSlashCommand,
  WORKSPACE_NAME,
} from "./design-mode-helpers";
import {
  expect,
  finishLmStudioOnboarding,
  test,
  waitForToastsToClear,
} from "./fixtures";

test.use({
  workspaceSeed: true,
  appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_MODE: "1" },
});

const NOTE_TEXT = "Hero: a bigger headline and a softer call to action.";

function page_(title: string, headline: string, accent: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1d1d1f; background: #fbfaf7; }
      header { display: flex; justify-content: space-between; padding: 20px 48px; }
      main { padding: 72px 48px; }
      h1 { margin: 0 0 16px; font-size: 56px; line-height: 1.05; letter-spacing: -0.02em; }
      p { max-width: 520px; color: #55555a; }
      a.cta { display: inline-block; margin-top: 24px; padding: 12px 22px; border-radius: 12px; background: ${accent}; color: white; text-decoration: none; }
    </style>
  </head>
  <body>
    <header><strong>Northwind</strong><span>Pricing · Docs · Sign in</span></header>
    <main>
      <h1>${headline}</h1>
      <p>Plan, build and ship with one calm workspace for the whole team.</p>
      <a class="cta" href="#">Get started</a>
    </main>
  </body>
</html>
`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A soft two-colour gradient as a real 320 × 240 RGB PNG. */
function gradientPng(): Buffer {
  const width = 320;
  const height = 240;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    rows[row] = 0; // No filter.
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      const offset = row + 1 + x * 3;
      rows[offset] = Math.round(120 + 110 * t);
      rows[offset + 1] = Math.round(180 + 40 * t);
      rows[offset + 2] = Math.round(240 - 80 * t);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Bit depth.
  header[9] = 2; // Truecolour.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Answers the next Open dialog with this file, the way a person picking it would. */
async function answerNextPick(
  app: ElectronApplication,
  file: string,
): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [chosen],
    })) as unknown as typeof dialog.showOpenDialog;
  }, file);
}

async function addNote(page: Page): Promise<void> {
  await designCanvas(page).getByRole("button", { name: "Note", exact: true }).click();
}

async function addFromMenu(page: Page, item: string): Promise<void> {
  await designCanvas(page).getByRole("button", { name: "Add" }).click();
  const entry = page.getByRole("menuitem", { name: item });
  await expect(entry).toBeEnabled();
  await entry.click();
  await expect(entry).toHaveCount(0);
}

const frame = (page: Page, title: string) =>
  designCanvas(page).getByRole("group", { name: title, exact: true });
const pageInFrame = (page: Page, title: string) =>
  designCanvas(page).frameLocator(`iframe[title="${title}"]`);
const zoomToolbar = (page: Page) =>
  designCanvas(page).getByRole("toolbar", { name: "Zoom" });

/**
 * Brings one frame up close the way a person would: fit the whole canvas,
 * click the frame, then Fit selection (⇧2). A row of full-size pages is too
 * wide to run live once everything fits, so this is how a page goes live.
 */
async function zoomToFrame(page: Page, title: string): Promise<void> {
  await zoomToolbar(page)
    .getByRole("button", { name: "Fit to screen" })
    .click();
  await frame(page, title).click();
  await page.keyboard.press("Shift+Digit2");
  await expect.poll(() => zoomPercent(page)).toBeGreaterThanOrEqual(25);
}

/** Every frame's canvas position, by title. */
async function framePositions(page: Page): Promise<Record<string, string>> {
  return designCanvas(page)
    .locator(".react-flow__node")
    .evaluateAll((nodes) =>
      Object.fromEntries(
        nodes.map((node) => [
          node.querySelector('[role="group"]')?.getAttribute("aria-label") ??
            "",
          (node as HTMLElement).style.transform,
        ]),
      ),
    );
}

/** Clicks the canvas's own background, clear of its frames and controls. */
async function clickEmptyCanvas(page: Page): Promise<void> {
  const pane = designCanvas(page).locator(".react-flow__pane");
  const box = (await pane.boundingBox())!;
  await pane.click({ position: { x: box.width / 2, y: 6 } });
}

async function zoomPercent(page: Page): Promise<number> {
  const label = await zoomToolbar(page)
    .getByRole("button", { name: /^Zoom \d+%, reset to 100%$/u })
    .getAttribute("aria-label");
  return Number(/(\d+)%/u.exec(label ?? "")?.[1] ?? Number.NaN);
}

/** The saved canvas files, parsed. */
async function savedCanvases(userDataDir: string): Promise<
  Array<{
    version: number;
    frames: Array<{ kind: string; text?: string; title: string; pageId: string }>;
    pages: Array<{ id: string; name: string; viewport: { zoom: number } }>;
    activePageId: string;
  }>
> {
  const root = path.join(userDataDir, "design-canvases");
  let names: string[] = [];
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return Promise.all(
    names.map(async (name) =>
      JSON.parse(await readFile(path.join(root, name), "utf8")),
    ),
  );
}

async function openDesignChat(
  app: ElectronApplication,
  page: Page,
): Promise<void> {
  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, "Design the Northwind landing page");
  await typeSlashCommand(page, "/design");
  await expect(
    designCanvas(page).getByText(
      "Ask Aiden to design something, or add a note.",
    ),
  ).toBeVisible();
}

test("the design canvas keeps notes and workspace pages across a reload, follows edits on disk and stops live pages when zoomed out", async ({
  aiden,
}) => {
  const { app, workspaceDir, userDataDir } = aiden;
  let page = aiden.page;
  const designDir = path.join(workspaceDir, "design");
  await mkdir(designDir, { recursive: true });
  const hero = path.join(designDir, "hero.html");
  const pricing = path.join(designDir, "pricing.html");
  await writeFile(hero, page_("Hero", "Ship faster", "#3b6cf6"));
  await writeFile(
    pricing,
    page_("Pricing", "Simple pricing for every team", "#1f9d6b"),
  );
  await writeFile(path.join(designDir, "swatch.png"), gradientPng());

  await openDesignChat(app, page);
  await capture(page, "1440-canvas-empty");

  // A note takes the focus as soon as it is added, ready for typing.
  await addNote(page);
  const noteText = frame(page, "Note").getByRole("textbox", {
    name: "Note text",
  });
  await expect(noteText).toBeFocused();
  await page.keyboard.type(NOTE_TEXT);
  await expect(noteText).toHaveText(NOTE_TEXT);

  await addFromMenu(page, "Group");
  await expect(frame(page, "Group")).toBeVisible();

  // Workspace pages come in through the Open dialog and run live.
  await answerNextPick(app, hero);
  await addFromMenu(page, "File…");
  await expect(frame(page, "hero.html")).toBeVisible();
  await expect(pageInFrame(page, "hero.html").locator("h1")).toHaveText(
    "Ship faster",
  );
  await answerNextPick(app, pricing);
  await addFromMenu(page, "File…");
  await expect(pageInFrame(page, "pricing.html").locator("h1")).toHaveText(
    "Simple pricing for every team",
  );
  await answerNextPick(app, path.join(designDir, "swatch.png"));
  await addFromMenu(page, "Image…");
  await expect(
    frame(page, "swatch.png").getByRole("img", { name: "swatch.png" }),
  ).toHaveJSProperty("complete", true);

  // Frames added in a row sit side by side, so the whole canvas fits at a zoom
  // too small to run pages live.
  await zoomToolbar(page)
    .getByRole("button", { name: "Fit to screen" })
    .click();
  await capture(page, "1440-canvas-overview");

  // Fitting the selected page brings it up close, live, with its resize handles.
  await zoomToFrame(page, "hero.html");
  await expect(pageInFrame(page, "hero.html").locator("h1")).toBeVisible();
  await expect(
    designCanvas(page).locator(".react-flow__node.selected"),
  ).toHaveCount(1);
  await capture(page, "1440-canvas-frames-selected");

  await designCanvas(page).getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("menuitem", { name: "Group" })).toBeVisible();
  await capture(page, "1440-canvas-add-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Group" })).toHaveCount(0);

  // Everything is saved, then comes back where it was after a reload.
  await expect
    .poll(async () => {
      const [doc] = await savedCanvases(userDataDir);
      if (!doc) return null;
      return {
        kinds: doc.frames.map((saved) => saved.kind).sort(),
        note: doc.frames.find((saved) => saved.kind === "note")?.text,
        zoomedIn: doc.pages[0]!.viewport.zoom >= 0.25,
      };
    })
    .toEqual({
      kinds: ["file", "file", "group", "image", "note"],
      note: NOTE_TEXT,
      zoomedIn: true,
    });
  const before = await framePositions(page);
  expect(Object.keys(before).sort()).toEqual([
    "Group",
    "Note",
    "hero.html",
    "pricing.html",
    "swatch.png",
  ]);
  await page.reload();
  page = aiden.page;
  await expect(frame(page, "hero.html")).toBeVisible();
  await expect.poll(() => framePositions(page)).toEqual(before);
  await expect(
    frame(page, "Note").getByRole("textbox", { name: "Note text" }),
  ).toHaveText(NOTE_TEXT);
  await expect(pageInFrame(page, "hero.html").locator("h1")).toHaveText(
    "Ship faster",
  );

  // An edit on disk reaches the live page within two seconds.
  await writeFile(hero, page_("Hero", "Ship calmer", "#3b6cf6"));
  await expect(pageInFrame(page, "hero.html").locator("h1")).toHaveText(
    "Ship calmer",
    { timeout: 2_000 },
  );

  // Double-clicking a page enters it; Escape leaves.
  await frame(page, "hero.html").dblclick();
  await expect(
    designCanvas(page).locator('iframe[title="hero.html"]'),
  ).toHaveAttribute("tabindex", "0");
  await capture(page, "1440-canvas-frame-entered");
  await clickEmptyCanvas(page);
  await expect(
    designCanvas(page).locator('iframe[title="hero.html"]'),
  ).toHaveAttribute("tabindex", "-1");

  // A page removed from disk says so and offers to remove its frame.
  await zoomToFrame(page, "pricing.html");
  await expect(pageInFrame(page, "pricing.html").locator("h1")).toBeVisible();
  await rm(pricing);
  await expect(
    frame(page, "pricing.html").getByText("File not found"),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    frame(page, "pricing.html").getByRole("button", { name: "Remove frame" }),
  ).toBeVisible();
  await capture(page, "1440-canvas-file-not-found");

  // The same canvas at 1000 px, with the sidebar collapsed to give it room.
  await setWindowWidth(app, page, 1000);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await zoomToolbar(page)
    .getByRole("button", { name: "Fit to screen" })
    .click();
  await capture(page, "1000-canvas-frames");
  await zoomToFrame(page, "hero.html");
  await frame(page, "hero.html").dblclick();
  await expect(
    designCanvas(page).locator('iframe[title="hero.html"]'),
  ).toHaveAttribute("tabindex", "0");
  await capture(page, "1000-canvas-frame-entered");
  await clickEmptyCanvas(page);
  await page.getByRole("button", { name: "Show sidebar" }).click();
  await setWindowWidth(app, page, 1440);

  // Zoomed out to 20 % or less, no page runs live: each shows its snapshot.
  while ((await zoomPercent(page)) > 20) {
    await zoomToolbar(page).getByRole("button", { name: "Zoom out" }).click();
  }
  await expect(designCanvas(page).locator("iframe")).toHaveCount(0);
  await expect(frame(page, "hero.html")).toBeVisible();
  await capture(page, "1440-canvas-zoomed-out");

  // A frame is renamed from its title: double-click, type, Return.
  // The note's body is its text field, so select it by its title before fitting it.
  const noteTitle = frame(page, "Note").getByText("Note", { exact: true });
  await noteTitle.click();
  await page.keyboard.press("Shift+Digit2");
  await expect.poll(() => zoomPercent(page)).toBeGreaterThanOrEqual(100);
  await noteTitle.dblclick();
  const nameField = designCanvas(page).getByRole("textbox", { name: "Frame name" });
  await expect(nameField).toBeFocused();
  await nameField.fill("Ideas");
  await capture(page, "1440-canvas-frame-rename");
  await nameField.press("Enter");
  await expect(frame(page, "Ideas")).toBeVisible();
  await expect(nameField).toHaveCount(0);
  await zoomToolbar(page).getByRole("button", { name: "Fit to screen" }).click();

  // Pages: the picker adds an empty page and shows it; each page keeps its own frames.
  const picker = designCanvas(page).getByRole("button", { name: /^Page: /u });
  await expect(picker).toHaveAccessibleName("Page: Page 1");
  await picker.click();
  await expect(page.getByRole("menuitem", { name: "New page" })).toBeVisible();
  await capture(page, "1440-canvas-page-menu");
  await page.getByRole("menuitem", { name: "New page" }).click();
  await expect(picker).toHaveAccessibleName("Page: Page 2");
  await expect(frame(page, "hero.html")).toHaveCount(0);
  await expect(designCanvas(page).getByText("Ask Aiden to design something, or add a note.")).toBeVisible();
  await addNote(page);
  await page.keyboard.type("Second page");
  await capture(page, "1440-canvas-second-page");

  await picker.click();
  await page.getByRole("menuitemradio", { name: "Page 1" }).click();
  await expect(picker).toHaveAccessibleName("Page: Page 1");
  await expect(frame(page, "hero.html")).toBeVisible();
  await expect(frame(page, "Note")).toHaveCount(0);
  await expect
    .poll(async () => {
      const [doc] = await savedCanvases(userDataDir);
      if (!doc) return null;
      return {
        version: doc.version,
        pages: doc.pages.map((entry) => entry.name),
        onScreen: doc.pages.find((entry) => entry.id === doc.activePageId)?.name,
        renamed: doc.frames.some((saved) => saved.title === "Ideas"),
        secondPage: doc.frames.filter((saved) => saved.pageId === doc.pages[1]?.id).map((saved) => saved.text),
      };
    })
    .toEqual({
      version: 2,
      pages: ["Page 1", "Page 2"],
      onScreen: "Page 1",
      renamed: true,
      secondPage: ["Second page"],
    });
});

/** Whether the fake model was sent this text in any completion request. */
function modelSaw(requests: Array<{ body: unknown }>, text: string): boolean {
  return requests.some((request) => JSON.stringify(request.body ?? "").includes(text));
}

/** The saved comments of the first canvas. */
async function savedComments(userDataDir: string): Promise<Array<{ note: string; state: string; anchorState: string; queued?: boolean; anchor?: { tag: string; text: string } }>> {
  const [doc] = (await savedCanvases(userDataDir)) as unknown as Array<{ comments: Array<{ note: string; state: string; anchorState: string; queued?: boolean; anchor?: { tag: string; text: string } }> }>;
  return doc?.comments ?? [];
}

test("a comment on a page's element goes to Aiden with the next send and resolves after the page changes", async ({
  aiden,
}) => {
  const { app, page, workspaceDir, userDataDir, lmStudio } = aiden;
  const designDir = path.join(workspaceDir, "design");
  await mkdir(designDir, { recursive: true });
  const hero = path.join(designDir, "hero.html");
  await writeFile(hero, page_("Hero", "Ship faster", "#3b6cf6"));
  await openDesignChat(app, page);
  await answerNextPick(app, hero);
  await addFromMenu(page, "File…");
  await expect(pageInFrame(page, "hero.html").locator("h1")).toHaveText("Ship faster");
  await zoomToFrame(page, "hero.html");
  await clickEmptyCanvas(page);

  // C turns on the comment tool; a click on the headline picks it inside the live page.
  await designCanvas(page).getByRole("button", { name: "Comment", exact: true }).click();
  await expect(designCanvas(page).getByRole("button", { name: "Comment", exact: true })).toHaveAttribute("aria-pressed", "true");
  const iframe = (await designCanvas(page).locator('iframe[title="hero.html"]').boundingBox())!;
  const scale = iframe.width / 1280;
  // The headline sits about 160 px down a 1280 px wide page, 100 px in.
  await page.mouse.move(iframe.x + 140 * scale, iframe.y + 165 * scale);
  await page.mouse.click(iframe.x + 140 * scale, iframe.y + 165 * scale);
  const box = designCanvas(page).getByRole("dialog", { name: "New comment" });
  await expect(box).toContainText('hero.html › h1 "Ship faster"');
  await expect(box.getByRole("checkbox", { name: "Send to Aiden" })).toBeChecked();
  await box.getByRole("textbox", { name: "Comment" }).fill("Make the headline bigger and warmer");
  await capture(page, "1440-comment-box");
  await box.getByRole("textbox", { name: "Comment" }).press("Enter");
  await expect(box).toHaveCount(0);

  const pin = designCanvas(page).getByRole("button", { name: /^Comment 1 on hero\.html › h1 "Ship faster"$/u });
  await expect(pin).toBeVisible();
  const tray = page.getByRole("region", { name: "Design comments for Aiden" });
  await expect(tray).toContainText("1 comment for Aiden");
  await tray.getByRole("button", { name: "1 comment for Aiden" }).click();
  await expect(tray).toContainText("Make the headline bigger and warmer");
  await capture(page, "1440-comment-tray");

  await expect
    .poll(() => savedComments(userDataDir))
    .toEqual([
      expect.objectContaining({ note: "Make the headline bigger and warmer", state: "open", queued: true, anchor: expect.objectContaining({ tag: "h1", text: "Ship faster" }) }),
    ]);

  // Send gives Aiden the comments block; the comment turns sent and leaves the tray.
  await tray.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => modelSaw(lmStudio.requests, "attached-design-comments")).toBe(true);
  expect(modelSaw(lmStudio.requests, "Make the headline bigger and warmer")).toBe(true);
  expect(modelSaw(lmStudio.requests, "Change only these elements unless told otherwise")).toBe(true);
  await expect(tray).toHaveCount(0);
  await expect(designCanvas(page).getByRole("button", { name: /^Comment 1 on .*, sent to Aiden$/u })).toBeVisible();
  await expect.poll(async () => (await savedComments(userDataDir))[0]?.state).toBe("sent");

  // Aiden's edit reloads the page; the headline is still there, so the comment resolves.
  await writeFile(hero, page_("Hero", "Ship faster", "#c2410c"));
  await expect.poll(async () => (await savedComments(userDataDir))[0]?.state, { timeout: 10_000 }).toBe("resolved");
  await expect(designCanvas(page).getByRole("button", { name: /^Comment 1 on / })).toHaveCount(0);

  // All comments lists it under Resolved, and it can be opened and reopened.
  await designCanvas(page).getByRole("button", { name: "All comments" }).click();
  const panel = page.getByRole("dialog", { name: "All comments" });
  await panel.getByRole("radio", { name: "Resolved" }).click();
  await expect(panel).toContainText("Make the headline bigger and warmer");
  await capture(page, "1440-comment-all-resolved");
  await panel.getByRole("button", { name: /Make the headline bigger and warmer/u }).click();
  const opened = designCanvas(page).getByRole("dialog", { name: "Comment" });
  await expect(opened).toContainText("Resolved");
  await opened.getByRole("button", { name: "Reopen" }).click();
  await expect.poll(async () => (await savedComments(userDataDir))[0]?.state).toBe("open");

  // A free pin on the canvas, with a mark drawn, kept as a plain comment.
  await page.keyboard.press("Escape");
  await expect(opened).toHaveCount(0);
  await zoomToolbar(page).getByRole("button", { name: "Fit to screen" }).click();
  await zoomToolbar(page).getByRole("button", { name: "Zoom out" }).click();
  await zoomToolbar(page).getByRole("button", { name: "Zoom out" }).click();
  const pane = designCanvas(page).locator(".react-flow__pane");
  const paneBox = (await pane.boundingBox())!;
  const spot = { x: paneBox.x + 90, y: paneBox.y + paneBox.height - 150 };
  await page.mouse.click(spot.x, spot.y);
  const free = designCanvas(page).getByRole("dialog", { name: "New comment" });
  await expect(free).toContainText("Canvas");
  await free.getByRole("button", { name: "Draw marks" }).click();
  await page.mouse.move(spot.x - 40, spot.y - 40);
  await page.mouse.down();
  await page.mouse.move(spot.x + 30, spot.y - 70, { steps: 4 });
  await page.mouse.move(spot.x + 100, spot.y - 40, { steps: 4 });
  await page.mouse.up();
  await free.getByRole("checkbox", { name: "Send to Aiden" }).click();
  await free.getByRole("textbox", { name: "Comment" }).fill("Room for a testimonial here");
  await capture(page, "1440-comment-free-pin-marks");
  await free.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await savedComments(userDataDir)).length).toBe(2);
  await expect(page.getByRole("region", { name: "Design comments for Aiden" })).toHaveCount(0);
  await capture(page, "1440-comment-pins");
});

type SavedFrame = {
  id: string;
  kind: string;
  title: string;
  text?: string;
  shape?: string;
  groupId?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  ends?: Array<{ x: number; y: number; frameId?: string }>;
  points?: unknown[];
  handles?: unknown[];
  size?: string;
  color?: string;
  fill?: string;
  paper?: string;
  printMode?: string;
};

async function savedFrames(userDataDir: string): Promise<SavedFrame[]> {
  const [doc] = await savedCanvases(userDataDir);
  return ((doc?.frames ?? []) as unknown as SavedFrame[]);
}

/** Drags across the canvas pane from one point to another, in pixels from the pane's top left. */
async function dragOnCanvas(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const pane = (await designCanvas(page).locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(pane.x + from.x, pane.y + from.y);
  await page.mouse.down();
  await page.mouse.move(pane.x + to.x, pane.y + to.y, { steps: 10 });
  await page.mouse.up();
}

/** Presses at the first point and drags through the rest, as a hand drawing would. */
async function dragThrough(page: Page, points: Array<{ x: number; y: number }>): Promise<void> {
  const pane = (await designCanvas(page).locator(".react-flow__pane").boundingBox())!;
  const [first, ...rest] = points;
  await page.mouse.move(pane.x + first!.x, pane.y + first!.y);
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(pane.x + point.x, pane.y + point.y, { steps: 6 });
  await page.mouse.up();
}

async function clickOnCanvas(page: Page, at: { x: number; y: number }): Promise<void> {
  const pane = (await designCanvas(page).locator(".react-flow__pane").boundingBox())!;
  await page.mouse.click(pane.x + at.x, pane.y + at.y);
}

test("the drawing tools make text, an artboard, shapes, an arrow that follows its boxes, and pencil and pen lines", async ({
  aiden,
}) => {
  const { app, page, userDataDir } = aiden;
  await openDesignChat(app, page);
  const canvas = designCanvas(page);
  const tools = canvas.getByRole("toolbar", { name: "Canvas tools" });

  // Frame: drag out an artboard. The tool steps aside for Select once it has drawn.
  await tools.getByRole("button", { name: "Frame", exact: true }).click();
  await expect(tools.getByRole("button", { name: "Frame", exact: true })).toHaveAttribute("aria-pressed", "true");
  await dragOnCanvas(page, { x: 60, y: 120 }, { x: 640, y: 560 });
  await expect(tools.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await savedFrames(userDataDir)).map((entry) => entry.kind)).toEqual(["frame"]);

  // R and O draw shapes inside it, so they belong to it.
  await page.keyboard.press("r");
  await dragOnCanvas(page, { x: 100, y: 200 }, { x: 260, y: 300 });
  await page.keyboard.press("o");
  await dragOnCanvas(page, { x: 420, y: 200 }, { x: 540, y: 320 });
  await expect.poll(async () => (await savedFrames(userDataDir)).map((entry) => entry.shape ?? entry.kind)).toEqual([
    "frame",
    "rect",
    "oval",
  ]);
  const [board, rect, oval] = await savedFrames(userDataDir);
  expect([rect!.groupId, oval!.groupId]).toEqual([board!.id, board!.id]);

  // Shift+L draws an arrow; its ends land on the two shapes and stay joined to them.
  await page.keyboard.press("Shift+L");
  await dragOnCanvas(page, { x: 180, y: 250 }, { x: 480, y: 260 });
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "connector")?.ends?.map((end) => end.frameId))
    .toEqual([rect!.id, oval!.id]);

  // Text: click to place, type, Escape to finish.
  await page.keyboard.press("t");
  await clickOnCanvas(page, { x: 100, y: 160 });
  const textField = canvas.getByRole("textbox", { name: "Text", exact: true });
  await expect(textField).toBeFocused();
  await textField.pressSequentially("Sign-in flow");
  await capture(page, "1440-draw-text-editing");
  await textField.press("Escape");
  await expect.poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "text")?.text).toBe("Sign-in flow");

  // A double-click on a shape edits its label.
  await canvas.getByRole("group", { name: "Rectangle", exact: true }).dblclick();
  const label = canvas.getByRole("textbox", { name: "Rectangle label" });
  await label.pressSequentially("Sign in");
  await label.press("Escape");
  await expect(canvas.getByRole("group", { name: "Rectangle: Sign in" })).toBeVisible();

  // The pencil draws freehand and stays on; the pen clicks corners and finishes with Return.
  await tools.getByRole("button", { name: "Draw" }).click();
  await page.getByRole("menuitem", { name: /^Pencil/u }).click();
  await dragThrough(page, [
    { x: 80, y: 660 },
    { x: 130, y: 610 },
    { x: 180, y: 680 },
    { x: 230, y: 615 },
    { x: 290, y: 670 },
  ]);
  await expect(tools.getByRole("button", { name: "Draw: Pencil" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+P");
  await expect(tools.getByRole("button", { name: "Draw: Pen" })).toHaveAttribute("aria-pressed", "true");
  // Each press shows its point. The path stays within 640 px of the top, so a
  // window the screen keeps shorter than 900 px (a Mac runner) still holds it.
  const penPoints = page.locator(".design-draft-point");
  const pane = await canvas.locator(".react-flow__pane").boundingBox();
  const where = `canvas pane ${JSON.stringify(pane)}`;
  await clickOnCanvas(page, { x: 380, y: 560 });
  await expect(penPoints, where).toHaveCount(1);
  // A drag from the second point gives it a curve.
  await dragOnCanvas(page, { x: 480, y: 640 }, { x: 540, y: 640 });
  await expect(penPoints, where).toHaveCount(2);
  await clickOnCanvas(page, { x: 600, y: 570 });
  await expect(penPoints, where).toHaveCount(3);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () =>
      (await savedFrames(userDataDir))
        .filter((entry) => entry.kind === "stroke")
        .map((entry) => (entry.handles ? `pen ${entry.points?.length}` : "pencil")),
    )
    .toEqual(["pencil", "pen 3"]);
  await clickEmptyCanvas(page);
  await capture(page, "1440-draw-diagram");

  // A selected arrow shows a handle at each end.
  await clickOnCanvas(page, { x: 340, y: 255 });
  await expect(canvas.locator("[data-design-end]")).toHaveCount(2);
  await capture(page, "1440-draw-arrow-selected");
  await clickEmptyCanvas(page);

  // Moving the oval brings the arrow along.
  const arrowBefore = (await savedFrames(userDataDir)).find((entry) => entry.kind === "connector")!.ends!;
  await page.keyboard.press("v");
  await dragOnCanvas(page, { x: 480, y: 290 }, { x: 480, y: 450 });
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "connector")!.ends![1]!.y)
    .toBeGreaterThan(arrowBefore[1]!.y + 100);

  // The Shapes menu lists its tools with their keys.
  await tools.getByRole("button", { name: "Shapes" }).click();
  await expect(page.getByRole("menuitem", { name: /^Rectangle/u })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /^Arrow/u })).toBeVisible();
  await capture(page, "1440-draw-shapes-menu");
  await page.keyboard.press("Escape");

  // Deleting the rectangle leaves the arrow's end where it was; undo joins it again.
  await canvas.getByRole("group", { name: "Rectangle: Sign in" }).click();
  await page.keyboard.press("Backspace");
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "connector")!.ends![0]!.frameId)
    .toBeUndefined();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "connector")!.ends![0]!.frameId)
    .toBe(rect!.id);
});


test("notes and text take formatting from the bar above them: marks, a link, a list, size and colours", async ({ aiden }) => {
  const { app, page, userDataDir } = aiden;
  const mac = process.platform === "darwin";
  const mod = mac ? "Meta" : "Control";
  // Chromium on a Mac moves by line with ⌘ and the arrows; Home and End do not move the caret there.
  const lineStart = mac ? "Meta+ArrowLeft" : "Home";
  const lineEnd = mac ? "Meta+ArrowRight" : "End";
  const textStart = mac ? "Meta+ArrowUp" : "Control+Home";
  await openDesignChat(app, page);
  const canvas = designCanvas(page);

  // A new note: type three lines, then format them.
  await addNote(page);
  const note = frame(page, "Note").getByRole("textbox", { name: "Note text" });
  await expect(note).toBeFocused();
  await page.keyboard.type("Launch plan");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Draft pricing");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Check brief");
  const bar = page.getByRole("toolbar", { name: "Note formatting" });
  await expect(bar).toBeVisible();

  // Link on the selected word opens the link field; a bare address gets https://.
  for (let index = 0; index < "brief".length; index += 1) await page.keyboard.press("Shift+ArrowLeft");
  await bar.getByRole("button", { name: "Link" }).click();
  const linkField = page.getByRole("textbox", { name: "Link address" });
  await expect(linkField).toBeFocused();
  await linkField.fill("example.com/brief");
  await capture(page, "1440-notes-link");
  await linkField.press("Enter");
  await expect(note).toBeFocused();

  // The second and third lines become a bulleted list from the bar.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press(lineStart);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press(`Shift+${lineEnd}`);
  await bar.getByRole("button", { name: "Bulleted list" }).click();

  // The first line goes bold with the keyboard, and the bar shows it.
  await page.keyboard.press(textStart);
  await page.keyboard.press(`Shift+${lineEnd}`);
  await page.keyboard.press(`${mod}+b`);
  await expect(bar.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.kind === "note")?.text)
    .toBe("**Launch plan**\n- Draft pricing\n- Check [brief](https://example.com/brief)");

  // Size and note colour apply to the whole note.
  await bar.getByRole("button", { name: /^Text size/u }).click();
  await page.getByRole("menuitemradio", { name: "Medium" }).click();
  await bar.getByRole("button", { name: /^Note colour/u }).click();
  await page.getByRole("menuitemradio", { name: "Yellow" }).click();
  await expect
    .poll(async () => {
      const saved = (await savedFrames(userDataDir)).find((entry) => entry.kind === "note");
      return [saved?.size, saved?.fill];
    })
    .toEqual(["medium", "yellow"]);
  await expect(note).toBeFocused();
  await expect(note.locator("b")).toHaveText("Launch plan");
  await expect(note.locator("ul li")).toHaveCount(2);
  await capture(page, "1440-notes-format-bar");
  await page.keyboard.press("Escape");

  // A text item: the bar works on all of it when nobody is editing it.
  await page.keyboard.press("t");
  await clickOnCanvas(page, { x: 60, y: 660 });
  const textField = canvas.getByRole("textbox", { name: "Text", exact: true });
  await expect(textField).toBeFocused();
  await textField.pressSequentially("Checkout");
  await textField.press("Escape");
  await canvas.getByRole("group", { name: "Text: Checkout" }).click();
  const textBar = page.getByRole("toolbar", { name: "Text formatting" });
  await textBar.getByRole("button", { name: "Italic" }).click();
  await textBar.getByRole("button", { name: /^Text colour/u }).click();
  await page.getByRole("menuitemradio", { name: "Blue" }).click();
  await expect
    .poll(async () => {
      const saved = (await savedFrames(userDataDir)).find((entry) => entry.kind === "text");
      return [saved?.text, saved?.color];
    })
    .toEqual(["*Checkout*", "blue"]);
  await page.keyboard.press(lineEnd);
  await capture(page, "1440-text-format-bar");
  await page.keyboard.press("Escape");

  // Comment opens a comment box on the text item.
  await canvas.getByRole("group", { name: "Text: Checkout" }).click();
  await textBar.getByRole("button", { name: "Comment on this text" }).click();
  const commentBox = canvas.getByRole("dialog", { name: "New comment" });
  await expect(commentBox).toContainText("Text");
  await commentBox.getByRole("textbox", { name: "Comment" }).press("Escape");
  await clickEmptyCanvas(page);

  // After a reload the note reads back formatted, link and all.
  await page.reload();
  const reloaded = frame(aiden.page, "Note").getByRole("textbox", { name: "Note text" });
  await expect(reloaded.locator("b")).toHaveText("Launch plan");
  await expect(reloaded.locator('a[href="https://example.com/brief"]')).toHaveText("brief");
  await expect(designCanvas(aiden.page).getByRole("group", { name: "Text: Checkout" }).locator("i")).toHaveText("Checkout");
});

/** Answers the next Save dialog with this path, the way a person choosing it would. */
async function answerNextSave(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: chosen })) as unknown as typeof dialog.showSaveDialog;
  }, file);
}

/**
 * The presented page fills the window along one side once its move settles,
 * and nothing else in the app (the sidebar, the Live control) draws over it.
 */
async function expectPresentedAlone(page: Page, title: string): Promise<void> {
  const frame = page.locator(`iframe[title="${title}"]`);
  await expect.poll(async () => {
    const first = await frame.boundingBox();
    await page.waitForTimeout(100);
    const second = await frame.boundingBox();
    if (!first || !second || first.x !== second.x || first.width !== second.width) return "moving";
    const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    const fits = second.x >= -1 && second.y >= -1 && second.x + second.width <= width + 1 && second.y + second.height <= height + 1;
    const fills = second.width >= width * 0.85 || second.height >= height * 0.85;
    return fits && fills ? "fitted" : `at ${JSON.stringify(second)}`;
  }, { timeout: 10_000 }).toBe("fitted");
  const covered = await page.evaluate(() => {
    const wrapper = document.querySelector("[data-presenting]");
    // Where the sidebar, the middle of the page and the Live control would be.
    const points = [[60, 400], [window.innerWidth / 2, window.innerHeight / 2], [window.innerWidth * 0.45, window.innerHeight - 32]];
    return points.filter(([x, y]) => !wrapper?.contains(document.elementFromPoint(x!, y!) ?? null)).length;
  });
  expect(covered).toBe(0);
}

test("a page downloads as a PNG, a PDF and its own file, and Present walks the page and comes back", async ({ aiden }) => {
  const { app, page, workspaceDir, userDataDir } = aiden;
  const designDir = path.join(workspaceDir, "design");
  const outDir = path.join(userDataDir, "downloads-test");
  await mkdir(designDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const hero = path.join(designDir, "hero.html");
  await writeFile(hero, page_("Hero", "Ship faster", "#3b6cf6"));
  await writeFile(path.join(designDir, "pricing.html"), page_("Pricing", "Simple pricing", "#1f9d6b"));

  await openDesignChat(app, page);
  const canvas = designCanvas(page);
  await answerNextPick(app, hero);
  await addFromMenu(page, "File…");
  await answerNextPick(app, path.join(designDir, "pricing.html"));
  await addFromMenu(page, "File…");
  await addNote(page);
  await page.keyboard.type("Ship the pricing page next.");
  await clickEmptyCanvas(page);

  // Download: a 2× picture of the whole page, a PDF on A4, and the file itself.
  const heroFrame = frame(page, "hero.html");
  const pngPath = path.join(outDir, "hero.png");
  await answerNextSave(app, pngPath);
  await heroFrame.getByRole("button", { name: "Download hero.html" }).click();
  await capture(page, "1440-frame-download-menu");
  await page.getByRole("menuitem", { name: "PNG image" }).click();
  await expect.poll(async () => (await readFile(pngPath).catch(() => Buffer.alloc(0))).length, { timeout: 30_000 }).toBeGreaterThan(1000);
  const png = await readFile(pngPath);
  expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
  // A 1 280 px design width drawn at twice its pixels.
  expect(png.readUInt32BE(16)).toBe(2560);

  await heroFrame.getByRole("button", { name: "Download hero.html" }).click();
  await page.getByRole("menuitemradio", { name: "A4" }).click();
  await expect
    .poll(async () => (await savedFrames(userDataDir)).find((entry) => entry.title === "hero.html")?.paper)
    .toBe("a4");
  const pdfPath = path.join(outDir, "hero.pdf");
  await answerNextSave(app, pdfPath);
  await heroFrame.getByRole("button", { name: "Download hero.html" }).click();
  await page.getByRole("menuitem", { name: "PDF" }).click();
  await expect.poll(async () => (await readFile(pdfPath).catch(() => Buffer.alloc(0))).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  // A4 is 595 × 842 points.
  expect((await readFile(pdfPath)).toString("latin1")).toMatch(/MediaBox\s*\[\s*0 0 595(?:\.\d+)? 842/u);

  const sourcePath = path.join(outDir, "hero-copy.html");
  await answerNextSave(app, sourcePath);
  await heroFrame.getByRole("button", { name: "Download hero.html" }).click();
  await page.getByRole("menuitem", { name: "Original file" }).click();
  await expect.poll(async () => readFile(sourcePath, "utf8").catch(() => "")).toBe(await readFile(hero, "utf8"));

  // Present fills the window and walks the page in reading order, then gives the canvas back.
  const before = (await savedCanvases(userDataDir))[0]!.pages[0]!.viewport;
  await canvas.getByRole("button", { name: "Present this page" }).click();
  const bar = canvas.getByRole("toolbar", { name: "Presentation" });
  await expect(bar).toContainText("1 of 3 · hero.html");
  await expect(canvas.getByRole("toolbar", { name: "Canvas tools" })).toHaveCount(0);
  const wrapperBox = async () =>
    page.locator('[data-presenting="page"]').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return [rect.width, rect.height, window.innerWidth, window.innerHeight];
    });
  await expect.poll(async () => {
    const [w, h, iw, ih] = await wrapperBox();
    return w === iw && h === ih;
  }).toBe(true);
  await expect(pageInFrame(page, "hero.html").locator("h1")).toBeVisible();
  await expectPresentedAlone(page, "hero.html");
  await capture(page, "1440-present");
  await page.keyboard.press("ArrowRight");
  await expect(bar).toContainText("2 of 3 · pricing.html");
  await page.keyboard.press("End");
  await expect(bar).toContainText("3 of 3 · Note");
  await expect(bar.getByRole("button", { name: "Next frame" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(canvas.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();
  expect((await savedCanvases(userDataDir))[0]!.pages[0]!.viewport).toEqual(before);

  // Open full window shows one page alone, taking input, until Close.
  await heroFrame.getByRole("button", { name: "Open hero.html in a full window" }).click();
  const single = canvas.getByRole("toolbar", { name: "Full window" });
  await expect(single).toContainText("hero.html");
  await expect(page.locator('[data-presenting="frame"]')).toBeVisible();
  await expect(pageInFrame(page, "hero.html").locator("h1")).toBeVisible();
  await expectPresentedAlone(page, "hero.html");
  await capture(page, "1440-open-full-window");
  await single.getByRole("button", { name: "Close full window" }).click();
  await expect(single).toHaveCount(0);
});
