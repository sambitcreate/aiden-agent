import { E2E_MODEL_DISPLAY_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

type Box = { top: number; bottom: number; left: number; right: number };

type PadLayout = {
  card: number;
  pad: Box;
  tray: Box;
  scrollport: Box;
  viewport: { width: number; height: number };
  pageOverflowX: number;
  scrollportOverflowX: number;
};

// Measure rendered geometry in Electron, including both navigation columns and
// native zoom; CSS/source assertions cannot catch a square extending offscreen
// or a tray pushing the page sideways.
test("Model Pad and its tray fit resized settings and keep models usable at native zoom", async ({
  aiden,
}) => {
  // A cold hosted Electron run can be slow to traverse every size and zoom.
  test.setTimeout(180_000);
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Model Pad", exact: true })
    .click();
  const pad = page.getByRole("group", { name: "Personal Model Pad arrangement", exact: true });
  const tray = page.getByRole("complementary", { name: "On your Pad", exact: true });

  // Add the E2E model from the Add list; it lands on the Pad and in the tray.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const addList = page.getByRole("dialog", { name: "Add models to the Pad" });
  await addList
    .getByRole("option", { name: new RegExp(`^Add ${E2E_MODEL_DISPLAY_NAME} .*to Pad$`, "u") })
    .first()
    .click();
  await expect(
    addList.getByRole("option", { name: new RegExp(`^Remove ${E2E_MODEL_DISPLAY_NAME} `, "u") }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(addList).toHaveCount(0);
  await expect(tray.getByText(E2E_MODEL_DISPLAY_NAME, { exact: true })).toBeVisible();
  const marker = pad.getByRole("button", {
    name: new RegExp(`^${E2E_MODEL_DISPLAY_NAME} from`, "u"),
  });
  await expect(marker).toHaveCount(1);

  for (const [width, height, zoom] of [
    [1440, 1000, 1],
    [1280, 720, 1],
    [900, 600, 1],
    [1280, 800, 1.25],
    [900, 456, 1],
    [1280, 720, 1.5],
    [600, 600, 1],
    [390, 456, 1],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(size.width, size.height);
        window.webContents.setZoomFactor(size.zoom);
      },
      { width, height, zoom },
    );
    const state = `${width}×${height}, ${zoom} zoom`;

    await expect
      .poll(
        () =>
          pad.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const body = element.closest(".model-pad-body")!;
            return {
              square: Math.abs(bounds.width - bounds.height) <= 1,
              minimumSize: bounds.width >= 160 && bounds.height >= 160,
              fitsWidth: bounds.left >= 0 && bounds.right <= innerWidth,
              fitsHeight: bounds.height <= innerHeight,
              fitsColumn: bounds.width <= body.clientWidth + 1,
            };
          }),
        { message: `Pad size at ${state}` },
      )
      .toEqual({
        square: true,
        minimumSize: true,
        fitsWidth: true,
        fitsHeight: true,
        fitsColumn: true,
      });

    // Scroll each part into view the way a user would, then check it is fully
    // visible inside the settings scrollport with no sideways page scrolling.
    await expect
      .poll(
        async () =>
          pad.evaluate(async (element): Promise<PadLayout & { padVisible: boolean; trayVisible: boolean }> => {
            const box = (target: Element): Box => {
              const bounds = target.getBoundingClientRect();
              return {
                top: Math.round(bounds.top),
                bottom: Math.round(bounds.bottom),
                left: Math.round(bounds.left),
                right: Math.round(bounds.right),
              };
            };
            let scrollport = element.parentElement;
            while (scrollport && !/(auto|scroll)/u.test(getComputedStyle(scrollport).overflowY)) {
              scrollport = scrollport.parentElement;
            }
            const port = scrollport ?? document.documentElement;
            const trayElement = document.querySelector('aside[aria-label="On your Pad"]')!;
            const visible = (target: Element) => {
              const bounds = target.getBoundingClientRect();
              const portBounds = port.getBoundingClientRect();
              const top = Math.max(0, portBounds.top);
              const bottom = Math.min(innerHeight, portBounds.bottom);
              return (
                bounds.top >= top - 1 &&
                bounds.bottom <= bottom + 1 &&
                bounds.left >= -1 &&
                bounds.right <= innerWidth + 1
              );
            };
            const settle = () =>
              new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            element.scrollIntoView({ block: "center", inline: "nearest" });
            await settle();
            const padVisible = visible(element);
            // A tray taller than the window only needs its top (title + first rows).
            trayElement.scrollIntoView({ block: "start", inline: "nearest" });
            await settle();
            const trayTitle = trayElement.firstElementChild!;
            const trayVisible = visible(trayTitle);
            return {
              card: Math.round(element.closest(".model-pad-fieldset")!.getBoundingClientRect().width),
              pad: box(element),
              tray: box(trayElement),
              scrollport: box(port),
              viewport: { width: innerWidth, height: innerHeight },
              pageOverflowX: document.documentElement.scrollWidth - innerWidth,
              scrollportOverflowX: port.scrollWidth - port.clientWidth,
              padVisible,
              trayVisible,
            };
          }),
        { message: `reachable Pad and tray at ${state}` },
      )
      .toMatchObject({
        padVisible: true,
        trayVisible: true,
        pageOverflowX: 0,
        scrollportOverflowX: 0,
      });

    // The tray sits beside the square when the card has room and stacks under
    // it otherwise (a container query on the card, not the window).
    const layout = await pad.evaluate((element) => {
      const padBounds = element.getBoundingClientRect();
      const trayElement = document.querySelector('aside[aria-label="On your Pad"]')!;
      const trayBounds = trayElement.getBoundingClientRect();
      // However many models it lists, the tray beside the square scrolls
      // inside a box no taller than the square.
      const trayMaxHeight = Number.parseFloat(getComputedStyle(trayElement).maxHeight);
      return {
        wide: element.closest(".model-pad-fieldset")!.getBoundingClientRect().width > 640,
        beside: trayBounds.left >= padBounds.right - 1 && trayBounds.top < padBounds.bottom,
        below: trayBounds.top >= padBounds.bottom - 1,
        trayCappedAtSquare: trayMaxHeight <= padBounds.height + 1,
      };
    });
    expect(layout, `tray placement at ${state}`).toEqual(
      layout.wide
        ? { wide: true, beside: true, below: false, trayCappedAtSquare: true }
        : // Stacked under the square, the tray grows with the page instead.
          { wide: false, beside: false, below: true, trayCappedAtSquare: false },
    );
  }

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 800);
    window.webContents.setZoomFactor(1);
  });
  await marker.focus();
  const before = await marker.getAttribute("style");
  await marker.press("ArrowRight");
  await expect(marker).not.toHaveAttribute("style", before!);
  // The editor autosaves: the nudge burst settles into one save with an Undo toast.
  const moved = page.locator("[data-sonner-toast]", {
    hasText: new RegExp(`Moved ${E2E_MODEL_DISPLAY_NAME} from `, "u"),
  });
  await expect(moved).toBeVisible();
  await moved.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(marker).toHaveAttribute("style", before!);
});
