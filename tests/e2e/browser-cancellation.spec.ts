import type { ElectronApplication, Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserState,
} from "../../renderer/shared/browser";
import { E2E_WORKSPACE_ID, expect, finishLmStudioOnboarding, test } from "./fixtures";

test.use({ workspaceSeed: true });
type BrowserTestWindow = Window & {
  aidenAPI: { ipc: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> } };
};
type HeldInput = {
  downDelivered: boolean;
  releases: number;
  release: () => void;
  restore: () => void;
};
type HeldCapture = { captured: boolean; calls: number; release: () => void; restore: () => void };
type BrowserTestGlobal = typeof globalThis & {
  __browserHeldInput?: HeldInput;
  __browserHeldCapture?: HeldCapture;
  __browserRestoreHitRace?: () => void;
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

async function blankGuestId(app: ElectronApplication): Promise<number> {
  let guestId = 0;
  // Tab creation intentionally returns before loadURL commits; wait for the native
  // document rather than matching an empty initial WebContents URL.
  await expect
    .poll(async () => {
      guestId = await app.evaluate(
        ({ webContents }) =>
          webContents.getAllWebContents().find((contents) => contents.getURL() === "about:blank")
            ?.id ?? 0,
      );
      return guestId;
    })
    .toBeGreaterThan(0);
  return guestId;
}

test("semantic clicks cannot hit an overlay introduced by hover or just before dispatch", async ({ aiden }) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>Browser click race</title>
      <style>button{position:fixed;left:100px;top:100px;width:200px;height:60px}#cover{display:none;z-index:2}</style>
      <button id="save" onpointerenter="window.hovers=(window.hovers||0)+1;document.querySelector('#cover').style.display='block'" onclick="window.saved=(window.saved||0)+1">Save</button>
      <button id="cover" onclick="window.covered=(window.covered||0)+1">Other action</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const { page, app, lmStudio } = aiden;
  let tabId: string | undefined;
  try {
    await finishLmStudioOnboarding(page);
    tabId = (await command(page, { action: "create" })).tabId!;
    await command(page, { action: "navigate", tabId, url, readiness: "load" });
    const values = async () => (await command(page, { action: "evaluate", tabId: tabId!, expression: "({saved:window.saved||0,covered:window.covered||0,hovers:window.hovers||0})" })).value;
    await expect(command(page, { action: "click", tabId, selector: "#save", timeoutMs: 1000 })).rejects.toThrow(/covers|covered|moved/);
    expect(await values()).toEqual({ saved: 0, covered: 0, hovers: 1 });

    // A second race happens after the preliminary hit-test. Only interception of
    // the trusted down/click events prevents dispatch into this new overlay.
    await command(page, { action: "evaluate", tabId, expression: "document.querySelector('#save').onpointerenter=null;document.querySelector('#cover').style.display='none'" });
    await app.evaluate(({ webContents }, targetUrl) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl)!;
      const original = guest.debugger.sendCommand.bind(guest.debugger);
      (globalThis as BrowserTestGlobal).__browserRestoreHitRace = () => { guest.debugger.sendCommand = original; };
      guest.debugger.sendCommand = async (method, params, sessionId) => {
        if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
          await guest.executeJavaScript("document.querySelector('#cover').style.display='block'");
        }
        return original(method, params, sessionId);
      };
    }, url);
    await expect(command(page, { action: "click", tabId, selector: "#save", timeoutMs: 1000 })).rejects.toThrow(/covered/);
    expect(await values()).toEqual({ saved: 0, covered: 0, hovers: 1 });
    await app.evaluate(() => { (globalThis as BrowserTestGlobal).__browserRestoreHitRace?.(); delete (globalThis as BrowserTestGlobal).__browserRestoreHitRace; });
    await command(page, { action: "evaluate", tabId, expression: "document.querySelector('#cover').style.display='none'" });
    await command(page, { action: "click", tabId, selector: "#save", timeoutMs: 1000 });
    expect(await values()).toEqual({ saved: 1, covered: 0, hovers: 1 });
    await page.getByRole("button", { name: "Close environment panel", exact: true }).click();
    const prompt = "Browser cursor cleanup scenario: click Save on the shared tab.";
    const scenario = lmStudio.enqueueToolScenario!({ prompt, calls: [
      { name: "browser", arguments: {} },
      { name: "browser_click", arguments: { selector: "#save" } },
    ], finalText: "The browser cursor action is complete." });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("The browser cursor action is complete.", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    expect(scenario.error).toBeUndefined();
    expect(scenario.completed).toBe(true);
    // Read the guest directly: another browser service action could otherwise
    // mask a leaked cursor by running its own completion cleanup.
    expect(await app.evaluate(async ({ webContents }, targetUrl) => {
      const guest = webContents.getAllWebContents().find(contents => contents.getURL() === targetUrl)!;
      return guest.executeJavaScript("({saved:window.saved||0,cursors:document.querySelectorAll('[data-aiden-browser-cursor]').length})");
    }, url)).toEqual({ saved: 2, cursors: 0 });
  } finally {
    await app.evaluate(() => { (globalThis as BrowserTestGlobal).__browserRestoreHitRace?.(); delete (globalThis as BrowserTestGlobal).__browserRestoreHitRace; });
    if (tabId) await command(page, { action: "close", tabId });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const kind of ["mouse", "key"] as const) {
  test(`browser user takeover releases ${kind} input when cancellation races the down response`, async ({
    aiden,
  }) => {
    const { page, app } = aiden;
    await finishLmStudioOnboarding(page);
    const opened = await command(page, { action: "create" });
    const tabId = opened.tabId!;
    const guestId = await blankGuestId(app);
    await app.evaluate(
      ({ webContents }, { guestId, kind }) => {
        const guest = webContents.fromId(guestId)!;
        guest.focus();
        const original = guest.debugger.sendCommand.bind(guest.debugger);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const state: HeldInput = {
          downDelivered: false,
          releases: 0,
          release,
          restore: () => {
            guest.debugger.sendCommand = original;
          },
        };
        (globalThis as BrowserTestGlobal).__browserHeldInput = state;
        const method = kind === "mouse" ? "Input.dispatchMouseEvent" : "Input.dispatchKeyEvent";
        const down = kind === "mouse" ? "mousePressed" : "keyDown";
        const up = kind === "mouse" ? "mouseReleased" : "keyUp";
        guest.debugger.sendCommand = async (name, params, sessionId) => {
          const value = await original(name, params, sessionId);
          if (name === method && params?.type === up) state.releases += 1;
          if (name === method && params?.type === down && !state.downDelivered) {
            state.downDelivered = true;
            await held;
          }
          return value;
        };
      },
      { guestId, kind },
    );
    try {
      const pending = command(
        page,
        kind === "mouse"
          ? { action: "click", tabId, x: 20, y: 20 }
          : { action: "press", tabId, key: "a" },
      ).then(
        () => ({ error: "" }),
        (error) => ({ error: String(error) }),
      );
      await expect
        .poll(() =>
          app.evaluate(() =>
            Boolean((globalThis as BrowserTestGlobal).__browserHeldInput?.downDelivered),
          ),
        )
        .toBe(true);
      await app.evaluate(({ webContents }, id) => {
        // This event is unrelated to the protocol-generated down event and represents
        // a person taking control while Chromium's dispatch response is still pending.
        webContents.fromId(id)!.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      }, guestId);
      await expect(pending).resolves.toMatchObject({
        error: expect.stringMatching(/interrupted/i),
      });
      expect(
        await app.evaluate(() => (globalThis as BrowserTestGlobal).__browserHeldInput?.releases),
      ).toBe(1);
    } finally {
      await app.evaluate(() => {
        const state = (globalThis as BrowserTestGlobal).__browserHeldInput;
        state?.release();
        state?.restore();
        delete (globalThis as BrowserTestGlobal).__browserHeldInput;
      });
      await command(page, { action: "close", tabId });
    }
  });
}

test("closing Picture in Picture during its first capture does not resume capture or leave stale state", async ({
  aiden,
}) => {
  const { page, app } = aiden;
  await finishLmStudioOnboarding(page);
  const opened = await command(page, { action: "create" });
  const tabId = opened.tabId!;
  const guestId = await blankGuestId(app);
  await app.evaluate(({ webContents }, id) => {
    const guest = webContents.fromId(id);
    if (!guest) throw new Error("Browser guest missing");
    const original = guest.capturePage.bind(guest);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state: HeldCapture = {
      captured: false,
      calls: 0,
      release,
      restore: () => {
        guest.capturePage = original;
      },
    };
    (globalThis as BrowserTestGlobal).__browserHeldCapture = state;
    guest.capturePage = async (...args) => {
      state.calls += 1;
      const value = await original(...args);
      if (!state.captured) {
        state.captured = true;
        await held;
      }
      return value;
    };
  }, guestId);
  try {
    const opening = command(page, { action: "picture_in_picture", tabId, enabled: true });
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean((globalThis as BrowserTestGlobal).__browserHeldCapture?.captured),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const pip = BrowserWindow.getAllWindows().find(
        (window) => window.getTitle() === "Browser Picture in Picture",
      );
      if (!pip) throw new Error("Picture in Picture window missing");
      pip.destroy();
      (globalThis as BrowserTestGlobal).__browserHeldCapture!.release();
    });
    const result = await opening;
    expect(result.state.tabs.find((tab) => tab.id === tabId)?.pictureInPicture).toBe(false);
    // The in-flight capture may retry a cold blank frame before it settles. Once
    // settled, a closed PiP must never resume the 250ms capture loop.
    const settledCaptures = await app.evaluate(
      () => (globalThis as BrowserTestGlobal).__browserHeldCapture!.calls,
    );
    await page.waitForTimeout(600);
    expect(
      await app.evaluate(() => (globalThis as BrowserTestGlobal).__browserHeldCapture?.calls),
    ).toBe(settledCaptures);
    const state = await page.evaluate(
      (workspaceId) =>
        (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
          "browser:get-state",
          workspaceId,
        ),
      E2E_WORKSPACE_ID,
    );
    expect(state.tabs.find((tab) => tab.id === tabId)?.pictureInPicture).toBe(false);
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some(
          (window) => window.getTitle() === "Browser Picture in Picture",
        ),
      ),
    ).toBe(false);
  } finally {
    await app.evaluate(() => {
      const state = (globalThis as BrowserTestGlobal).__browserHeldCapture;
      state?.release();
      state?.restore();
      delete (globalThis as BrowserTestGlobal).__browserHeldCapture;
    });
    await command(page, { action: "close", tabId });
  }
});
