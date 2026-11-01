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
    frames: Array<{ kind: string; text?: string }>;
    viewport: { zoom: number };
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
  await addFromMenu(page, "Note");
  const noteText = frame(page, "Note").getByRole("textbox", {
    name: "Note text",
  });
  await expect(noteText).toBeFocused();
  await page.keyboard.type(NOTE_TEXT);
  await expect(noteText).toHaveValue(NOTE_TEXT);

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
  await expect(page.getByRole("menuitem", { name: "Note" })).toBeVisible();
  await capture(page, "1440-canvas-add-menu");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Note" })).toHaveCount(0);

  // Everything is saved, then comes back where it was after a reload.
  await expect
    .poll(async () => {
      const [doc] = await savedCanvases(userDataDir);
      if (!doc) return null;
      return {
        kinds: doc.frames.map((saved) => saved.kind).sort(),
        note: doc.frames.find((saved) => saved.kind === "note")?.text,
        zoomedIn: doc.viewport.zoom >= 0.25,
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
  ).toHaveValue(NOTE_TEXT);
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
});
