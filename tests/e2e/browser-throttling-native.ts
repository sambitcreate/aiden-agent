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
  type Tab = { state: BrowserTab; view: WebContentsView; initialLoad: Promise<void>; backgroundThrottling: BrowserBackgroundThrottling; recording?: { recorder: BrowserWindow; stopTimer: ReturnType<typeof setTimeout> } };
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
  // Electron aggregates compositor throttling across an attached window. Exercise
  // the real host's minimized lifecycle, including a sibling that owns no lease.
  native.present(tab, true, { x: 0, y: 0, width: 600, height: 400 });
  const sibling = await native.create("throttle", "about:blank", undefined, false);
  await sibling.initialLoad;
  owner.contentView.addChildView(sibling.view);
  sibling.view.setBounds({ x: 610, y: 0, width: 100, height: 100 });
  sibling.view.setVisible(true);
  await owner.loadURL("about:blank");
  const attachment = () => {
    assert.ok(owner.contentView.children.includes(tab.view), "recorded guest stays in its host");
    assert.ok(owner.contentView.children.includes(sibling.view), "sibling stays attached");
  };
  const policies = () => [owner.webContents, sibling.view.webContents, wc]
    .map(contents => contents.getBackgroundThrottling());
  assert.deepEqual(policies(), [true, true, true]);
  const observedContents = [owner.webContents, sibling.view.webContents];
  await Promise.all(observedContents.map(contents => contents.executeJavaScript(
    "globalThis.fixtureFrames = 0; requestAnimationFrame(function tick() { globalThis.fixtureFrames++; requestAnimationFrame(tick); });",
  )));
  const frameSamples: Array<{ phase: string; elapsedMs: number; host: number; sibling: number; visibility: string[] }> = [];
  const sampleFrames = async (phase: string) => {
    const read = () => Promise.all(observedContents.map(contents => contents.executeJavaScript(
      "({frames: globalThis.fixtureFrames, visibility: document.visibilityState})",
    ))) as Promise<Array<{ frames: number; visibility: string }>>;
    const before = await read();
    const started = Date.now();
    await new Promise(resolve => setTimeout(resolve, 500));
    const after = await read();
    frameSamples.push({ phase, elapsedMs: Date.now() - started,
      host: after[0].frames - before[0].frames, sibling: after[1].frames - before[1].frames,
      visibility: after.map(value => value.visibility),
    });
  };
  // Linux CI runs bare Xvfb without a window manager to acknowledge minimization.
  // Use native hide/show there; macOS/Windows exercise real minimize/restore.
  const backgroundMode = process.platform === "linux" ? "hidden" : "minimized";
  const isBackgrounded = () => backgroundMode === "hidden" ? !owner.isVisible() : owner.isMinimized();
  const backgrounded = new Promise<void>(resolve => {
    if (backgroundMode === "hidden") owner.once("hide", () => resolve());
    else owner.once("minimize", () => resolve());
  });
  if (backgroundMode === "hidden") owner.hide();
  else owner.minimize();
  await backgrounded;
  assert.equal(isBackgrounded(), true);
  attachment();
  await sampleFrames(`${backgroundMode} idle`);
  await native.startRecording(tab, 10);
  await sampleFrames(`${backgroundMode} recording`);
  const duringRecordingPolicies = policies();
  assert.deepEqual(duringRecordingPolicies, [true, true, false]);
  // The host/sibling getters describe their own scheduler preference, NOT the
  // window compositor: Electron's native aggregator allows window-wide drawing.
  const minimizedTimer = await command("new Promise(resolve => setTimeout(() => resolve('minimized timer'), 10))");
  assert.equal(minimizedTimer.value, "minimized timer");
  const concurrentAbort = new AbortController();
  let enteredAction!: () => void;
  const entered = new Promise<void>(resolve => { enteredAction = resolve; });
  const concurrent = browser.command("throttle", {
    action: "evaluate", tabId: tab.state.id, expression: "new Promise(() => {})",
  }, { source: "user", signal: concurrentAbort.signal, beforeEffect: enteredAction });
  await entered;
  concurrentAbort.abort(new Error("cancel attached action"));
  await assert.rejects(concurrent, /cancel attached action/);
  assert.equal(wc.getBackgroundThrottling(), false, "recording survives another owner's cancellation");
  const minimizedVideo = await native.stopRecording(tab);
  assert.ok(minimizedVideo.sizeBytes > 16);
  assert.equal(isBackgrounded(), true, "stopping capture must not restore the host window");
  attachment();
  const afterRecordingPolicies = policies();
  assert.deepEqual(afterRecordingPolicies, [true, true, true]);
  await sampleFrames(`${backgroundMode} after stop`);
  // Exercise the production five-minute expiry without a five-minute sleep.
  // Keep real timers/native encoder startup; retain the actual stop timer callback.
  const schedule = globalThis.setTimeout;
  const timers = new Map<ReturnType<typeof setTimeout>, { callback: () => void; delay?: number }>();
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const timer = schedule(callback, delay, ...args);
    timers.set(timer, { callback: () => callback(...args), delay });
    return timer;
  }) as typeof setTimeout;
  try {
    await native.startRecording(tab, 10);
  } finally {
    globalThis.setTimeout = schedule;
  }
  const expiring = tab.recording!;
  const expiry = timers.get(expiring.stopTimer)!;
  assert.equal(expiry.delay, 5 * 60_000, "active recording has a five-minute capture limit");
  const autoStopped = new Promise<void>(resolve => expiring.recorder.once("closed", () => resolve()));
  clearTimeout(expiring.stopTimer);
  expiry.callback();
  await autoStopped;
  assert.equal(tab.state.recording, false);
  assert.deepEqual(policies(), [true, true, true], "automatic stop releases the window's last exception");
  assert.equal(isBackgrounded(), true);
  attachment();
  owner.contentView.removeChildView(sibling.view);
  native.close(sibling);
  const restored = new Promise<void>(resolve => {
    if (backgroundMode === "hidden") owner.once("show", () => resolve());
    else owner.once("restore", () => resolve());
  });
  if (backgroundMode === "hidden") owner.show();
  else owner.restore();
  await restored;
  assert.equal(isBackgrounded(), false);
  const attachedWindow = {
    duringRecordingPolicies, afterRecordingPolicies, frameSamples,
    minimizedTimer: minimizedTimer.value, recordingBytes: minimizedVideo.sizeBytes,
    backgroundMode, stayedBackgrounded: true, preservedAttachments: true, automaticStopDelayMs: expiry.delay,
  };
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
    cancellationRestored: true, failureRestored: true, crashRestored: true, attachedWindow,
  }, null, 2));
  owner.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
