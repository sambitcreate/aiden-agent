import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, type WebContentsView } from "electron";
import type { BrowserTab } from "../../renderer/shared/browser";

// Run without a debugger attached: Playwright cannot initialize a guest target
// that crashes before its first document commits.
const root = process.env.AIDEN_BROWSER_CRASH_ROOT!;
await mkdir(path.join(root, "user-data"), { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
void app
  .whenReady()
  .then(async () => {
    const { BrowserService } =
      await import("../../main/services/browser/service");
    const browser = new BrowserService();
    const owner = new BrowserWindow({ show: false });
    browser.attachOwner("initial-crash", {
      id: owner.webContents.id,
      documentId: "native-crash-test",
      isDestroyed: () => owner.isDestroyed(),
      send: () => {},
      onInvalidated: () => () => {},
    });
    let requests = 0;
    let releaseRequest!: () => void;
    const requested = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const server = createServer((request, response) => {
      if (request.url !== "/first") {
        response.writeHead(204);
        response.end();
        return;
      }
      requests += 1;
      if (requests === 1) {
        releaseRequest();
        return;
      }
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Recovered first document</title>");
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let exitCode = 0;
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/first`;
      // The public command path is covered by the regular app E2E. This focused
      // native entry isolates creation/lifecycle without starting unrelated services.
      const tab = await (
        browser as unknown as {
          create(
            workspaceId: string,
            url: string,
            profileId?: string,
            show?: boolean,
          ): Promise<{ state: BrowserTab; view: WebContentsView }>;
        }
      ).create("initial-crash", url, undefined, false);
      const guest = tab.view.webContents;
      await requested;
      assert.equal(guest.getURL(), "");
      assert.equal(guest.navigationHistory.getAllEntries().length, 0);
      const crashed = new Promise<void>((resolve) =>
        guest.once("render-process-gone", () => resolve()),
      );
      guest.forcefullyCrashRenderer();
      await crashed;
      const before = {
        nativeCrashed: guest.isCrashed(),
        nativeLoading: guest.isLoadingMainFrame(),
        crashed: browser.getState("initial-crash").tabs[0].crashed,
        loading: browser.getState("initial-crash").tabs[0].loading,
      };
      assert.deepEqual(before, {
        nativeCrashed: true,
        nativeLoading: true,
        crashed: true,
        loading: false,
      });
      await Promise.race([
        new Promise<void>((resolve) => {
          const stopped = () => {
            if (
              guest.getURL() !== url ||
              guest.isCrashed() ||
              guest.isLoadingMainFrame()
            )
              return;
            guest.removeListener("did-stop-loading", stopped);
            resolve();
          };
          guest.on("did-stop-loading", stopped);
        }),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Initial crash recovery did not finish")),
            10_000,
          );
        }),
      ]);
      assert.equal(guest.getURL(), url);
      assert.equal(guest.getTitle(), "Recovered first document");
      assert.equal(guest.isCrashed(), false);
      assert.equal(guest.isLoadingMainFrame(), false);
      assert.equal(requests, 2);
      const recovered = browser.getState("initial-crash").tabs[0];
      assert.equal(recovered.crashed, false);
      assert.equal(recovered.loading, false);
      await writeFile(
        path.join(root, "result.json"),
        JSON.stringify({ before, requests, url: guest.getURL() }),
      );
    } catch (error) {
      console.error(error);
      exitCode = 1;
    } finally {
      if (deadline) clearTimeout(deadline);
      await browser.shutdown();
      owner.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      app.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
