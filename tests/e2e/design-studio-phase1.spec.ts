import { expect, finishLmStudioOnboarding, test } from "./fixtures";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL2aQAAAABJRU5ErkJggg==",
  "base64",
);

test("Design Studio exposes a coherent keyboard-accessible blank workbench", async ({ aiden }) => {
  const { page } = aiden;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await finishLmStudioOnboarding(page);

  await page.getByRole("button", { name: /^Current mode: Agent/u }).click();
  await page.getByRole("menuitemradio", { name: /Design.*Create, iterate, and explore/u }).click();
  await page.getByRole("button", { name: "New Project" }).click();
  await expect(page.getByRole("dialog", { name: "New Design Project" })).toHaveCount(0);

  const canvas = page.getByRole("region", { name: "Design workspace canvas" });
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("main").getByText("Untitled Design", { exact: true })).toBeVisible();
  const tools = page.getByRole("navigation", { name: "Canvas tools" });
  await expect(tools.getByRole("button", { name: "Select (V)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(tools.getByRole("button", { name: "Hand (H)" })).toBeEnabled();
  await expect(tools.getByRole("button", { name: "Pick element (E)" })).toBeEnabled();
  await expect(tools.getByRole("button", { name: "Preview" })).toBeEnabled();
  await expect(tools.getByRole("button", { name: "Explore" })).toBeEnabled();
  await expect(tools.getByRole("button", { name: "Refine" })).toBeDisabled();
  await expect(tools.getByRole("button", { name: "Export" })).toBeDisabled();

  await page.getByLabel("Add reference images to canvas").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: ONE_PIXEL_PNG,
  });
  const uploadedReference = canvas
    .locator("[data-design-image]")
    .filter({ hasText: "reference.png" });
  await expect(uploadedReference).toBeVisible();
  await expect(uploadedReference).toHaveClass(/ring-2/u);
  if (await page.getByText("Something went wrong", { exact: true }).isVisible()) {
    throw new Error(pageErrors.join("\n\n") || "Design workbench hit the root error boundary.");
  }
  await canvas.focus();
  await page.keyboard.press("h");
  await expect(tools.getByRole("button", { name: "Hand (H)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Meta+v");
  await expect(tools.getByRole("button", { name: "Hand (H)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("v");
  await expect(tools.getByRole("button", { name: "Select (V)" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const screensTrigger = page.getByRole("button", { name: /Screens · 0/u });
  await screensTrigger.click();
  const screenSearch = page.getByRole("searchbox", { name: "Search Screens" });
  await expect(screenSearch).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(screensTrigger).toBeFocused();

  await page.setViewportSize({ width: 390, height: 800 });
  const connect = page.getByRole("button", { name: "Connect app…" });
  const zoomControls = canvas.locator(".react-flow__controls");
  await expect(connect).toBeVisible();
  await expect(zoomControls).toBeVisible();
  const [connectBox, zoomBox] = await Promise.all([
    connect.boundingBox(),
    zoomControls.boundingBox(),
  ]);
  expect(connectBox).not.toBeNull();
  expect(zoomBox).not.toBeNull();
  expect(connectBox!.y + connectBox!.height + 8).toBeLessThanOrEqual(zoomBox!.y);
  expect(pageErrors).toEqual([]);
});
