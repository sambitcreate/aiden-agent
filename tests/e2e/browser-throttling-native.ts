import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, type WebContentsView } from "electron";
import type { BrowserTab, BrowserImage } from "../../renderer/shared/browser";
import type { BrowserBackgroundThrottling } from "../../main/services/browser/background-throttling";

const root = process.env.AIDEN_BROWSER_THROTTLING_ROOT!;
await mkdir(path.join(root, "user-data"), { recursive: true });
app.setPath("userData", path.join(root, "user-data"));
const deadline = setTimeout(() => app.exit(2), 45_000);
void app.whenReady().then(async () => {
  const { BrowserService } = await import("../../main/services/browser/service");
  const { configStore } = await import("../../main/services/config-store");
  // Isolate native scheduling from workspace persistence/admission, covered elsewhere.
  configStore.getWorkspace = async () => ({ id: "throttle" }) as Awaited<ReturnType<typeof configStore.getWorkspace>>;
  const browser = new BrowserService();
  const owner = new BrowserWindow({ show: false });
  browser.attachOwner("throttle", {
    id: owner.webContents.id, documentId: "native-throttle-test",
    isDestroyed: () => owner.isDestroyed(), send: () => {}, onInvalidated: () => () => {},
  });
  type Tab = { state: BrowserTab; view: WebContentsView; initialLoad: Promise<void>; backgroundThrottling: BrowserBackgroundThrottling; recording?: { recorder: BrowserWindow } };
  const native = browser as unknown as {
    create(workspace: string, url: string, profile: undefined, show: boolean): Promise<Tab>;
    capture(tab: Tab): Promise<BrowserImage>;
    close(tab: Tab): void;
    present(tab: Tab, visible: boolean, bounds?: { x: number; y: number; width: number; height: number }): void;
    startRecording(tab: Tab, fps: number, signal?: AbortSignal): Promise<void>;
    stopRecording(tab: Tab): Promise<{ sizeBytes: number }>;
  };
  // about:blank avoids external network and permits the existing URL policy.
  const tab = await native.create("throttle", "about:blank", undefined, false);
  const wc = tab.view.webContents;
  await tab.initialLoad;
  const idlePolicy = wc.getBackgroundThrottling();
  assert.equal(idlePolicy, true, "an ordinary hidden guest must use normal scheduling");
  owner.show();
  native.present(tab, true, { x: 0, y: 0, width: 600, height: 400 });
  await wc.executeJavaScript("document.body.style.background = 'rgb(30, 90, 160)'; document.body.textContent = 'Local scheduling fixture'");
  const screenshot = await native.capture(tab);
  native.present(tab, false);
  assert.ok(screenshot.data.length > 0);
  assert.equal(wc.getBackgroundThrottling(), true, "capture must restore the idle policy");
  const hiddenScreenshot = await native.capture(tab);
  assert.ok(hiddenScreenshot.data.length > 0);
  assert.equal(wc.getBackgroundThrottling(), true);
  const command = (expression: string, signal?: AbortSignal) => browser.command("throttle", {
    action: "evaluate", tabId: tab.state.id, expression,
  }, { source: "user", signal });
  console.error("[throttling] awaiting hidden timer");
  const value = await command("new Promise(resolve => setTimeout(() => resolve('timer'), 10))");
  assert.equal(value.value, "timer", "hidden automation must receive timer callbacks");
  assert.equal(wc.getBackgroundThrottling(), true);
  await assert.rejects(command("throw new Error('fixture failure')"), /fixture failure/);
  assert.equal(wc.getBackgroundThrottling(), true, "failed action must restore scheduling");
  const abort = new AbortController();
  const pending = command("new Promise(() => {})", abort.signal);
  // Observe actual acquisition, rather than guessing the queue's start time.
  while (wc.getBackgroundThrottling()) await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error("fixture cancelled"));
  await assert.rejects(pending, /fixture cancelled/);
  assert.equal(wc.getBackgroundThrottling(), true);
  console.error("[throttling] starting recording");
  await native.startRecording(tab, 10);
  assert.equal(wc.getBackgroundThrottling(), false, "recording owns scheduling beyond start");
  const video = await native.stopRecording(tab);
  assert.ok(video.sizeBytes > 16);
  assert.equal(wc.getBackgroundThrottling(), true, "recording stop releases its owner");
  const cancelledStart = new AbortController();
  cancelledStart.abort(new Error("cancel recorder startup"));
  await assert.rejects(native.startRecording(tab, 10, cancelledStart.signal), /cancel recorder startup/);
  assert.equal(wc.getBackgroundThrottling(), true);
  const extraTabs = await Promise.all([1, 2].map(() => native.create("throttle", "about:blank", undefined, false)));
  await Promise.all(extraTabs.map(extra => extra.initialLoad));
  const idlePolicies = [tab, ...extraTabs].map(extra => extra.view.webContents.getBackgroundThrottling());
  assert.deepEqual(idlePolicies, [true, true, true]);
  for (const extra of extraTabs) native.close(extra);
  // Crash an actual recording: production cleanup must retire both owners.
  await native.startRecording(tab, 10);
  const recorderClosed = new Promise<void>(resolve => tab.recording!.recorder.once("closed", () => resolve()));
  const release = tab.backgroundThrottling.acquire();
  const crashed = new Promise<void>(resolve => wc.once("render-process-gone", () => resolve()));
  wc.forcefullyCrashRenderer();
  await crashed;
  assert.equal(wc.getBackgroundThrottling(), true, "crash resets scheduling");
  assert.equal(tab.state.recording, false, "crash ends the unusable recording");
  release();
  await recorderClosed;
  const destroyed = new Promise<void>(resolve => wc.once("destroyed", () => resolve()));
  native.close(tab);
  await destroyed;
  assert.equal(wc.isDestroyed(), true);
  await writeFile(path.join(root, "result.json"), JSON.stringify({
    electron: process.versions.electron, platform: process.platform, idlePolicy, idlePolicies,
    screenshotBytes: Buffer.from(screenshot.data, "base64").length,
    timerResult: value.value, recordingBytes: video.sizeBytes,
    cancellationRestored: true, failureRestored: true, crashRestored: true,
  }, null, 2));
  owner.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
