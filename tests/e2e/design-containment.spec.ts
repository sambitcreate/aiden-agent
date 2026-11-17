import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chooseWorkspace,
  designCanvas,
  sendFirstMessage,
  setDisplayWidth,
  setWindowWidth,
  typeSlashCommand,
  WORKSPACE_NAME,
} from "./design-mode-helpers";
import {
  expect,
  finishLmStudioOnboarding,
  test,
  waitForToastsToClear,
} from "./fixtures";

test.use({
  workspaceSeed: true,
});

/**
 * A workspace page that tries every way out it can: a fetch, an image, a form
 * post, a popup, navigating the app's window and a nested page. It writes what
 * happened, and every policy violation it saw, to its body for the test to read.
 */
const PROBE = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Probe</title></head>
  <body>
    <h1>Containment probe</h1>
    <form id="post" method="post" action="https://example.com/form"><input name="q" value="1" /></form>
    <script>
      const result = { violations: [], fetch: "pending", popup: "pending" };
      document.addEventListener("securitypolicyviolation", (event) => {
        result.violations.push(event.effectiveDirective);
      });
      (async () => {
        try {
          await fetch("https://example.com/fetch");
          result.fetch = "loaded";
        } catch {
          result.fetch = "blocked";
        }
        new Image().src = "https://example.com/pixel.png";
        try { document.getElementById("post").submit(); } catch {}
        try {
          result.popup = window.open("https://example.com/popup") === null ? "blocked" : "opened";
        } catch {
          result.popup = "blocked";
        }
        try { top.location = "https://example.com/top"; } catch {}
        const nested = document.createElement("iframe");
        nested.src = "https://example.com/nested";
        document.body.append(nested);
        setTimeout(() => { document.body.dataset.probe = JSON.stringify(result); }, 1000);
      })();
    </script>
  </body>
</html>
`;

type SeenRequest = { url: string; frameUrl: string | null };

test("a workspace page on the design canvas cannot reach the network or the app's window", async ({
  aiden,
}) => {
  const { app, page, workspaceDir } = aiden;
  const probe = path.join(workspaceDir, "design", "probe.html");
  await mkdir(path.dirname(probe), { recursive: true });
  await writeFile(probe, PROBE);

  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, "Check the probe page");
  await typeSlashCommand(page, "/design");
  await expect(
    designCanvas(page).getByText(
      "Ask Aiden to design something, or add a note.",
    ),
  ).toBeVisible();

  const windowUrl = page.url();
  const windowCount = await app.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
  );

  // Every request the app's session makes from here on is recorded; any to
  // example.com is also cancelled, so a failure never reaches the internet.
  await app.evaluate(({ session }) => {
    const seen: SeenRequest[] = [];
    (globalThis as { __designRequests?: SeenRequest[] }).__designRequests =
      seen;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let frameUrl: string | null = null;
      try {
        frameUrl = details.frame?.url ?? null;
      } catch {
        frameUrl = null;
      }
      seen.push({ url: details.url, frameUrl });
      callback({
        cancel: /^[a-z]+:\/\/([^/]*\.)?example\.com/iu.test(details.url),
      });
    });
  });

  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [chosen],
    })) as unknown as typeof dialog.showOpenDialog;
  }, probe);
  await designCanvas(page).getByRole("button", { name: "Add" }).click();
  const fileItem = page.getByRole("menuitem", { name: "File…" });
  await expect(fileItem).toBeEnabled();
  await fileItem.click();

  const body = designCanvas(page)
    .frameLocator('iframe[title="probe.html"]')
    .locator("body");
  await expect(
    body.getByRole("heading", { name: "Containment probe" }),
  ).toBeVisible();
  await expect(body).toHaveAttribute("data-probe", /.+/u, { timeout: 10_000 });
  const result = JSON.parse((await body.getAttribute("data-probe"))!) as {
    violations: string[];
    fetch: string;
    popup: string;
  };

  // The page's own policy stopped each attempt, and said so.
  expect(result.fetch).toBe("blocked");
  expect(result.popup).toBe("blocked");
  expect(result.violations).toEqual(
    expect.arrayContaining(["connect-src", "img-src", "frame-src"]),
  );

  // Nothing left the app: no request to example.com, and nothing at all from the
  // page except its own aiden-design files.
  const seen = await app.evaluate(
    () =>
      (globalThis as { __designRequests?: SeenRequest[] }).__designRequests ??
      [],
  );
  expect(seen.filter((request) => /example\.com/iu.test(request.url))).toEqual(
    [],
  );
  expect(
    seen.filter(
      (request) =>
        request.frameUrl?.startsWith("aiden-design:") &&
        !request.url.startsWith("aiden-design:"),
    ),
  ).toEqual([]);

  // The app's window stayed where it was, and no window opened.
  expect(page.url()).toBe(windowUrl);
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) =>
        window.webContents.getURL(),
      ),
    ),
  ).toContain(windowUrl);
  expect(
    await app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    ),
  ).toBe(windowCount);
  await expect(designCanvas(page)).toBeVisible();
});

/**
 * A workspace page that tries to send its own frame to another page the app's
 * window would let a frame show: a page under another grant, then a generated
 * UI page. Either would leave a page that is not this workspace page holding
 * the frame's window, and so able to post the canvas's frame messages. (The
 * web is already out of reach: the window's own policy refuses it.) The page
 * marks its body once it has had time to leave, so only a page that stayed
 * can say so.
 */
const WANDERER = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Wanderer</title></head>
  <body>
    <h1>Navigation probe</h1>
    <script>
      setTimeout(() => { location.href = "aiden-design://another-grant/design/elsewhere.html"; }, 200);
      setTimeout(() => { location.href = "aiden-genui://artifact/page.html"; }, 600);
      setTimeout(() => { document.body.dataset.stayed = "1"; }, 1500);
    </script>
  </body>
</html>
`;

test("a workspace page on the design canvas cannot navigate its own frame away", async ({
  aiden,
}) => {
  const { app, page, workspaceDir } = aiden;
  const wanderer = path.join(workspaceDir, "design", "wanderer.html");
  await mkdir(path.dirname(wanderer), { recursive: true });
  await writeFile(wanderer, WANDERER);

  await finishLmStudioOnboarding(page);
  await waitForToastsToClear(page);
  await setDisplayWidth(app, 1440);
  await setWindowWidth(app, page, 1440);
  await chooseWorkspace(page, new RegExp(`^${WORKSPACE_NAME}`, "u"));
  await sendFirstMessage(page, "Check the wandering page");
  await typeSlashCommand(page, "/design");
  await expect(
    designCanvas(page).getByText(
      "Ask Aiden to design something, or add a note.",
    ),
  ).toBeVisible();

  // Any request to example.com is recorded and cancelled, so nothing reaches the internet.
  await app.evaluate(({ session }) => {
    const seen: string[] = [];
    (globalThis as { __wandererRequests?: string[] }).__wandererRequests = seen;
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const outside = /^[a-z]+:\/\/([^/]*\.)?example\.com/iu.test(details.url);
      if (outside) seen.push(details.url);
      callback({ cancel: outside });
    });
  });
  await app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [chosen],
    })) as unknown as typeof dialog.showOpenDialog;
  }, wanderer);
  await designCanvas(page).getByRole("button", { name: "Add" }).click();
  const fileItem = page.getByRole("menuitem", { name: "File…" });
  await expect(fileItem).toBeEnabled();
  await fileItem.click();

  const body = designCanvas(page)
    .frameLocator('iframe[title="wanderer.html"]')
    .locator("body");
  await expect(body.getByRole("heading", { name: "Navigation probe" })).toBeVisible();
  // Both attempts were stopped before they left: the page is still there to mark itself.
  await expect(body).toHaveAttribute("data-stayed", "1", { timeout: 10_000 });
  const frameUrls = page
    .frames()
    .map((frame) => frame.url())
    .filter((url) => /wanderer\.html|example\.com/u.test(url));
  expect(frameUrls.length).toBeGreaterThan(0);
  expect(frameUrls.every((url) => url.startsWith("aiden-design:"))).toBe(true);
  expect(
    await app.evaluate(
      () => (globalThis as { __wandererRequests?: string[] }).__wandererRequests ?? [],
    ),
  ).toEqual([]);
});
