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
  appEnvironment: { AIDEN_EXPERIMENTAL_DESIGN_MODE: "1" },
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
