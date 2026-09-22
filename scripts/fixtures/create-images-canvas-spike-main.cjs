/* global process, setTimeout */

const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");
const { inspectElectronConsoleMessage } = require("./electron-console-message.cjs");

app.commandLine.appendSwitch("enable-precise-memory-info");

const page = process.argv[2];
const screenshotPath = process.argv[3];
if (!page || !path.isAbsolute(page)) {
  process.stderr.write("Canvas spike requires an absolute fixture page path.\n");
  process.exitCode = 1;
  void app.quit();
} else {
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 650,
      useContentSize: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const rendererErrors = [];
    window.webContents.on("console-message", (...args) => {
      const entry = inspectElectronConsoleMessage(args);
      if (entry.isError) rendererErrors.push(entry.message);
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (url !== window.webContents.getURL()) event.preventDefault();
    });
    await window.loadFile(page);
    const deadline = Date.now() + 30_000;
    let result;
    while (Date.now() < deadline) {
      result = await window.webContents.executeJavaScript(
        "window.__AIDEN_CREATE_IMAGES_SPIKE__ ?? null",
        true,
      );
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (rendererErrors.length > 0) {
      process.stderr.write(`Canvas spike renderer errors:\n${rendererErrors.join("\n")}\n`);
      process.exitCode = 1;
    } else if (!result) {
      process.stderr.write("Canvas spike timed out.\n");
      process.exitCode = 1;
    } else {
      if (screenshotPath) {
        const screenshot = await window.webContents.capturePage();
        fs.writeFileSync(screenshotPath, screenshot.toPNG());
        const parsedScreenshotPath = path.parse(screenshotPath);
        for (const width of [700, 390]) {
          window.setContentSize(width, 650, false);
          await window.webContents.executeJavaScript(
            `(() => {
              const host = document.querySelector(".spike-host");
              if (host instanceof HTMLElement) host.style.width = "${width}px";
              return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            })()`,
            true,
          );
          const responsiveScreenshot = await window.webContents.capturePage();
          fs.writeFileSync(
            path.join(
              parsedScreenshotPath.dir,
              `${parsedScreenshotPath.name}-${width}${parsedScreenshotPath.ext}`,
            ),
            responsiveScreenshot.toPNG(),
          );
        }
      }
      process.stdout.write(`AIDEN_CREATE_IMAGES_SPIKE=${JSON.stringify(result)}\n`);
      if (result.error) process.exitCode = 1;
    }
    window.destroy();
    app.quit();
  });
}
