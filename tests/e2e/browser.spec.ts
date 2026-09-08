import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import type { BrowserCommand, BrowserCommandResult, BrowserState } from "../../renderer/shared/browser";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });
type BrowserTestWindow = Window & { aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } } };

async function command(page: Page, input: BrowserCommand): Promise<BrowserCommandResult> {
  return page.evaluate(async ({ workspaceId, input }) => (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserCommandResult>("browser:command", workspaceId, input), { workspaceId: E2E_WORKSPACE_ID, input });
}
async function state(page: Page): Promise<BrowserState> {
  return page.evaluate(async (workspaceId) => (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>("browser:get-state", workspaceId), E2E_WORKSPACE_ID);
}

test("browser user and automation share a sandboxed page, annotations and isolated profiles", async ({ aiden }, testInfo) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><head><title>${request.url === "/next" ? "Next page" : "Browser fixture"}</title><style>body{font:18px system-ui;padding:32px}button,input{font:inherit;margin:8px;padding:10px} @media(prefers-color-scheme:dark){body{background:#141414;color:#eee}}</style></head><body><h1>Shared browser fixture</h1><label>Name<input id="name" aria-label="Name"></label><button id="save" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save settings</button><p id="result">Ready</p><a href="/next">Next page</a><div id="shadow"></div><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>';</script></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { page } = aiden;
    await finishLmStudioOnboarding(page);
    await page.getByRole("button", { name: "Show Environment" }).click();
    const surface = page.getByRole("complementary", { name: "Environment work surface" });
    await surface.getByRole("tab", { name: "Browser", exact: true }).click();
    const opened = await command(page, { action: "create", url });
    const tabId = opened.state.activeTabId!;
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.title).toBe("Browser fixture");
    await expect(surface.getByRole("button", { name: /Annotate/ })).toBeVisible();

    const sandbox = await command(page, { action: "evaluate", tabId, expression: "({ bridge: typeof window.aidenAPI, node: typeof process, require: typeof require })" });
    expect(sandbox.value).toEqual({ bridge: "undefined", node: "undefined", require: "undefined" });
    await command(page, { action: "type", tabId, selector: "#name", text: "Aiden", clear: true });
    await command(page, { action: "click", tabId, selector: "#save" });
    const snapshot = await command(page, { action: "snapshot", tabId, includeImage: true });
    expect(snapshot.snapshot?.text).toContain("Saved Aiden");
    expect(snapshot.snapshot?.elements.some(element => element.text.includes("Save settings"))).toBe(true);
    expect(snapshot.snapshot?.image?.data.length).toBeGreaterThan(100);
    expect(snapshot.snapshot?.accessibilityTree).toBeDefined();
    const originalColor = (await command(page, { action: "evaluate", tabId, expression: "getComputedStyle(document.querySelector('#save')).color" })).value;
    const styled = await command(page, { action: "annotation_preview", tabId, changes: [
      { ref: "save", selector: "#save", styles: { color: "rgb(12, 34, 56)", "border-radius": "14px" } },
      { ref: "name", selector: "#name", styles: { color: "rgb(78, 90, 12)" } },
    ] });
    expect(styled.elementStyleChanges).toHaveLength(2);
    expect(styled.elementStyleChanges?.[0].changes.color.previous).toBe(originalColor);
    expect((await command(page, { action: "evaluate", tabId, expression: "getComputedStyle(document.querySelector('#save')).color" })).value).toBe("rgb(12, 34, 56)");
    await command(page, { action: "annotation_reset", tabId });
    expect((await command(page, { action: "evaluate", tabId, expression: "getComputedStyle(document.querySelector('#save')).color" })).value).toBe(originalColor);

    await command(page, { action: "click", tabId, locator: "role=button[name='Shadow action']" });
    // Covered shadow-root targets must never turn into an accidental click on an overlay.
    await command(page, { action: "evaluate", tabId, expression: "(() => { const cover=document.createElement('div');cover.id='cover';Object.assign(cover.style,{position:'fixed',inset:'0',zIndex:'9999'});document.body.append(cover); })()" });
    await expect(command(page, { action: "click", tabId, locator: "role=button[name='Shadow action']", timeoutMs: 300 })).rejects.toThrow();
    await command(page, { action: "evaluate", tabId, expression: "document.querySelector('#cover').remove()" });

    const draft = page.locator("textarea").first();
    await draft.fill("Existing draft.");
    await command(page, { action: "evaluate", tabId, expression: "globalThis.pickSideEffects=0;document.querySelector('#save').onpointerdown=()=>globalThis.pickSideEffects++;document.querySelector('#save').onmousedown=()=>globalThis.pickSideEffects++" });
    // A native-focused guest forwards the shortcut to the host, then the live picker
    // returns the chosen element and selected text to the actual annotation editor.
    await aiden.app.evaluate(({ webContents }, guestUrl) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(guestUrl));
      if (!guest) throw new Error("Browser guest missing");
      guest.focus();
      guest.sendInputEvent({ type: "keyDown", keyCode: ".", modifiers: ["meta"] });
      guest.sendInputEvent({ type: "keyUp", keyCode: ".", modifiers: ["meta"] });
    }, url);
    await expect.poll(() => aiden.app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(guestUrl));
      return guest?.executeJavaScript("typeof globalThis.__aidenPickerCancel === 'function'");
    }, url)).toBe(true);
    await aiden.app.evaluate(async ({ webContents }, guestUrl) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(guestUrl))!;
      const point = await guest.executeJavaScript("(() => { const el=document.querySelector('#save');const range=document.createRange();range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);const r=el.getBoundingClientRect();return { x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2) }; })()");
      guest.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      guest.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    }, url);
    await expect(page.getByRole("region", { name: "Annotate browser" })).toBeVisible();
    expect((await command(page, { action: "evaluate", tabId, expression: "globalThis.pickSideEffects" })).value).toBe(0);
    await page.getByRole("textbox", { name: "Annotation comment" }).fill("Make this button clearer.");
    await draft.evaluate(input => { (input as HTMLTextAreaElement).readOnly = true; });
    await page.getByRole("button", { name: "Add to chat", exact: true }).click();
    await expect(page.getByRole("region", { name: "Annotate browser" })).toBeVisible();
    await expect(draft).toHaveValue("Existing draft.");
    await draft.evaluate(input => { (input as HTMLTextAreaElement).readOnly = false; });
    await page.getByRole("textbox", { name: "Annotation comment" }).press("Meta+Enter");
    await expect(draft).toHaveValue("Existing draft.\n\nMake this button clearer.");
    await expect(page.getByRole("button", { name: "Remove Browser annotation.txt" })).toBeVisible();

    await command(page, { action: "navigate", tabId, url: `${url}/next` });
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.title).toBe("Next page");
    await command(page, { action: "back", tabId });
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.title).toBe("Browser fixture");
    await expect(command(page, { action: "navigate", tabId, url: "file:///etc/passwd" })).rejects.toThrow();

    await command(page, { action: "evaluate", tabId, expression: "document.cookie='shared=default; path=/'" });
    const incognito = await command(page, { action: "create", url, profileId: "incognito" });
    const privateId = incognito.state.activeTabId!;
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === privateId)?.loading).toBe(false);
    expect((await command(page, { action: "evaluate", tabId: privateId, expression: "document.cookie" })).value).not.toContain("shared=default");
    await command(page, { action: "close", tabId: privateId });
    await command(page, { action: "select", tabId });

    await command(page, { action: "viewport", tabId, viewport: { mode: "responsive", width: 390, height: 844, deviceName: "iPhone 12 Pro" } });
    expect((await command(page, { action: "evaluate", tabId, expression: "({ width: innerWidth, height: innerHeight })" })).value).toEqual({ width: 390, height: 844 });
    await command(page, { action: "appearance", tabId, appearance: "dark" });
    expect((await command(page, { action: "evaluate", tabId, expression: "matchMedia('(prefers-color-scheme: dark)').matches" })).value).toBe(true);
    await command(page, { action: "viewport", tabId, viewport: { mode: "responsive", width: 1280, height: 720 } });
    await command(page, { action: "zoom", tabId, zoom: 1.25 });
    const wideSnapshot = (await command(page, { action: "snapshot", tabId, includeImage: true })).snapshot!;
    expect(Math.abs(wideSnapshot.image!.width / wideSnapshot.image!.height - wideSnapshot.tab.viewport.width / wideSnapshot.tab.viewport.height)).toBeLessThan(0.02);
    await command(page, { action: "zoom", tabId, zoom: 1 });
    await command(page, { action: "viewport", tabId, viewport: { mode: "fill", width: 1280, height: 720 } });

    await surface.getByRole("tab", { name: "Review", exact: true }).click();
    expect((await state(page)).tabs.some(tab => tab.id === tabId)).toBe(true);
    await surface.getByRole("tab", { name: "Browser", exact: true }).click();
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(true);
    await surface.getByRole("button", { name: "Browser menu" }).click();
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("browser-light.png") });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByRole("radio", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "Back to app" }).click();
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("browser-dark.png") });
    const windowsBeforeFloat = aiden.app.windows().length;
    await command(page, { action: "float", tabId, floating: true });
    const floating = page.getByRole("region", { name: "Floating browser preview" });
    await expect(floating).toBeVisible();
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    await expect(surface).toBeHidden();
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(true);
    expect(aiden.app.windows()).toHaveLength(windowsBeforeFloat);
    await floating.getByRole("button", { name: "New browser tab", exact: true }).click();
    const secondTabId = (await state(page)).activeTabId!;
    expect(secondTabId).not.toBe(tabId);
    expect((await state(page)).tabs.find(tab => tab.id === secondTabId)?.floating).toBe(true);
    await floating.getByRole("tab", { name: "Browser fixture", exact: true }).click();
    await expect.poll(async () => (await state(page)).activeTabId).toBe(tabId);
    await expect(floating).toBeVisible();
    await expect(surface).toBeHidden();
    // about:blank can publish its title after creation. Target the selected row
    // rather than retaining a title captured before that navigation event.
    await floating.getByRole("tab").nth(1).click();
    await expect.poll(async () => (await state(page)).activeTabId).toBe(secondTabId);
    await expect(floating.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
    await floating.locator(".browser-tab").nth(1).getByRole("button", { name: /^Close / }).click();
    await expect.poll(async () => (await state(page)).activeTabId).toBe(tabId);
    await expect(floating).toBeVisible();
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.visible).toBe(true);
    await expect.poll(async () => {
      const frame = await floating.boundingBox();
      const composer = await page.locator('[data-browser-composer-inset="true"]').boundingBox();
      return Boolean(frame && composer && frame.y + frame.height <= composer.y - 10);
    }).toBe(true);
    await expect.poll(async () => {
      const slot = await floating.locator(".browser-native-slot").boundingBox();
      const native = await aiden.app.evaluate(({ BrowserWindow }, guestUrl) => {
        for (const window of BrowserWindow.getAllWindows()) {
          const view = window.contentView.children.find(child => "webContents" in child && (child as Electron.WebContentsView).webContents.getURL() === new URL(guestUrl).href);
          if (view) return { ...view.getBounds(), scale: window.webContents.getZoomFactor() };
        }
        return null;
      }, url);
      if (!slot || !native) return { slot, native };
      return Object.fromEntries((["x", "y", "width", "height"] as const)
        .filter(key => Math.abs(native[key] - Math.round(slot[key] * native.scale)) > 1)
        .map(key => [key, { expected: Math.round(slot[key] * native.scale), actual: native[key], slot, native }]));
    }).toEqual({});
    if (process.env.AIDEN_BROWSER_VISUAL_REVIEW === "1") await new Promise(resolve => setTimeout(resolve, 45_000));
    await floating.getByRole("button", { name: "Return browser to Environment", exact: true }).click();
    await expect(surface).toBeVisible();
    await command(page, { action: "close", tabId });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("workspace documents and app links open in the shared browser", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await mkdir(path.join(aiden.workspaceDir, "docs"), { recursive: true });
  await writeFile(path.join(aiden.workspaceDir, "docs", "preview.html"), '<!doctype html><title>Workspace preview</title><link rel="stylesheet" href="/preview.css"><h1>Local document</h1>');
  await writeFile(path.join(aiden.workspaceDir, "preview.css"), 'h1 { color: rgb(12, 34, 56); }');
  const opened = await command(page, { action: "open_file", path: "docs/preview.html" });
  const tabId = opened.state.activeTabId!;
  await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.title).toBe("Workspace preview");
  expect((await command(page, { action: "evaluate", tabId, expression: "getComputedStyle(document.querySelector('h1')).color" })).value).toBe("rgb(12, 34, 56)");
  const localSnapshot = await command(page, { action: "snapshot", tabId, includeImage: false });
  expect(JSON.stringify(localSnapshot)).not.toContain("__aiden_preview");
  await command(page, { action: "defaults", defaults: { linkTarget: "browser" } });
  const targetUrl = (await state(page)).tabs.find(tab => tab.id === tabId)!.url;
  await page.evaluate(url => { const a=document.createElement("a");a.href=url;a.textContent="Browser routing fixture";document.body.append(a); }, targetUrl);
  await page.getByRole("link", { name: "Browser routing fixture" }).click();
  await expect.poll(async () => (await state(page)).tabs.length).toBe(2);
  await expect(command(page, { action: "open_file", path: "../../etc/passwd" })).rejects.toThrow();
  const pdfBytes = await aiden.app.evaluate(async ({ webContents }) => {
    const guest = webContents.getAllWebContents().find(contents => contents.getURL().includes("/docs/preview.html"));
    if (!guest) throw new Error("Local document guest missing");
    return Array.from(await guest.printToPDF({ pageSize: "A4" }));
  });
  await writeFile(path.join(aiden.workspaceDir, "preview.pdf"), Buffer.from(pdfBytes));
  const pdf = await command(page, { action: "open_file", path: "preview.pdf" });
  await expect.poll(async () => (await command(page, { action: "evaluate", tabId: pdf.state.activeTabId!, expression: "document.contentType === 'application/pdf' || Boolean(document.querySelector('embed[type=\"application/pdf\"]'))" })).value).toBe(true);
  for (const tab of (await state(page)).tabs) await command(page, { action: "close", tabId: tab.id });
  await command(page, { action: "agent_access", access: "off" });
  expect((await state(page)).agentAccessAllowed).toBe(false);
  const relaunched = await aiden.relaunch();
  const restored = await state(relaunched);
  expect(restored.agentAccessOverride).toBe("off");
  expect(restored.agentAccessAllowed).toBe(false);
  expect(restored.history).toEqual([]);
  expect(restored.tabs).toEqual([]);
});

test("direct user document links discover static sidecars without widening agent file grants", async ({ aiden }) => {
  const { page, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  const folder = path.join(aiden.workspaceDir, "user-preview");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "index.html"), '<!doctype html><title>User resource preview</title><link rel="stylesheet" href="./style.css"><script type="module" src="./main.js"></script><h1>Local resource graph</h1>');
  await writeFile(path.join(folder, "style.css"), '@import "./colors.css"; h1 { color: var(--preview-color); }');
  await writeFile(path.join(folder, "colors.css"), ':root { --preview-color: rgb(12, 34, 56); }');
  await writeFile(path.join(folder, "main.js"), 'import { message } from "./message.js"; window.previewMessage = message;');
  await writeFile(path.join(folder, "message.js"), 'export const message = "static module loaded";');
  await writeFile(path.join(folder, "unrelated.js"), 'PRIVATE_UNDECLARED_SIBLING');
  // Exercise the app's real local-link handler, which supplies only the path,
  // just like Files → Open in Browser and terminal document links.
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "user-preview/index.html";
    link.textContent = "Open local resource preview";
    document.body.append(link);
  });
  await page.getByRole("link", { name: "Open local resource preview" }).click();
  await expect.poll(async () => (await state(page)).tabs.length).toBe(1);
  const userTab = (await state(page)).tabs[0]!;
  const content = async (tabId: string) => (await command(page, { action: "evaluate", tabId,
    expression: "(() => { const heading=document.querySelector('h1'); return heading ? {color:getComputedStyle(heading).color,message:window.previewMessage??null} : null; })()" })).value;
  await expect.poll(() => content(userTab.id)).toEqual({ color: "rgb(12, 34, 56)", message: "static module loaded" });
  expect((await command(page, { action: "evaluate", tabId: userTab.id,
    expression: "fetch('./unrelated.js').then(async response=>({status:response.status,text:await response.text()}))" })).value)
    .toMatchObject({ status: 403 });

  await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
  const prompt = "Strict local browser grant scenario: open user-preview/index.html without declaring assets.";
  const scenario = lmStudio.enqueueToolScenario!({ prompt, calls: [
    { name: "browser", arguments: {} },
    { name: "browser_open", arguments: { path: "user-preview/index.html", reuseExistingTab: false } },
  ], finalText: "The strict local preview is open." });
  await page.locator("textarea").first().fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText("The strict local preview is open.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
  expect(scenario.error).toBeUndefined();
  expect(scenario.completed).toBe(true);
  const agentTab = (await state(page)).tabs.find(tab => tab.id !== userTab.id)!;
  expect(new URL(agentTab.url).origin).not.toBe(new URL(userTab.url).origin);
  expect(await content(agentTab.id)).toEqual({ color: "rgb(0, 0, 0)", message: null });
  await command(page, { action: "close", tabId: agentTab.id });
  await command(page, { action: "close", tabId: userTab.id });
});

test("browser recording produces a real bounded WebM artifact", async ({ aiden }) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const opened = await command(page, { action: "create" });
  const tabId = opened.state.activeTabId!;
  for (let cycle = 0; cycle < 3; cycle++) {
    await command(page, { action: "record_start", tabId, fps: 10 });
    await expect.poll(async () => (await state(page)).tabs.find(tab => tab.id === tabId)?.recording).toBe(true);
    const stopped = await command(page, { action: "record_stop", tabId });
    expect(stopped.recording?.mimeType).toContain("video/webm");
    const bytes = await readFile(stopped.recording!.path);
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(stopped.recording!.sizeBytes).toBe(bytes.length);
    const decoded = await page.evaluate(async (base64) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), character => character.charCodeAt(0))], { type: "video/webm" }));
      try {
        return await new Promise<{ width: number; height: number }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Recorded WebM did not decode a video frame.")), 8_000);
          video.onloadeddata = () => { clearTimeout(timer); resolve({ width: video.videoWidth, height: video.videoHeight }); };
          video.onerror = () => { clearTimeout(timer); reject(new Error(video.error?.message || "Recorded WebM could not be decoded.")); };
          video.src = url;
          video.load();
        });
      } finally {
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
      }
    }, bytes.toString("base64"));
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
  }
  await command(page, { action: "close", tabId });
});
