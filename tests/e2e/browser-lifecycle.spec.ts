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
