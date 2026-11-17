import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { E2E_PROFILE_NAME, E2E_WORKSPACE_ID, expect, connectOnboardingLmStudio, test } from "./fixtures";

// E2E has no project key, so nothing can reach PostHog. AIDEN_ANALYTICS_DEBUG
// routes every message through the same outgoing guard into the dev log, which
// is what these checks read. Sending, consent, sanitizing and the pending-crash
// file are the real code paths in a real Electron app.

const SECRET = "my landlord refuses to fix the mould";

async function debugLines(userDataDir: string): Promise<string[]> {
  const directory = path.join(userDataDir, "logs");
  const files = existsSync(directory) ? await readdir(directory) : [];
  const contents = await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8").catch(() => "")));
  // The log is JSON lines, so the debug text is a field of each line.
  return contents
    .join("\n")
    .split("\n")
    .filter((line) => line.includes("[analytics debug]"))
    .map((line) => {
      try {
        return String((JSON.parse(line) as { fields?: { message?: unknown } }).fields?.message ?? line);
      } catch {
        return line;
      }
    });
}

test.describe("crash reports", () => {
  test.use({
    portableConfigSeed: "empty",
    workspaceSeed: true,
    // Set explicitly: CI jobs that launch the app turn analytics off in their environment.
    appEnvironment: { AIDEN_ANALYTICS_DEBUG: "1", AIDEN_ANALYTICS: "1", DO_NOT_TRACK: "0" },
  });

  test("uncaught errors, process deaths and a fatal main crash are reported, sanitized, across a relaunch", async ({ aiden }) => {
    const pendingFile = path.join(aiden.userDataDir, "analytics-pending-crash.json");
    const lines = () => debugLines(aiden.userDataDir);
    const reportsMatching = async (pattern: RegExp) => (await lines()).filter((line) => pattern.test(line)).length;

    // Nothing is reported until onboarding has shown the usage data row.
    const onboarding = aiden.page.locator('section[aria-label="Set up Aiden"]');
    await expect(onboarding).toBeVisible();
    await aiden.page.evaluate(() => {
      setTimeout(() => {
        throw new Error("before the notice");
      });
    });
    await onboarding.getByPlaceholder("Your name").fill(E2E_PROFILE_NAME);
    await onboarding.getByRole("button", { name: /^Next/u }).click();
    await connectOnboardingLmStudio(onboarding);
    await onboarding.getByRole("button", { name: "Start using Aiden" }).click();
    await expect(onboarding).toBeHidden();
    await expect.poll(() => reportsMatching(/app_opened/u)).toBe(1);
    expect(await reportsMatching(/\$exception/u)).toBe(0);

    // A renderer error: raw fields cross the IPC boundary and are sanitized in main.
    await aiden.page.evaluate((secret) => {
      setTimeout(() => {
        throw new Error(`${secret} at /Users/jane/private/notes.md`);
      });
    }, SECRET);
    await expect.poll(() => reportsMatching(/\$exception.*"source":"renderer"/u)).toBe(1);

    // A rejection takes the same path.
    await aiden.page.evaluate((secret) => {
      void Promise.reject(new Error(secret));
    }, SECRET);
    await expect.poll(() => reportsMatching(/\$exception.*"origin":"unhandled_rejection"/u)).toBe(1);

    // A main-process rejection: Electron keeps running, so it is an error, not a fatal.
    await aiden.app.evaluate((_electron, secret) => {
      void Promise.reject(new Error(secret));
    }, SECRET);
    await expect.poll(() => reportsMatching(/\$exception.*"source":"main".*"origin":"unhandled_rejection"|\$exception.*"origin":"unhandled_rejection".*"source":"main"/u)).toBe(1);
    expect(existsSync(pendingFile)).toBe(false);

    // A browser tab's renderer dies: reported once, and the page still recovers.
    const server = createServer((_request, response) => response.end("<!doctype html><title>Crash target</title>"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const tabIsLive = () => aiden.app.evaluate(({ webContents }, target) => webContents.getAllWebContents().some((guest) => guest.getURL() === target && !guest.isCrashed() && guest.getTitle() === "Crash target"), url);
    try {
      await aiden.page.evaluate(({ id, url }) => (window as unknown as { aidenAPI: { ipc: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } } }).aidenAPI.ipc.invoke("browser:command", id, { action: "create", url }), { id: E2E_WORKSPACE_ID, url });
      await expect.poll(tabIsLive).toBe(true);
      await aiden.app.evaluate(({ webContents }, target) => {
        webContents.getAllWebContents().find((guest) => guest.getURL() === target)!.forcefullyCrashRenderer();
      }, url);
      await expect.poll(() => reportsMatching(/app_crashed.*"kind":"browser_tab"/u)).toBe(1);
      await expect.poll(tabIsLive).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // The main renderer dies: no stack exists, only the categorical event.
    await aiden.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible())?.webContents.forcefullyCrashRenderer();
    });
    await expect.poll(() => reportsMatching(/app_crashed.*"kind":"renderer"/u)).toBe(1);

    // A fatal main-process exception whose process does not survive: the
    // crash happens in the same tick, right after Aiden's own monitor ran.
    await aiden.app.evaluate((_electron, secret) => {
      process.on("uncaughtExceptionMonitor", () => process.crash());
      setTimeout(() => {
        throw new TypeError(secret);
      });
    }, SECRET).catch(() => undefined);
    await expect.poll(() => existsSync(pendingFile)).toBe(true);
    const record = await readFile(pendingFile, "utf8");
    expect(record).not.toContain("landlord");
    expect(record).toContain("[message withheld]");

    await aiden.relaunch();

    await expect.poll(() => reportsMatching(/\$exception.*"origin":"pending_crash"/u)).toBe(1);
    await expect.poll(() => existsSync(pendingFile)).toBe(false);
    await expect.poll(() => reportsMatching(/app_opened.*"launch_kind":"after_crash"/u)).toBe(1);
    expect(await reportsMatching(/unclean_exit/u)).toBe(0);

    const everything = (await lines()).join("\n");
    for (const leak of ["landlord", "mould", "jane", "notes.md"]) expect(everything).not.toContain(leak);
  });
});
