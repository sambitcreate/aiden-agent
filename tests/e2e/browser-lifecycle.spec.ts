import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
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
const command = (page: Page, input: BrowserCommand) =>
  page.evaluate(
    ({ id, input }) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserCommandResult>(
        "browser:command",
        id,
        input,
      ),
    { id: E2E_WORKSPACE_ID, input },
  );
const listenerAvailable = async (url: string) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};

test("renderer owner reload releases managed previews and scrubs echoed capability text", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const file = path.join(aiden.workspaceDir, "preview.html");
  await writeFile(file, "<!doctype html><title>Managed preview</title><p>Original document</p>");
  const opened = await command(page, { action: "open_file", path: "preview.html" });
  const tab = opened.state.tabs.find((tab) => tab.id === opened.tabId)!;
  expect(await listenerAvailable(tab.url)).toBe(true);
  const echoed = await command(page, {
    action: "evaluate",
    tabId: tab.id,
    expression:
      "(() => { const token=new URL(location.href).searchParams.get('__aiden_preview'); document.title=token; console.log(token); return {token,encoded:encodeURIComponent(location.href), keys:{[token]:true, '[private-preview]':false}}; })()",
  });
  expect(echoed.value).toMatchObject({ token: "[private-preview]" });
  // CDP may enumerate the original object's keys in either order. Redaction
  // must retain both entries with safe, distinct names regardless of that order.
  const redactedKeys = (echoed.value as { keys: Record<string, boolean> }).keys;
  expect(Object.keys(redactedKeys).sort()).toEqual(["[private-preview]", "[private-preview] (2)"]);
  expect(Object.values(redactedKeys).sort()).toEqual([false, true]);
  expect(JSON.stringify(echoed.value)).toContain("[private-preview]");
  const snapshot = await command(page, { action: "snapshot", tabId: tab.id, includeImage: false });
  expect(
    snapshot.snapshot?.diagnostics.some((entry) => entry.message.includes("[private-preview]")),
  ).toBe(true);
  await page.reload();
  await expect.poll(() => listenerAvailable(tab.url)).toBe(false);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  const state = await page.evaluate(
    (id) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
        "browser:get-state",
        id,
      ),
    E2E_WORKSPACE_ID,
  );
  expect(state.tabs).toHaveLength(0);
  expect(await readFile(file, "utf8")).toContain("Original document");
});

test("workspace access revocation closes managed listeners without removing source files", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  const file = path.join(aiden.workspaceDir, "preview.html");
  await writeFile(file, "<!doctype html><p>Permission fixture</p>");
  const opened = await command(page, { action: "open_file", path: "preview.html" });
  const tab = opened.state.tabs.find((tab) => tab.id === opened.tabId)!;
  await page.evaluate(
    (id) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke("workspaces:update", id, {
        permission: "none",
      }),
    E2E_WORKSPACE_ID,
  );
  await expect.poll(() => listenerAvailable(tab.url)).toBe(false);
  const state = await page.evaluate(
    (id) =>
      (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
        "browser:get-state",
        id,
      ),
    E2E_WORKSPACE_ID,
  );
  expect(state.tabs).toHaveLength(0);
  expect(await readFile(file, "utf8")).toContain("Permission fixture");
});

test("disabling agent access during file acquisition prevents a late browser tab", async ({
  aiden,
}) => {
  const { page, app, lmStudio } = aiden;
  await finishLmStudioOnboarding(page);
  const file = path.join(aiden.workspaceDir, "delayed-preview.html");
  await writeFile(file, "<!doctype html><p>Delayed preview</p>");
  await app.evaluate(async (_electron, target) => {
    const fileSystem = process.getBuiltinModule("fs").promises;
    const original = fileSystem.realpath;
    const canonicalTarget = await original(target);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = {
      reads: 0,
      entered: false,
      release,
      restore: () => {
        fileSystem.realpath = original;
        process.getBuiltinModule("module").syncBuiltinESMExports();
      },
    };
    Object.assign(globalThis, { __browserAcquisitionTest: state });
    Object.assign(fileSystem, {
      realpath: async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        // Preparation performs the first identity lookup. Hold the second lookup
        // inside the native service's actual lease acquisition, after tool admission.
        if ((String(args[0]) === target || String(args[0]) === canonicalTarget) && ++state.reads === 2) {
          state.entered = true;
          await gate;
        }
        return result;
      },
    });
    process.getBuiltinModule("module").syncBuiltinESMExports();
  }, file);
  try {
    const prompt = "Browser lifecycle scenario: open the delayed workspace document.";
    const scenario = lmStudio.enqueueToolScenario!({
      prompt,
      calls: [{ name: "browser", arguments: {} }, { name: "browser_open", arguments: { path: file, open: true } }],
      finalText: "Delayed preview request finished.",
    });
    await page.locator("textarea").first().fill(prompt);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { __browserAcquisitionTest?: { entered: boolean } })
              .__browserAcquisitionTest?.entered,
        ),
      )
      .toBe(true);
    await command(page, { action: "agent_access", access: "off" });
    await app.evaluate(() =>
      (
        globalThis as typeof globalThis & { __browserAcquisitionTest: { release(): void } }
      ).__browserAcquisitionTest.release(),
    );
    await expect(
      page.getByText("Delayed preview request finished.", { exact: true }).first(),
    ).toBeVisible({ timeout: 45_000 });
    expect(scenario.completed).toBe(true);
    expect(JSON.stringify(scenario.results)).toMatch(/revoked|disabled|closed/i);
    const state = await page.evaluate(
      (id) =>
        (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>(
          "browser:get-state",
          id,
        ),
      E2E_WORKSPACE_ID,
    );
    expect(state.tabs).toHaveLength(0);
    expect(await readFile(file, "utf8")).toContain("Delayed preview");
  } finally {
    await app.evaluate(() => {
      const testGlobal = globalThis as typeof globalThis & {
        __browserAcquisitionTest?: { release(): void; restore(): void };
      };
      testGlobal.__browserAcquisitionTest?.release();
      testGlobal.__browserAcquisitionTest?.restore();
      delete testGlobal.__browserAcquisitionTest;
    });
  }
});

test("replacing a workspace directory revokes its old preview before new file bytes are read", async ({
  aiden,
}) => {
  const { page } = aiden;
  await finishLmStudioOnboarding(page);
  await writeFile(
    path.join(aiden.workspaceDir, "preview.html"),
    "<!doctype html><p>Original identity</p>",
  );
  const opened = await command(page, { action: "open_file", path: "preview.html" });
  const tab = opened.state.tabs.find((tab) => tab.id === opened.tabId)!;
  const original = `${aiden.workspaceDir}-original`;
  await rename(aiden.workspaceDir, original);
  try {
    await mkdir(aiden.workspaceDir);
    await writeFile(
      path.join(aiden.workspaceDir, "preview.html"),
      "replacement must never be served",
    );
    const response = await command(page, {
      action: "evaluate",
      tabId: tab.id,
      expression:
        "fetch(location.href).then(async response => ({ status: response.status, text: await response.text() }))",
    });
    expect(response.value).toMatchObject({ status: 403 });
    expect(JSON.stringify(response.value)).not.toContain("replacement must never be served");
    await expect.poll(() => listenerAvailable(tab.url)).toBe(false);
  } finally {
    await rm(aiden.workspaceDir, { recursive: true, force: true });
    await rename(original, aiden.workspaceDir);
  }
});

type CrashRecoveryHarness = {
  crash(): number;
  unrelatedNavigation(): void;
  fire(index: number): number;
  reloads(): number;
  restore(): void;
};
type CrashRecoveryGlobal = typeof globalThis & { __browserCrashRecovery: CrashRecoveryHarness };

async function installCrashRecoveryHarness(aiden: { app: import("@playwright/test").ElectronApplication }, url: string) {
  await aiden.app.evaluate(({ webContents }, target) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(target));
    if (!guest) throw new Error("Browser guest missing");
    const originalReload = guest.reload.bind(guest);
    const callbacks: Array<() => void> = [];
    const handles: ReturnType<typeof setTimeout>[] = [];
    let reloads = 0;
    guest.reload = () => { reloads += 1; originalReload(); };
    const harness: CrashRecoveryHarness = {
      crash() {
        // Hold only timers registered synchronously by the real crash handler.
        // Firing even a cleared callback verifies the ownership fence as well.
        const schedule = globalThis.setTimeout;
        const isCrashed = guest.isCrashed;
        const isLoadingMainFrame = guest.isLoadingMainFrame;
        guest.isCrashed = () => true;
        guest.isLoadingMainFrame = () => false;
        globalThis.setTimeout = ((callback: () => void, delay: number) => {
          if (![300, 1000, 2000].includes(delay)) throw new Error(`Unexpected crash timer: ${delay}`);
          callbacks.push(callback);
          const handle = schedule(() => {}, 60_000);
          handles.push(handle);
          return handle;
        }) as typeof setTimeout;
        try { guest.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 }); }
        finally {
          globalThis.setTimeout = schedule;
          guest.isCrashed = isCrashed;
          guest.isLoadingMainFrame = isLoadingMainFrame;
        }
        return callbacks.length;
      },
      unrelatedNavigation() {
        guest.emit("did-start-navigation", {}, guest.getURL(), true, true);
        guest.emit("did-start-navigation", {}, guest.getURL(), false, false);
      },
      fire(index) { callbacks[index](); return reloads; },
      reloads: () => reloads,
      restore() {
        for (const handle of handles) clearTimeout(handle);
        if (!guest.isDestroyed()) guest.reload = originalReload;
      },
    };
    (globalThis as CrashRecoveryGlobal).__browserCrashRecovery = harness;
  }, url);
}

async function restoreCrashRecoveryHarness(aiden: { app: import("@playwright/test").ElectronApplication }) {
  await aiden.app.evaluate(() => (globalThis as CrashRecoveryGlobal).__browserCrashRecovery?.restore());
}

test("superseded browser crash recovery cannot reload a new page or override user control", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await writeFile(path.join(aiden.workspaceDir, "recovery.html"), "<!doctype html><title>Recovery fixture</title>");
  for (const action of ["navigate", "reload", "stop", "close"] as const) {
    const opened = await command(aiden.page, { action: "open_file", path: "recovery.html" });
    const tab = opened.state.tabs.find((candidate) => candidate.id === opened.tabId)!;
    await installCrashRecoveryHarness(aiden, tab.url);
    try {
      expect(await aiden.app.evaluate(() => (globalThis as CrashRecoveryGlobal).__browserCrashRecovery.crash())).toBe(1);
      const result = await command(aiden.page, action === "navigate"
        ? { action, tabId: tab.id, url: "about:blank" }
        : { action, tabId: tab.id });
      if (action === "stop") {
        expect(result.state.tabs.find((candidate) => candidate.id === tab.id)).toMatchObject({
          crashed: true, error: "The page crashed. Reload to recover.",
        });
      }
      const before = await aiden.app.evaluate(() => (globalThis as CrashRecoveryGlobal).__browserCrashRecovery.reloads());
      expect(await aiden.app.evaluate(() => (globalThis as CrashRecoveryGlobal).__browserCrashRecovery.fire(0)), action).toBe(before);
    } finally {
      await restoreCrashRecoveryHarness(aiden);
      if (action !== "close") await command(aiden.page, { action: "close", tabId: tab.id });
    }
  }
});

test("browser crash recovery has one current retry and respects the crash limit", async ({ aiden }) => {
  await finishLmStudioOnboarding(aiden.page);
  await writeFile(path.join(aiden.workspaceDir, "recovery.html"), "<!doctype html><title>Recovery fixture</title>");
  const opened = await command(aiden.page, { action: "open_file", path: "recovery.html" });
  const tab = opened.state.tabs.find((candidate) => candidate.id === opened.tabId)!;
  await installCrashRecoveryHarness(aiden, tab.url);
  try {
    const result = await aiden.app.evaluate(() => {
      const harness = (globalThis as CrashRecoveryGlobal).__browserCrashRecovery;
      harness.crash();
      harness.crash();
      const stale = harness.fire(0);
      harness.unrelatedNavigation();
      const current = harness.fire(1);
      const duplicate = harness.fire(1);
      harness.crash();
      const timersAtLimit = harness.crash();
      const exhausted = harness.fire(2);
      return { stale, current, duplicate, timersAtLimit, exhausted };
    });
    expect(result).toEqual({ stale: 0, current: 1, duplicate: 1, timersAtLimit: 3, exhausted: 1 });
  } finally {
    await restoreCrashRecoveryHarness(aiden);
  }
});

type NativeCrashEvent = { event: string; crashed: boolean; loading: boolean; osProcessId: number };
type NativeCrashProbe = {
  crash(): Promise<void>;
  deliver(): { crashed: boolean; loading: boolean; timers: number };
  fire(): number;
  events(): NativeCrashEvent[];
  restore(): void;
};
type NativeCrashGlobal = typeof globalThis & { __nativeCrashProbe: NativeCrashProbe };

async function installNativeCrashProbe(aiden: { app: import("@playwright/test").ElectronApplication }, target: string | number) {
  await aiden.app.evaluate(({ webContents }, target) => {
        const guest = typeof target === "number" ? webContents.fromId(target)! : webContents.getAllWebContents().find((contents) => contents.getURL() === target)!;
        const emit = guest.emit.bind(guest);
        const reload = guest.reload.bind(guest);
        const loadURL = guest.loadURL.bind(guest);
        let notification: (() => void) | undefined;
        let arrived: (() => void) | undefined;
        let reloads = 0;
        let firing = false;
        const events: NativeCrashEvent[] = [];
        const callbacks: Array<() => void> = [];
        const handles: ReturnType<typeof setTimeout>[] = [];
        guest.emit = ((event: string, ...args: unknown[]) => {
          if (["did-stop-loading", "render-process-gone"].includes(event)) {
            events.push({ event, crashed: guest.isCrashed(), loading: guest.isLoadingMainFrame(), osProcessId: guest.getOSProcessId() });
          }
          if (event !== "render-process-gone") return emit(event, ...args);
          notification = () => { emit(event, ...args); };
          arrived?.();
          return true;
        }) as typeof guest.emit;
        guest.reload = () => { reloads += 1; reload(); };
        guest.loadURL = (...args) => { if (firing) reloads += 1; return loadURL(...args); };
        (globalThis as NativeCrashGlobal).__nativeCrashProbe = {
          crash: () => new Promise<void>((resolve) => { arrived = resolve; guest.forcefullyCrashRenderer(); }),
          deliver() {
            const crashed = guest.isCrashed();
            const loading = guest.isLoadingMainFrame();
            const schedule = globalThis.setTimeout;
            globalThis.setTimeout = ((callback: () => void, delay: number) => {
              if (![300, 1000, 2000].includes(delay)) throw new Error(`Unexpected crash timer: ${delay}`);
              callbacks.push(callback);
              const handle = schedule(() => {}, 60_000);
              handles.push(handle);
              return handle;
            }) as typeof setTimeout;
            try { notification!(); notification = undefined; }
            finally { globalThis.setTimeout = schedule; }
            return { crashed, loading, timers: callbacks.length };
          },
          events: () => events,
          fire() {
            firing = true;
            try { for (const callback of callbacks.splice(0)) callback(); }
            finally { firing = false; }
            return reloads;
          },
          restore() {
            for (const handle of handles) clearTimeout(handle);
            if (!guest.isDestroyed()) { guest.emit = emit; guest.reload = reload; guest.loadURL = loadURL; }
          },
        };
  }, target);
}

for (const delivery of ["pending", "committed"] as const) {
  test(`queued native crash after ${delivery} replacement navigation cannot schedule a stale reload`, async ({ aiden }) => {
    let releaseNext: (() => void) | undefined;
    let nextRequests = 0;
    let stallResource = true;
    const server = createServer((request, response) => {
      if (request.url === "/resource" && stallResource) return;
      if (request.url === "/loading") {
        response.setHeader("content-type", "text/html");
        response.end('<!doctype html><title>Loading document</title><img src="/resource">');
        return;
      }
      const reply = () => response.end(`<!doctype html><title>${request.url === "/next" ? "Next document" : "Original document"}</title>`);
      response.setHeader("content-type", "text/html");
      if (request.url === "/next" && nextRequests++ === 0) releaseNext = reply;
      else reply();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await finishLmStudioOnboarding(aiden.page);
      const opened = await command(aiden.page, { action: "create", url: `${url}/start` });
      const tabId = opened.tabId!;
      await expect.poll(async () => (await command(aiden.page, { action: "snapshot", tabId, includeImage: false })).state.tabs.find((tab) => tab.id === tabId)?.title).toBe("Original document");
      await installNativeCrashProbe(aiden, `${url}/start`);
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      await command(aiden.page, { action: "navigate", tabId, url: `${url}/next`, readiness: "none" });
      await expect.poll(() => Boolean(releaseNext)).toBe(true);
      if (delivery === "committed") {
        releaseNext!();
        await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().find((contents) => contents.getURL() === target)?.getTitle(), `${url}/next`)).toBe("Next document");
      }
      const late = await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver());
      expect(late, `Native state at ${delivery} delivery`).toMatchObject({ loading: delivery === "pending", timers: 0 });
      if (delivery === "pending") releaseNext!();
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().find((contents) => contents.getURL() === target)?.getTitle(), `${url}/next`)).toBe("Next document");
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.fire())).toBe(0);
      // Also cover a genuine crash after commit while subresources still load.
      const currentUrl = delivery === "committed" ? `${url}/loading` : `${url}/next`;
      const currentTitle = delivery === "committed" ? "Loading document" : "Next document";
      if (delivery === "committed") {
        await command(aiden.page, { action: "navigate", tabId, url: currentUrl, readiness: "none" });
        await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => {
          const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target);
          return guest?.isLoadingMainFrame() && guest.getTitle();
        }, currentUrl)).toBe(currentTitle);
      }
      // A fresh crash of the current document still owns one working retry.
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver())).toEqual({ crashed: true, loading: false, timers: 1 });
      stallResource = false;
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.fire())).toBe(1);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === target);
        return guest && !guest.isCrashed() && !guest.isLoadingMainFrame() && guest.getTitle();
      }, currentUrl)).toBe(currentTitle);
    } finally {
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe?.restore());
      releaseNext?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

for (const boundary of ["ordinary", "global-stop", "same-url-replacement"]) {
  test(`current native crash during a subsequent held main-frame response still recovers${boundary === "global-stop" ? " after an unrelated global stop" : boundary === "same-url-replacement" ? " after a same-URL replacement" : ""}`, async ({ aiden }) => {
    let heldRequests = 0;
    let hold = true;
    const server = createServer((request, response) => {
      if (request.url === "/held" && hold) { heldRequests += 1; return; }
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Recovered document</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await finishLmStudioOnboarding(aiden.page);
      const ids = await aiden.app.evaluate(({ webContents }) => webContents.getAllWebContents().map((contents) => contents.id));
      // Finish Playwright attachment before intentionally crashing the guest.
      const windowCount = aiden.app.windows().length;
      const opened = await command(aiden.page, { action: "create", url: `${url}/start` });
      await expect.poll(() => aiden.app.windows().length).toBe(windowCount + 1);
      const id = await aiden.app.evaluate(({ webContents }, previous) => webContents.getAllWebContents().find((contents) => !previous.includes(contents.id))!.id, ids);
      await installNativeCrashProbe(aiden, id);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getTitle(), id)).toBe("Recovered document");
      await command(aiden.page, { action: "navigate", tabId: opened.tabId!, url: `${url}/held`, readiness: "none" });
      await expect.poll(() => heldRequests).toBe(1);
      if (boundary === "same-url-replacement") {
        // Cancel the first request with another navigation to the same URL.
        // The old request error cannot abandon the new navigation's target.
        await command(aiden.page, { action: "navigate", tabId: opened.tabId!, url: `${url}/held`, readiness: "none" });
        await expect.poll(() => heldRequests).toBe(2);
      }
      if (boundary === "global-stop") {
        // Exercise Chromium's documented racy frame-tree stop boundary with a
        // real uncommitted main-frame request and live renderer. Only the global
        // notification/loading snapshot is controlled; the subsequent crash and
        // recovery HTTP request are native.
        await aiden.app.evaluate(({ webContents }, target) => {
          const guest = webContents.fromId(target)!;
          if (guest.isCrashed() || guest.getOSProcessId() === 0) throw new Error("Expected a live committed renderer");
          const isLoadingMainFrame = guest.isLoadingMainFrame;
          guest.isLoadingMainFrame = () => false;
          try { guest.emit("did-stop-loading"); }
          finally { guest.isLoadingMainFrame = isLoadingMainFrame; }
        }, id);
      }
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      const crash = await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver());
      expect(crash).toMatchObject({ crashed: true, timers: 1 });
      const nativeEvents = await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.events());
      expect(nativeEvents.some((event) => event.event === "did-stop-loading" && event.osProcessId === 0)).toBe(true);
      await test.info().attach("native-crash-event-order", { body: JSON.stringify(nativeEvents, null, 2), contentType: "application/json" });

      const state = await aiden.page.evaluate((workspaceId) =>
        (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>("browser:get-state", workspaceId), E2E_WORKSPACE_ID);
      expect(state.tabs.find((tab) => tab.id === opened.tabId)).toMatchObject({ crashed: true, loading: false, error: "The page crashed. Restoring it…" });
      hold = false;
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.fire())).toBe(1);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => {
        const guest = webContents.fromId(target);
        return guest && { crashed: guest.isCrashed(), loading: guest.isLoadingMainFrame(), title: guest.getTitle(), url: guest.getURL() };
      }, id)).toEqual({ crashed: false, loading: false, title: "Recovered document", url: `${url}/held` });
      expect(await aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getURL(), id)).toBe(`${url}/held`);
    } finally {
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe?.restore());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

for (const scenario of ["queued-before-abort", "queued-before-network-error", "queued-after-abort", "queued-after-network-error", "current-after-abort", "current-after-reset", "current-after-stop"] as const) {
  test(`native crash ${scenario} preserves the correct recovery document`, async ({ aiden }) => {
    let releaseFailure: (() => void) | undefined;
    let failing = false;
    let originalRequests = 0;
    let replacementRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/replacement") {
        replacementRequests += 1;
        const fail = () => {
          failing = true;
          if (scenario.endsWith("network-error")) response.destroy();
          else { response.writeHead(scenario === "current-after-reset" ? 205 : 204); response.end(); }
        };
        if (failing) fail();
        else releaseFailure = fail;
        return;
      }
      if (request.url === "/original") originalRequests += 1;
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Original page</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await finishLmStudioOnboarding(aiden.page);
      const opened = await command(aiden.page, { action: "create", url: `${url}/original` });
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some((contents) => contents.getURL() === target), `${url}/original`)).toBe(true);
      const id = await aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().find((contents) => contents.getURL() === target)!.id, `${url}/original`);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getTitle(), id)).toBe("Original page");
      await installNativeCrashProbe(aiden, id);
      await aiden.app.evaluate(({ webContents }, target) => {
        const guest = webContents.fromId(target)!;
        const events: string[] = [];
        guest.on("did-stop-loading", () => events.push("did-stop-loading"));
        guest.on("did-fail-load", (_event, _code, _description, _url, main) => { if (main) events.push("did-fail-load"); });
        Object.assign(globalThis, { __failedReplacement: events });
      }, id);
      const laterCrash = scenario.startsWith("current-");
      if (!laterCrash) await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      await command(aiden.page, { action: "navigate", tabId: opened.tabId!, url: `${url}/replacement`, readiness: "none" });
      await expect.poll(() => Boolean(releaseFailure)).toBe(true);
      if (scenario === "current-after-stop") await command(aiden.page, { action: "stop", tabId: opened.tabId! });
      if (scenario.startsWith("queued-before-")) {
        expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver())).toMatchObject({ loading: true, timers: 0 });
      }
      releaseFailure!();
      await expect.poll(() => aiden.app.evaluate(() => (globalThis as typeof globalThis & { __failedReplacement: string[] }).__failedReplacement.includes("did-stop-loading"))).toBe(true);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.isLoadingMainFrame(), id)).toBe(false);
      // Native terminal navigation recreates a live renderer even when no normal
      // document commits (204), or commits an error page (connection reset).
      expect(await aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.isCrashed(), id)).toBe(false);
      const terminalEvents = await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.events());
      expect(terminalEvents.some((event) => event.event === "did-stop-loading" && !event.crashed && !event.loading && event.osProcessId > 0)).toBe(true);
      if (laterCrash) {
        expect(await aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getURL(), id)).toBe(`${url}/original`);
        await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      } else if (scenario.endsWith("network-error")) {
        expect(await aiden.app.evaluate(() => (globalThis as typeof globalThis & { __failedReplacement: string[] }).__failedReplacement.includes("did-fail-load"))).toBe(true);
      }
      if (!scenario.startsWith("queued-before-")) {
        expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver())).toEqual({ crashed: laterCrash, loading: false, timers: laterCrash ? 1 : 0 });
      }
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.fire())).toBe(laterCrash ? 1 : 0);
      if (laterCrash) {
        await expect.poll(() => originalRequests === 2 || replacementRequests === 2).toBe(true);
        expect({ originalRequests, replacementRequests }).toEqual({ originalRequests: 2, replacementRequests: 1 });
        await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => {
          const guest = webContents.fromId(target);
          return guest && { crashed: guest.isCrashed(), url: guest.getURL(), title: guest.getTitle() };
        }, id)).toEqual({ crashed: false, url: `${url}/original`, title: "Original page" });
      } else expect(originalRequests).toBe(1);
    } finally {
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe?.restore());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

for (const abort of ["timeout", "expired-preview"] as const) {
  test(`local ${abort} before request callbacks abandons its crash recovery target`, async ({ aiden }) => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.end("<!doctype html><title>Original local-abort document</title>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/original`;
    try {
      await finishLmStudioOnboarding(aiden.page);
      const opened = await command(aiden.page, { action: "create", url });
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some((contents) => contents.getURL() === target), url)).toBe(true);
      const id = await aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().find((contents) => contents.getURL() === target)!.id, url);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getTitle(), id)).toBe("Original local-abort document");
      await installNativeCrashProbe(aiden, id);
      if (abort === "expired-preview") {
        await writeFile(path.join(aiden.workspaceDir, "abort-preview.html"), "<!doctype html><title>Expiring preview</title>");
        const preview = await command(aiden.page, { action: "open_file", path: "abort-preview.html" });
        const target = preview.state.tabs.find((tab) => tab.id === preview.tabId)!.url;
        await command(aiden.page, { action: "close", tabId: preview.tabId! });
        // Drive the real local preview-admission failure before any request exists.
        await aiden.app.evaluate(({ webContents }, { id, target }) => {
          webContents.fromId(id)!.emit("did-start-navigation", {}, target, false, true);
        }, { id, target });
        const state = await aiden.page.evaluate((workspaceId) => (window as unknown as BrowserTestWindow).aidenAPI.ipc.invoke<BrowserState>("browser:get-state", workspaceId), E2E_WORKSPACE_ID);
        expect(state.tabs.find((tab) => tab.id === opened.tabId)?.error).toContain("preview expired");
      } else {
        // Hold native request admission at the documented pre-request boundary.
        // The real command deadline and local stop run without a request-error
        // callback to clean up on their behalf.
        await aiden.app.evaluate(({ webContents }, target) => {
          const guest = webContents.fromId(target)!;
          const loadURL = guest.loadURL;
          guest.loadURL = (pendingUrl) => {
            guest.loadURL = loadURL;
            guest.emit("did-start-navigation", {}, pendingUrl, false, true);
            return new Promise<void>(() => {});
          };
        }, id);
        await expect(command(aiden.page, { action: "navigate", tabId: opened.tabId!, url: `${url}/abandoned`, timeoutMs: 25 })).rejects.toThrow(/Browser action timed out/);
      }
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.crash());
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.deliver())).toMatchObject({ crashed: true, timers: 1 });
      expect(await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe.fire())).toBe(1);
      await expect.poll(() => aiden.app.evaluate(({ webContents }, target) => {
        const guest = webContents.fromId(target)!;
        return !guest.isCrashed() && !guest.isLoadingMainFrame() && guest.getURL();
      }, id)).toBe(url);
      expect(requests).toBeGreaterThanOrEqual(2);
    } finally {
      await aiden.app.evaluate(() => (globalThis as NativeCrashGlobal).__nativeCrashProbe?.restore());
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
