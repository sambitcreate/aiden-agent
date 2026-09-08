import { E2E_MODEL_DISPLAY_NAME, expect, finishLmStudioOnboarding, test } from "./fixtures";

type PadReachability = {
  fits: boolean;
  pad: { top: number; bottom: number; height: number };
  scrollport: {
    top: number;
    bottom: number;
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  } | null;
  viewport: { width: number; height: number };
};

// Measure rendered geometry in Electron, including both navigation columns and
// native zoom; CSS/source assertions cannot catch a square extending offscreen.
test("Model Pad fits resized settings and keeps models usable at native zoom", async ({
  aiden,
}) => {
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("button", { name: "Model Pad", exact: true })
    .click();
  const pad = page.getByRole("group", { name: "Personal Model Pad arrangement", exact: true });
  const browse = page.getByRole("button", { name: "Browse models", exact: true });
  const insights = page.getByRole("button", { name: "Benchmark insights", exact: true });

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

    for (const panel of ["closed", "models", "insights"] as const) {
      if (panel === "models") await browse.click();
      if (panel === "insights") await insights.click();
      await page.locator(".model-pad-fieldset").evaluate((element) => {
        let parent = element.parentElement;
        while (parent && !/(auto|scroll)/u.test(getComputedStyle(parent).overflowY))
          parent = parent.parentElement;
        if (parent) parent.scrollTop = 0;
      });
      await expect
        .poll(
          async () =>
            pad.evaluate((element) => {
              const bounds = element.getBoundingClientRect();
              const canvas = element.parentElement!;
              const grid = canvas.parentElement!;
              return {
                square: Math.abs(bounds.width - bounds.height) <= 1,
                fitsWidth: bounds.left >= 0 && bounds.right <= innerWidth,
                fitsHeight: bounds.height <= innerHeight,
                fitsContainer: bounds.width <= grid.clientWidth + 1,
                // On the smallest windows the surrounding settings controls scroll.
                // At normal sizes the entire canvas + labels must be in the viewport.
                fitsViewport:
                  innerWidth < 800 ||
                  innerHeight < 560 ||
                  canvas.getBoundingClientRect().bottom <= innerHeight,
              };
            }),
          { message: `${width}×${height}, ${zoom} zoom, ${panel}` },
        )
        .toEqual({
          square: true,
          fitsWidth: true,
          fitsHeight: true,
          fitsContainer: true,
          fitsViewport: true,
        });
      // Small/zoomed windows scroll their chrome; the entire Pad remains reachable.
      await expect
        .poll(
          () =>
            pad.evaluate(async (element): Promise<PadReachability> => {
              // A sidebar collapse or supporting-panel transition can finish after
              // the first scroll. Reapply the user's scroll after layout settles,
              // then sample on the following frame.
              element.scrollIntoView({ block: "center", inline: "nearest" });
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const bounds = element.getBoundingClientRect();
              let scrollport = element.parentElement;
              while (scrollport && !/(auto|scroll)/u.test(getComputedStyle(scrollport).overflowY)) {
                scrollport = scrollport.parentElement;
              }
              const scrollportBounds = scrollport?.getBoundingClientRect();
              const visibleTop = Math.max(0, scrollportBounds?.top ?? 0);
              const visibleBottom = Math.min(innerHeight, scrollportBounds?.bottom ?? innerHeight);
              return {
                fits: bounds.top >= visibleTop && bounds.bottom <= visibleBottom,
                pad: {
                  top: Math.round(bounds.top),
                  bottom: Math.round(bounds.bottom),
                  height: Math.round(bounds.height),
                },
                scrollport: scrollportBounds
                  ? {
                      top: Math.round(scrollportBounds.top),
                      bottom: Math.round(scrollportBounds.bottom),
                      clientHeight: scrollport!.clientHeight,
                      scrollHeight: scrollport!.scrollHeight,
                      scrollTop: scrollport!.scrollTop,
                    }
                  : null,
                viewport: { width: innerWidth, height: innerHeight },
              };
            }),
          { message: `reachable Pad at ${width}×${height}, ${zoom} zoom, ${panel}` },
        )
        .toMatchObject({ fits: true });
      const legend = page.locator(".model-pad-legend");
      await legend.scrollIntoViewIfNeeded();
      await expect(legend).toBeInViewport();
      if (panel === "insights") await insights.click();
    }
  }

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 800);
    window.webContents.setZoomFactor(1);
  });
  await browse.click();
  await page
    .getByRole("button", { name: new RegExp(`^Add ${E2E_MODEL_DISPLAY_NAME} .* to Pad$`, "u") })
    .click();
  const marker = pad.getByRole("button", {
    name: new RegExp(`^${E2E_MODEL_DISPLAY_NAME} from`, "u"),
  });
  await marker.focus();
  const before = await marker.getAttribute("style");
  await marker.press("ArrowRight");
  await expect(marker).not.toHaveAttribute("style", before!);
  await page.getByRole("button", { name: "Save Pad", exact: true }).click();
  await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
});
