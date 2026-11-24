import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import type { BrowserCommand, BrowserCommandResult, BrowserState } from "../../renderer/shared/browser";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });

type BrowserTestWindow = Window & {
  aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
};

async function command(page: Page, input: BrowserCommand): Promise<BrowserCommandResult> {
  return page.evaluate(
    async ({ workspaceId, input }) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserCommandResult>(
        "browser:command",
        workspaceId,
        input,
      ),
    { workspaceId: E2E_WORKSPACE_ID, input },
  );
}

async function state(page: Page): Promise<BrowserState> {
  return page.evaluate(
    async (workspaceId) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
        "browser:get-state",
        workspaceId,
      ),
    E2E_WORKSPACE_ID,
  );
}

const FIXTURE_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>React Grab fixture</title>
    <style>
      body { font: 16px system-ui, sans-serif; margin: 0; padding: 24px; background: #ffffff; color: #111827; }
      .hero { padding: 20px; border-radius: 12px; background: #eef2ff; margin-bottom: 16px; }
      .hero-cta { padding: 10px 18px; border-radius: 8px; border: 0; background: #2563eb; color: #ffffff; font-weight: 600; }
      .plain-card { padding: 16px; border-radius: 10px; background: #f3f4f6; margin-bottom: 16px; }
      .secret-form { padding: 16px; border-radius: 10px; background: #fef3c7; }
      .secret-form input { display: block; margin-top: 6px; padding: 8px; width: 220px; }
    </style>
  </head>
  <body>
    <main id="app-root">
      <section class="hero" id="hero-section">
        <h1 id="hero-title">Ship faster with Aiden</h1>
        <button id="hero-cta" class="hero-cta" type="button">Get started</button>
      </section>
      <article id="plain-card" class="plain-card">
        <h2>Plain HTML card</h2>
        <p>Static copy without React fibers.</p>
      </article>
      <form id="secret-form" class="secret-form">
        <label for="secret-password">Account password</label>
        <input id="secret-password" type="password" value="hunter2-secret-pass" />
      </form>
      <a id="next-link" href="/next">Next page</a>
    </main>
    <script>
      globalThis.clickSideEffects = 0;
      const cta = document.getElementById("hero-cta");
      cta.addEventListener("pointerdown", () => { globalThis.clickSideEffects += 1; });
      cta.addEventListener("mousedown", () => { globalThis.clickSideEffects += 1; });
      cta.addEventListener("click", () => { globalThis.clickSideEffects += 1; });

      // Hostile Escape listener that tries to swallow Escape when grab is active.
      window.addEventListener("keydown", (event) => {
        if (globalThis.hijackEscape && event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);

      // Attach a realistic React 18 fiber tree onto #hero-section and #hero-cta.
      function LandingPage() {}
      function LandingHeroClient() {}
      const pageFiber = {
        tag: 0,
        type: LandingPage,
        memoizedProps: { theme: "light" },
        _debugSource: { fileName: "/src/pages/LandingPage.tsx", lineNumber: 12, columnNumber: 3 },
        return: null,
      };
      const heroFiber = {
        tag: 0,
        type: LandingHeroClient,
        memoizedProps: { variant: "primary", ctaLabel: "Get started", apiToken: "sk-secret-value-12345678901234567890" },
        _debugSource: { fileName: "/src/components/LandingHeroClient.tsx", lineNumber: 42, columnNumber: 7 },
        _debugOwner: pageFiber,
        return: pageFiber,
      };
      const sectionHostFiber = {
        tag: 5,
        type: "section",
        stateNode: document.getElementById("hero-section"),
        _debugOwner: heroFiber,
        return: heroFiber,
      };
      const ctaHostFiber = {
        tag: 5,
        type: "button",
        stateNode: cta,
        _debugOwner: heroFiber,
        return: sectionHostFiber,
      };
      document.getElementById("hero-section")["__reactFiber$e2e"] = sectionHostFiber;
      cta["__reactFiber$e2e"] = ctaHostFiber;
    </script>
  </body>
</html>`;

const FRAME_CLICK_COUNTER = `<script>
  globalThis.frameClicks = 0;
  for (const name of ["pointerdown", "mousedown", "mouseup", "click"]) {
    document.addEventListener(name, () => { globalThis.frameClicks += 1; }, true);
  }
</script>`;

const frameSrcdoc = (buttonId: string) =>
  `<!doctype html><html><body style="margin:0;padding:16px"><button id="${buttonId}" style="width:160px;height:40px">Inside</button>${FRAME_CLICK_COUNTER}</body></html>`;

// A same-origin srcdoc frame, a cross-origin (localhost vs 127.0.0.1) frame, a
// host whose open shadow root exists from the start, and a plain host that gets
// a shadow root only once a grab is running.
const FRAMES_FIXTURE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Grab frames fixture</title></head>
  <body style="margin:0;padding:24px">
    <iframe id="same-frame" style="display:block;width:320px;height:120px;border:0" srcdoc='${frameSrcdoc("frame-cta").replace(/'/gu, "&#39;")}'></iframe>
    <iframe id="cross-frame" style="display:block;width:320px;height:80px;border:0;margin-top:16px" src="CROSS_ORIGIN_SRC"></iframe>
    <div id="shadow-host" style="display:block;width:320px;padding:12px;margin-top:16px;background:#eef2ff"></div>
    <div id="late-host" style="display:block;width:320px;padding:12px;margin-top:16px;background:#ecfdf5"></div>
    <script>document.getElementById("shadow-host").attachShadow({ mode: "open" });</script>
  </body>
</html>`;

// Runs in the guest page once a grab is active: frames appear inside shadow trees
// the grab could not have scanned when it started.
const ADD_SHADOW_FRAMES_SCRIPT = `(() => {
  const frame = (id, buttonId) => {
    const element = document.createElement("iframe");
    element.id = id;
    element.style.cssText = "display:block;width:320px;height:80px;border:0";
    element.srcdoc = ${JSON.stringify(frameSrcdoc("BUTTON_ID"))}.replace("BUTTON_ID", buttonId);
    return element;
  };
  document.getElementById("shadow-host").shadowRoot.append(frame("shadow-frame", "shadow-cta"));
  const late = document.getElementById("late-host").attachShadow({ mode: "open" });
  late.append(frame("late-frame", "late-cta"));
  return true;
})()`;

async function startFixtureServer() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.url === "/next") {
      response.end("<!doctype html><html><head><title>Next page</title></head><body><h1>Next</h1></body></html>");
      return;
    }
    if (request.url === "/frames") {
      response.end(FRAMES_FIXTURE_HTML.replace("CROSS_ORIGIN_SRC", `http://localhost:${(server.address() as AddressInfo).port}/cross-frame`));
      return;
    }
    if (request.url === "/cross-frame") {
      response.end(`<!doctype html><html><body style="margin:0"><button id="cross-cta" style="width:100%;height:60px">Cross</button>${FRAME_CLICK_COUNTER}</body></html>`);
      return;
    }
    response.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function openBrowserFixture(page: Page, url: string) {
  await page.getByRole("button", { name: "Show Environment" }).click();
  const surface = page.getByRole("complementary", { name: "Environment work surface" });
  await surface.getByRole("button", { name: "Browser", exact: true }).click();
  const opened = await command(page, { action: "create", url });
  const tabId = opened.state.activeTabId!;
  await expect
    .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.title)
    .toBe("React Grab fixture");
  await expect
    .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.visible)
    .toBe(true);
  return { surface, tabId };
}

test("grabbing a React element attaches an inspectable chip, masks secrets, and sends structured context + thumbnail to the model", async ({
  aiden,
}, testInfo) => {
  const fixture = await startFixtureServer();
  try {
    const { app, page, lmStudio } = aiden;
    await finishLmStudioOnboarding(page);
    const { surface, tabId } = await openBrowserFixture(page, fixture.url);

    const grabButton = surface.getByRole("button", { name: "Grab element", exact: true });
    await expect(grabButton).toBeVisible();
    await expect(grabButton).toHaveAttribute("aria-pressed", "false");
    await expect(surface.getByRole("button", { name: /Annotate/u })).toBeVisible();

    await grabButton.click();
    await expect(surface.getByRole("button", { name: "Stop grabbing", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(surface.getByText(/Click an element to grab for chat/u)).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }, guestUrl) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(guestUrl));
          return guest?.executeJavaScript(
            "typeof globalThis.__aidenGrabStart === 'function' && Boolean(document.querySelector('[data-aiden-grab-host=\"true\"]'))",
          );
        }, fixture.url),
      )
      .toBe(true);

    // Move over #hero-cta, step up with ArrowUp and back down with ArrowDown, then click.
    await app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl));
      if (!guest) throw new Error("Browser guest missing");
      const point = (await guest.executeJavaScript(
        "(() => { const el = document.getElementById('hero-cta'); el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
      )) as { x: number; y: number };
      guest.focus();
      guest.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 60));
      guest.sendInputEvent({ type: "keyDown", keyCode: "Up" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Up" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      guest.sendInputEvent({ type: "keyDown", keyCode: "Down" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Down" });
      await new Promise((resolve) => setTimeout(resolve, 40));
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    }, fixture.url);

    // Grab completes cleanly with zero page click side effects.
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);
    expect(
      await app.evaluate(({ webContents }, guestUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL().startsWith(guestUrl))!;
        return guest.executeJavaScript("globalThis.clickSideEffects");
      }, fixture.url),
    ).toBe(0);

    // Close the floating Environment panel so the composer & inspection popover are unobstructed.
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    await expect(surface).toBeHidden();

    // Composer shows the React component chip and hides the raw grab-thumb_* attachment card.
    const chipTrigger = page.locator("[data-grabbed-element-trigger]").first();
    await expect(chipTrigger).toBeVisible();
    await expect(chipTrigger).toContainText("<LandingHeroClient />");
    await expect(page.getByRole("button", { name: /^Remove LandingHeroClient\.png$/u })).toHaveCount(0);

    // Click to pin the inspection popover and inspect thumbnail, hierarchy, and details.
    await chipTrigger.click();
    const popover = page.getByRole("dialog", { name: "Included with your message" });
    await expect(popover).toBeVisible();
    const thumb = popover.locator("img");
    await expect(thumb).toBeVisible();
    await expect
      .poll(() => thumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await expect(popover).toContainText("<LandingHeroClient />");
    await expect(popover).toContainText("LandingHeroClient in LandingPage");

    const detailsToggle = popover.locator("[data-grabbed-element-details-toggle]");
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(popover).toContainText("src/components/LandingHeroClient.tsx:42:7");
    await expect(popover).toContainText("React");
    await expect(popover).toContainText("#hero-cta");
    await expect(popover).toContainText("[redacted]");
    await expect(popover).not.toContainText("sk-secret-value-12345678901234567890");

    const popoverScreenshot = testInfo.outputPath("browser-grab-popover.png");
    await page.screenshot({ path: popoverScreenshot });
    await testInfo.attach("browser-grab-popover", {
      path: popoverScreenshot,
      contentType: "image/png",
    });

    // Escape closes the popover and returns focus to the chip trigger.
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(chipTrigger).toBeFocused();

    // Send the message and verify mock LM Studio received structured element context + cropped thumbnail.
    const prompt = "Tighten the CTA padding";
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Deterministic E2E response received.", { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    const completion = [...lmStudio.requests]
      .reverse()
      .find((req) => req.url === "/v1/chat/completions");
    expect(completion).toBeDefined();
    const body = completion!.body as {
      messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
    };
    const lastUser = [...body.messages].reverse().find((msg) => msg.role === "user");
    expect(lastUser).toBeDefined();
    expect(Array.isArray(lastUser!.content)).toBe(true);
    const parts = lastUser!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const textPart = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    expect(textPart).toContain("<attached-browser-elements>");
    expect(textPart).toContain("<LandingHeroClient />");
    expect(textPart).toContain("src/components/LandingHeroClient.tsx:42:7");
    expect(textPart).toContain("- Thumbnail: attached cropped screenshot");
    expect(textPart).toContain(prompt);
    expect(textPart).not.toContain("sk-secret-value-12345678901234567890");
    expect(parts.some((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/"))).toBe(
      true,
    );

    // Sent user message renders the read-only chip with popover and no Remove button.
    const transcriptTrigger = page.getByRole("button", {
      name: "Inspect browser element <LandingHeroClient />",
    });
    await expect(transcriptTrigger).toBeVisible();
    await expect(page.locator("[data-grabbed-element-remove]")).toHaveCount(0);
    await transcriptTrigger.click();
    const transcriptPopover = page.getByRole("dialog", { name: "Included with message" });
    await expect(transcriptPopover).toBeVisible();
    const transcriptThumb = transcriptPopover.locator("img");
    await expect(transcriptThumb).toBeVisible();
    await expect
      .poll(() => transcriptThumb.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    const transcriptScreenshot = testInfo.outputPath("browser-grab-transcript.png");
    await page.screenshot({ path: transcriptScreenshot });
    await testInfo.attach("browser-grab-transcript", {
      path: transcriptScreenshot,
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(transcriptPopover).toBeHidden();

    await command(page, { action: "close", tabId });
  } finally {
    await fixture.close();
  }
});

test("shortcut, unstoppable Escape, Shift+Click multi-grab, DevTools-open capture, and navigation/tab cleanup work reliably", async ({
  aiden,
}) => {
  const fixture = await startFixtureServer();
  try {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    const { surface, tabId } = await openBrowserFixture(page, fixture.url);

    // 1. Activate grab via keyboard shortcut from guest WebContentsView.
    await app.evaluate(({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl));
      if (!guest) throw new Error("Browser guest missing");
      guest.focus();
      const modifiers: Array<"meta" | "control" | "shift"> =
        process.platform === "darwin" ? ["meta", "shift"] : ["control", "shift"];
      guest.sendInputEvent({ type: "keyDown", keyCode: "G", modifiers });
      guest.sendInputEvent({ type: "keyUp", keyCode: "G", modifiers });
    }, fixture.url);
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);

    // 2. Guest-focused Escape is unstoppable even when the page attempts to swallow Escape.
    await app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl))!;
      await guest.executeJavaScript("globalThis.hijackEscape = true");
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      guest.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    }, fixture.url);
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);
    await expect(surface).toBeVisible();

    // 3. Host-focused Escape cancels grab without closing the Environment panel.
    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);
    await page.getByRole("button", { name: "Stop grabbing", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);
    await expect(surface).toBeVisible();

    // 4. Shift+Click keeps grab active for multi-grab, then plain click completes it.
    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);
    await app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl))!;
      const point = (await guest.executeJavaScript(
        "(() => { const el = document.getElementById('hero-cta'); el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
      )) as { x: number; y: number };
      guest.focus();
      guest.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 40));
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, modifiers: ["shift"], ...point });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, modifiers: ["shift"], ...point });
    }, fixture.url);

    await expect(page.locator("[data-grabbed-element-trigger]")).toHaveCount(1);
    expect((await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing).toBe(true);

    await app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl))!;
      const point = (await guest.executeJavaScript(
        "(() => { const el = document.getElementById('plain-card'); el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
      )) as { x: number; y: number };
      guest.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 40));
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    }, fixture.url);

    await expect(page.locator("[data-grabbed-element-trigger]")).toHaveCount(2);
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);

    // 5. DevTools-open capture succeeds cleanly without throwing (uses viewport fallback, not CDP).
    await command(page, { action: "devtools", tabId });
    await expect
      .poll(() =>
        app.evaluate(({ webContents }, guestUrl) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL().startsWith(guestUrl));
          return Boolean(guest?.isDevToolsOpened());
        }, fixture.url),
      )
      .toBe(true);

    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);
    await app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl))!;
      const point = (await guest.executeJavaScript(
        "(() => { const el = document.getElementById('secret-form'); el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()",
      )) as { x: number; y: number };
      guest.focus();
      guest.sendInputEvent({ type: "mouseMove", ...point });
      await new Promise((resolve) => setTimeout(resolve, 40));
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    }, fixture.url);

    await expect(page.locator("[data-grabbed-element-trigger]")).toHaveCount(3);
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);

    await app.evaluate(({ webContents }, guestUrl) => {
      const guest = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith(guestUrl));
      guest?.closeDevTools();
    }, fixture.url);

    // 6. Navigation stops grab automatically.
    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);
    await command(page, { action: "navigate", tabId, url: `${fixture.url}/next` });
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);

    // 7. Tab switch stops grab automatically.
    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);
    const second = await command(page, { action: "create", url: fixture.url });
    const secondTabId = second.state.activeTabId!;
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);

    await command(page, { action: "close", tabId: secondTabId });
    await command(page, { action: "close", tabId });
  } finally {
    await fixture.close();
  }
});

test("grabbing inside same-origin and cross-origin frames captures the element and never reaches frame handlers", async ({
  aiden,
}) => {
  const fixture = await startFixtureServer();
  try {
    const { app, page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: "Show Environment" }).click();
    const surface = page.getByRole("complementary", { name: "Environment work surface" });
    await surface.getByRole("button", { name: "Browser", exact: true }).click();
    const opened = await command(page, { action: "create", url: `${fixture.url}/frames` });
    const tabId = opened.state.activeTabId!;
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.title)
      .toBe("Grab frames fixture");
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.visible)
      .toBe(true);
    const pageUrl = `${fixture.url}/frames`;
    const crossUrl = `http://localhost:${new URL(fixture.url).port}/cross-frame`;
    await expect
      .poll(() =>
        app.evaluate(async ({ webContents }, { pageUrl, crossUrl }) => {
          const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl);
          const cross = guest?.mainFrame.framesInSubtree.find((frame) => frame.url === crossUrl);
          const same = await guest?.executeJavaScript("document.getElementById('same-frame').contentDocument?.getElementById('frame-cta') ? true : false");
          return Boolean(cross && same && (await cross.executeJavaScript("typeof globalThis.frameClicks")) === "number");
        }, { pageUrl, crossUrl }),
      )
      .toBe(true);

    // Same-origin frames by where they live: the light DOM, a shadow root that
    // existed when the grab started, and one attached while it runs.
    const SAME_ORIGIN_FRAMES = {
      same: "document.getElementById('same-frame')",
      shadow: "document.getElementById('shadow-host').shadowRoot.getElementById('shadow-frame')",
      late: "document.getElementById('late-host').shadowRoot.getElementById('late-frame')",
    } as const;
    const BUTTON_IDS = { same: "frame-cta", shadow: "shadow-cta", late: "late-cta" } as const;
    type FrameName = keyof typeof SAME_ORIGIN_FRAMES;

    const clickAt = (selector: FrameName | "cross", shift: boolean, approachFrom?: "late-host") =>
      app.evaluate(async ({ webContents }, { pageUrl, selector, shift, approachFrom, frames, buttons }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)!;
        const point = (await guest.executeJavaScript(
          selector === "cross"
            ? "(() => { const r = document.getElementById('cross-frame').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()"
            : `(() => { const element = ${frames[selector]}; element.scrollIntoView({ block: 'center' }); const frame = element.getBoundingClientRect(); const r = element.contentDocument.getElementById('${buttons[selector]}').getBoundingClientRect(); return { x: Math.round(frame.x + r.x + r.width / 2), y: Math.round(frame.y + r.y + r.height / 2) }; })()`,
        )) as { x: number; y: number };
        const modifiers: Array<"shift"> = shift ? ["shift"] : [];
        guest.focus();
        if (approachFrom) {
          // Cross the host's padding on the way in, as a real pointer does.
          const edge = (await guest.executeJavaScript(
            `(() => { const r = document.getElementById('${approachFrom}').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 4) }; })()`,
          )) as { x: number; y: number };
          guest.sendInputEvent({ type: "mouseMove", ...edge });
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        guest.sendInputEvent({ type: "mouseMove", ...point });
        await new Promise((resolve) => setTimeout(resolve, 40));
        guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, modifiers, ...point });
        guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, modifiers, ...point });
      }, { pageUrl, selector, shift, approachFrom, frames: SAME_ORIGIN_FRAMES, buttons: BUTTON_IDS });

    await surface.getByRole("button", { name: "Grab element", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(true);

    // The element inside the same-origin frame is captured, not the frame.
    await clickAt("same", true);
    const chips = page.locator("[data-grabbed-element-trigger]");
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toContainText("button#frame-cta");

    // Frames added inside shadow trees after the grab started are shielded too:
    // one in a shadow root the grab already knew, one in a root attached later.
    const evaluateGuest = (script: string) =>
      app.evaluate(async ({ webContents }, { pageUrl, script }) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)!;
        return guest.executeJavaScript(script);
      }, { pageUrl, script });
    expect(await evaluateGuest(ADD_SHADOW_FRAMES_SCRIPT)).toBe(true);
    await expect
      .poll(() =>
        evaluateGuest(
          `[${SAME_ORIGIN_FRAMES.shadow}, ${SAME_ORIGIN_FRAMES.late}].every((frame) => typeof frame?.contentWindow?.frameClicks === "number" && frame.contentDocument.querySelector("button"))`,
        ),
      )
      .toBe(true);
    await clickAt("shadow", true);
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toContainText("button#shadow-cta");
    await clickAt("late", true, "late-host");
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(2)).toContainText("button#late-cta");

    // A cross-origin frame is captured as the frame element itself.
    await clickAt("cross", false);
    await expect(chips).toHaveCount(4);
    await expect(chips.nth(3)).toContainText("iframe#cross-frame");
    await expect
      .poll(async () => (await state(page)).tabs.find((tab) => tab.id === tabId)?.grabbing)
      .toBe(false);

    // No frame saw a pointer event, and the frames are clickable again afterwards.
    const counts = await app.evaluate(async ({ webContents }, { pageUrl, crossUrl, frames }) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === pageUrl)!;
      const cross = guest.mainFrame.framesInSubtree.find((frame) => frame.url === crossUrl)!;
      const sameOrigin = `[${Object.values(frames).join(", ")}]`;
      return {
        same: await guest.executeJavaScript(`${sameOrigin}.map((frame) => frame.contentWindow.frameClicks)`),
        cross: await cross.executeJavaScript("globalThis.frameClicks"),
        restored: await guest.executeJavaScript(
          `[...document.querySelectorAll('iframe'), ...${sameOrigin}].every((frame) => frame.style.pointerEvents === '')`,
        ),
      };
    }, { pageUrl, crossUrl, frames: SAME_ORIGIN_FRAMES });
    expect(counts).toEqual({ same: [0, 0, 0], cross: 0, restored: true });

    await command(page, { action: "close", tabId });
  } finally {
    await fixture.close();
  }
});
