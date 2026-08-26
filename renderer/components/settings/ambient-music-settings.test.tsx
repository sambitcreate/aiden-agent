import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOMImplementation, DOMParser } from "@xmldom/xmldom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { queryKeys } from "../../lib/queries.js";
import type { AppSettings } from "../../lib/types.js";
import {
  DEFAULT_AMBIENT_MUSIC_CONFIG,
  type AmbientMusicFeatureSnapshot,
  type AmbientMusicModelStatus,
} from "../../shared/ambient-music.js";
import { AmbientMusicSettings } from "./ambient-music-settings.js";

function model(
  id: AmbientMusicModelStatus["model"],
  label: string,
  overrides: Partial<AmbientMusicModelStatus> = {},
): AmbientMusicModelStatus {
  return {
    model: id,
    label,
    recommended: id === "mrt2_small",
    state: "ready",
    downloadBytes: 1_000,
    installedBytes: 1_000,
    additionalDownloadBytes: 0,
    reclaimableBytes: 1_000,
    ...overrides,
  };
}

function renderSettings(
  snapshot: AmbientMusicFeatureSnapshot,
  settings: AppSettings = { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG },
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(queryKeys.ambientMusic, snapshot);
  queryClient.setQueryData(queryKeys.settings, settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AmbientMusicSettings />
    </QueryClientProvider>,
  );
}

test("unsupported Macs get an explanation without model download controls", () => {
  const markup = renderSettings({
    revision: 1,
    supported: false,
    supportReason: "requires_apple_silicon",
    helper: "unsupported",
    playback: "stopped",
    promptReady: false,
    models: [],
    storage: { sharedBytes: 0, locationLabel: "Aiden application data" },
  });
  assert.match(markup, /Not available on this Mac/u);
  assert.match(markup, /requires a Mac with Apple silicon/u);
  assert.doesNotMatch(markup, /On-device Models|>Download</u);
});

test("a helper-less development build explains the opt-in and cannot download models", () => {
  const markup = renderSettings({
    revision: 2,
    supported: true,
    helper: "missing",
    playback: "stopped",
    promptReady: false,
    models: [
      model("mrt2_small", "Small", {
        state: "not_installed",
        installedBytes: 0,
        additionalDownloadBytes: 1_000,
        reclaimableBytes: 0,
      }),
      model("mrt2_base", "Base", { state: "needs_repair" }),
    ],
    storage: { sharedBytes: 500, locationLabel: "Aiden application data" },
  });
  assert.match(markup, /Native helper not built/u);
  assert.match(markup, /AIDEN_BUILD_AMBIENT_MUSIC=1 npm run dev/u);
  assert.match(markup, /Existing downloaded models remain on this Mac/u);

  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const buttons = Array.from(document.getElementsByTagName("button"));
  for (const label of ["Download", "Repair", "Play Ambient Music"]) {
    const control = buttons.find((button) =>
      button.textContent?.includes(label) || button.getAttribute("aria-label") === label,
    );
    assert.ok(control, `${label} control should be rendered`);
    assert.equal(control.hasAttribute("disabled"), true, `${label} must be disabled`);
  }
  const remove = buttons.find((button) => button.getAttribute("aria-label") === "Remove Base");
  assert.ok(remove);
  assert.equal(remove.hasAttribute("disabled"), false, "existing assets must remain removable");
  const terms = Array.from(document.getElementsByTagName("input"))
    .find((input) => input.getAttribute("type") === "checkbox");
  assert.ok(terms);
  assert.equal(terms.hasAttribute("disabled"), true);
});

test("Now Playing identifies the loaded model rather than a different saved selection", () => {
  const markup = renderSettings({
    revision: 8,
    supported: true,
    helper: "ready",
    playback: "playing",
    selectedModel: "mrt2_small",
    loadedModel: "mrt2_small",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: {
      sharedBytes: 500,
      availableBytes: 5_000,
      locationLabel: "Aiden application data",
    },
    baseBenchmark: {
      status: "passed",
      measuredAt: new Date(0).toISOString(),
      p50FrameMs: 20,
      p95FrameMs: 25,
      droppedFrames: 0,
      minimumBufferRatio: 0.5,
    },
  }, {
    ambientMusic: { ...DEFAULT_AMBIENT_MUSIC_CONFIG, selectedModel: "mrt2_base" },
  });
  assert.match(markup, /Small · Playing/u);
  assert.doesNotMatch(markup, /Base · Playing/u);
  assert.match(markup, /ambient-music-visualizer/u);
  assert.match(markup, /data-playing="true"/u);
  assert.match(markup, /The spectrum follows the generated audio/u);
  assert.match(markup, /relative p-4[^"]*gap-0/u);
  assert.match(markup, /mb-4 flex items-center justify-between gap-4/u);
  assert.match(markup, /text-tertiary mt-2/u);
  assert.match(markup, /<h1[^>]*>Ambient Music<\/h1>/u);
  assert.equal(markup.match(/aria-live="polite"/gu)?.length, 1);
  assert.match(markup, /Model files are not bundled with Aiden/u);
  assert.match(markup, /Hugging Face/u);
  assert.match(markup, /Shared model resources: 500 B · 5 KB available/u);
});

test("silent Base qualification is labeled Benchmarking and never renders a live spectrum", () => {
  const markup = renderSettings({
    revision: 9,
    supported: true,
    helper: "ready",
    playback: "loading",
    benchmarking: true,
    promptReady: false,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
    metrics: {
      transformerMs: 20,
      frameMs: 22,
      bufferAvailable: 8,
      bufferCapacity: 10,
      droppedFrames: 0,
      visualizerBands: Array.from({ length: 18 }, () => 0.75),
    },
  }, {
    ambientMusic: { ...DEFAULT_AMBIENT_MUSIC_CONFIG, selectedModel: "mrt2_small" },
  });
  assert.match(markup, /Base · Benchmarking/u);
  assert.match(markup, /data-playing="false"/u);
  assert.match(markup, /data-telemetry="unavailable"/u);
  const document = new DOMParser().parseFromString(`<root>${markup}</root>`, "text/xml");
  const playback = Array.from(document.getElementsByTagName("button"))
    .find((button) => button.getAttribute("aria-label") === "Benchmarking Ambient Music");
  assert.ok(playback);
  assert.equal(playback.hasAttribute("disabled"), true);
});

test("retryable playback failures render an explicit Error state and recovery action", () => {
  const markup = renderSettings({
    revision: 11,
    supported: true,
    helper: "crashed",
    playback: "error",
    selectedModel: "mrt2_small",
    loadedModel: "mrt2_small",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, locationLabel: "Aiden application data" },
    error: { code: "helper_crashed", message: "The helper stopped.", retryable: true },
  });
  assert.match(markup, /Small · Error/u);
  assert.match(markup, />Retry playback</u);
});

test("runtime pressure is a quiet recommendation and never changes the selected model", () => {
  const markup = renderSettings({
    revision: 12,
    supported: true,
    helper: "ready",
    playback: "playing",
    selectedModel: "mrt2_base",
    loadedModel: "mrt2_base",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, locationLabel: "Aiden application data" },
    degradation: {
      code: "realtime_pressure",
      since: new Date(0).toISOString(),
      frameMs: 52,
      bufferRatio: 0.1,
      droppedFramesSinceLastSample: 2,
    },
  }, {
    ambientMusic: { ...DEFAULT_AMBIENT_MUSIC_CONFIG, selectedModel: "mrt2_base" },
  });
  assert.match(markup, /under heavy local load/u);
  assert.match(markup, /Pause heavy local tasks, switch to Small, or pause and retry/u);
  assert.match(markup, /Aiden will not switch models automatically/u);
  assert.match(markup, /Base · Playing/u);
});

test("appearance, reduced-motion, and dialog focus contracts use Aiden primitives", () => {
  const source = readFileSync(new URL("./ambient-music-settings.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.match(source, /motion-reduce:transition-none/u);
  assert.match(source, /flex-wrap/u);
  assert.match(source, /returnFocus=\{modelReturnFocus\}/u);
  assert.match(source, /returnFocus=\{\(\) => resetButtonRef\.current\}/u);
  assert.match(source, /(?:bg-main|border-field|text-accent)/u);
  assert.doesNotMatch(source, /#[\da-f]{3,8}/iu);
  assert.match(styles, /\.ambient-terms-checkbox:focus-visible\s*\{[\s\S]*?var\(--focus-ring\)/u);
});

interface TestIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  onNotification(channel: string, handler: (payload: unknown) => void): () => void;
}

class MountedEvent {
  readonly bubbles = true;
  readonly cancelable = true;
  readonly timeStamp = Date.now();
  defaultPrevented = false;
  cancelBubble = false;
  target: EventTarget | null = null;
  currentTarget: EventTarget | null = null;

  constructor(readonly type: string) {}
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.cancelBubble = true; }
}

function installMountedDom(ipc: TestIpc): {
  document: Document;
  container: HTMLElement;
  restore(): void;
} {
  const document = new DOMImplementation().createDocument(null, "html", null) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const listeners = new WeakMap<object, Map<string, Set<(event: MountedEvent) => void>>>();
  const styles = new WeakMap<object, Record<string, string> & { setProperty(name: string, value: string): void }>();
  const elementPrototype = Object.getPrototypeOf(document.createElement("div")) as HTMLElement & Record<string, unknown>;
  elementPrototype.addEventListener = function addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const byType = listeners.get(this) ?? new Map();
    const handlers = byType.get(type) ?? new Set();
    handlers.add(typeof listener === "function"
      ? listener as unknown as (event: MountedEvent) => void
      : listener.handleEvent.bind(listener) as unknown as (event: MountedEvent) => void);
    byType.set(type, handlers);
    listeners.set(this, byType);
  };
  elementPrototype.removeEventListener = () => undefined;
  elementPrototype.dispatchEvent = function dispatchEvent(raw: Event) {
    const event = raw as unknown as MountedEvent;
    event.target = this;
    let current: Node | null = this as unknown as Node;
    while (current) {
      event.currentTarget = current as unknown as EventTarget;
      for (const handler of listeners.get(current)?.get(event.type) ?? []) handler(event);
      if (!event.bubbles || event.cancelBubble) break;
      current = current.parentNode;
    }
    return !event.defaultPrevented;
  };
  elementPrototype.focus = function focus() {
    Object.defineProperty(document, "activeElement", { configurable: true, value: this, writable: true });
  };
  elementPrototype.closest = function closest(selector: string) {
    let current: Element | null = this as unknown as Element;
    const tag = selector.toLowerCase();
    while (current) {
      if (current.tagName?.toLowerCase() === tag) return current;
      current = current.parentElement;
    }
    return null;
  };
  Object.defineProperty(elementPrototype, "style", {
    configurable: true,
    get() {
      let style = styles.get(this);
      if (!style) {
        style = Object.assign(Object.create(null) as Record<string, string>, {
          setProperty(name: string, value: string) {
            (this as unknown as Record<string, string>)[name] = value;
          },
        });
        styles.set(this, style);
      }
      return style;
    },
  });
  Object.defineProperty(elementPrototype, "isConnected", {
    configurable: true,
    get() {
      let current: Node | null = this as unknown as Node;
      while (current?.parentNode) current = current.parentNode;
      return current === (this as unknown as Node).ownerDocument;
    },
  });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  Object.defineProperty(document, "activeElement", { configurable: true, value: body, writable: true });
  const windowValue = {
    document,
    aidenAPI: { ipc },
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    getComputedStyle: () => ({}),
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: windowValue });
  const globals = [
    "window", "document", "navigator", "Node", "Element", "HTMLElement",
    "HTMLFormElement", "HTMLButtonElement", "HTMLInputElement", "Event",
    "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previous = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const elementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowValue },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "aiden-ambient-music-mounted-test" } },
    Node: { configurable: true, value: elementConstructor },
    Element: { configurable: true, value: elementConstructor },
    HTMLElement: { configurable: true, value: elementConstructor },
    HTMLFormElement: { configurable: true, value: elementConstructor },
    HTMLButtonElement: { configurable: true, value: elementConstructor },
    HTMLInputElement: { configurable: true, value: elementConstructor },
    Event: { configurable: true, value: MountedEvent },
    requestAnimationFrame: { configurable: true, value: windowValue.requestAnimationFrame },
    cancelAnimationFrame: { configurable: true, value: windowValue.cancelAnimationFrame },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  return {
    document,
    container,
    restore() {
      for (const key of globals) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("mounted model switching invokes main and rejects a later stale response snapshot", async () => {
  let notification: ((payload: unknown) => void) | undefined;
  let releaseLoad: ((value: AmbientMusicFeatureSnapshot) => void) | undefined;
  let markLoadStarted: (() => void) | undefined;
  const loadStarted = new Promise<void>((resolve) => { markLoadStarted = resolve; });
  const loadResult = new Promise<AmbientMusicFeatureSnapshot>((resolve) => { releaseLoad = resolve; });
  const calls: Array<[string, ...unknown[]]> = [];
  let currentSettings: AppSettings = { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG };
  const initialSnapshot: AmbientMusicFeatureSnapshot = {
    revision: 2,
    supported: true,
    helper: "ready",
    playback: "paused",
    selectedModel: "mrt2_small",
    loadedModel: "mrt2_small",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
    baseBenchmark: {
      status: "passed", measuredAt: new Date(0).toISOString(), p50FrameMs: 20,
      p95FrameMs: 25, droppedFrames: 0, minimumBufferRatio: 0.5,
    },
  };
  const mounted = installMountedDom({
    async invoke(channel, ...args) {
      calls.push([channel, ...args]);
      if (channel === "settings:get") return currentSettings;
      if (channel === "ambientMusic:get") return initialSnapshot;
      if (channel === "settings:set") {
        currentSettings = { ...currentSettings, ...(args[0] as Partial<AppSettings>) };
        return currentSettings;
      }
      if (channel === "ambientMusic:load") {
        markLoadStarted?.();
        return await loadResult;
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
    onNotification(channel, handler) {
      if (channel === "ambientMusic:changed") notification = handler;
      return () => { notification = undefined; };
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.ambientMusic, initialSnapshot);
  queryClient.setQueryData(queryKeys.settings, currentSettings);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AmbientMusicSettings />
        </QueryClientProvider>,
      );
    });
    const useButton = Array.from(mounted.document.getElementsByTagName("button"))
      .find((button) => button.textContent === "Use");
    assert.ok(useButton, "Base model Use button should be mounted");
    await act(async () => {
      useButton.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await loadStarted;
    });
    const newer = { ...initialSnapshot, revision: 10, playback: "playing" as const };
    await act(async () => { notification?.(newer); });
    releaseLoad?.({
      ...initialSnapshot,
      revision: 9,
      selectedModel: "mrt2_base",
      loadedModel: "mrt2_base",
    });
    await act(async () => { await loadResult; });
    assert.equal(queryClient.getQueryData<AmbientMusicFeatureSnapshot>(queryKeys.ambientMusic)?.revision, 10);
    const liveRegion = Array.from(mounted.document.getElementsByTagName("div"))
      .find((element) => element.getAttribute("role") === "status");
    assert.equal(liveRegion?.textContent, "Ambient Music playing.");
    assert.ok(calls.some(([channel, input]) =>
      channel === "ambientMusic:load" &&
      (input as { model?: unknown }).model === "mrt2_base"));
    assert.equal(currentSettings.ambientMusic?.selectedModel, "mrt2_base");
  } finally {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    mounted.restore();
  }
});

test("mounted Apply uses one main-owned transaction and keeps committed settings on failure", async () => {
  const calls: string[] = [];
  const initialSettings: AppSettings = { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG };
  const initialSnapshot: AmbientMusicFeatureSnapshot = {
    revision: 3,
    supported: true,
    helper: "ready",
    playback: "paused",
    selectedModel: "mrt2_small",
    loadedModel: "mrt2_small",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
  };
  const mounted = installMountedDom({
    async invoke(channel) {
      calls.push(channel);
      if (channel === "settings:get") return initialSettings;
      if (channel === "ambientMusic:get") return initialSnapshot;
      if (channel === "ambientMusic:applyConfiguration") {
        throw new Error("Prompt encoding failed; the helper was unloaded.");
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
    onNotification() { return () => undefined; },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.ambientMusic, initialSnapshot);
  queryClient.setQueryData(queryKeys.settings, initialSettings);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AmbientMusicSettings />
        </QueryClientProvider>,
      );
    });
    const applyButton = Array.from(mounted.document.getElementsByTagName("button"))
      .find((button) => button.textContent === "Reapply mix");
    assert.ok(applyButton);
    await act(async () => {
      applyButton.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(calls, ["ambientMusic:applyConfiguration"]);
    assert.deepEqual(
      queryClient.getQueryData<AppSettings>(queryKeys.settings)?.ambientMusic,
      DEFAULT_AMBIENT_MUSIC_CONFIG,
    );
    assert.match(mounted.container.textContent ?? "", /Prompt encoding failed; the helper was unloaded/u);
  } finally {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    mounted.restore();
  }
});

test("mounted Retry uses the committed mix and rejects a stale apply-and-play response", async () => {
  let notification: ((payload: unknown) => void) | undefined;
  let releaseApply: ((value: {
    snapshot: AmbientMusicFeatureSnapshot;
    config: typeof DEFAULT_AMBIENT_MUSIC_CONFIG;
  }) => void) | undefined;
  let markApplyStarted: (() => void) | undefined;
  const applyStarted = new Promise<void>((resolve) => { markApplyStarted = resolve; });
  const applyResult = new Promise<{
    snapshot: AmbientMusicFeatureSnapshot;
    config: typeof DEFAULT_AMBIENT_MUSIC_CONFIG;
  }>((resolve) => { releaseApply = resolve; });
  let appliedConfig: unknown;
  const initialSettings: AppSettings = { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG };
  const initialSnapshot: AmbientMusicFeatureSnapshot = {
    revision: 4,
    supported: true,
    helper: "crashed",
    playback: "error",
    selectedModel: "mrt2_small",
    promptReady: false,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
    error: { code: "helper_crashed", message: "The helper stopped.", retryable: true },
  };
  const mounted = installMountedDom({
    async invoke(channel, ...args) {
      if (channel === "ambientMusic:applyConfiguration") {
        appliedConfig = (args[0] as { config?: unknown }).config;
        markApplyStarted?.();
        return await applyResult;
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
    onNotification(channel, handler) {
      if (channel === "ambientMusic:changed") notification = handler;
      return () => { notification = undefined; };
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.ambientMusic, initialSnapshot);
  queryClient.setQueryData(queryKeys.settings, initialSettings);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AmbientMusicSettings />
        </QueryClientProvider>,
      );
    });
    const addStyle = Array.from(mounted.document.getElementsByTagName("button"))
      .find((button) => button.textContent === "Add style");
    assert.ok(addStyle);
    await act(async () => {
      addStyle.dispatchEvent(new MountedEvent("click") as unknown as Event);
    });
    const promptInputs = () => Array.from(mounted.document.getElementsByTagName("input"))
      .filter((input) => /^Music style \d+$/u.test(input.getAttribute("aria-label") ?? ""));
    assert.equal(promptInputs().length, 2);
    const retry = Array.from(mounted.document.getElementsByTagName("button"))
      .find((button) => button.textContent === "Retry playback");
    assert.ok(retry);
    assert.equal(retry.hasAttribute("disabled"), false);
    await act(async () => {
      retry.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await applyStarted;
    });
    const newer = { ...initialSnapshot, revision: 10, playback: "paused" as const, error: undefined };
    await act(async () => { notification?.(newer); });
    releaseApply?.({
      snapshot: {
        ...initialSnapshot,
        revision: 9,
        helper: "ready",
        playback: "playing",
        loadedModel: "mrt2_small",
        promptReady: true,
        error: undefined,
      },
      config: DEFAULT_AMBIENT_MUSIC_CONFIG,
    });
    await act(async () => { await applyResult; });
    assert.deepEqual(appliedConfig, DEFAULT_AMBIENT_MUSIC_CONFIG);
    assert.equal(promptInputs().length, 2, "Retry must preserve draft rows");
    assert.equal(queryClient.getQueryData<AmbientMusicFeatureSnapshot>(queryKeys.ambientMusic)?.revision, 10);
    const liveRegion = Array.from(mounted.document.getElementsByTagName("div"))
      .find((element) => element.getAttribute("role") === "status");
    assert.equal(liveRegion?.textContent, "Ambient Music paused.");
  } finally {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    mounted.restore();
  }
});

test("mounted model actions download, cancel, repair, and gate removal behind confirmation", async () => {
  const smallMissing = model("mrt2_small", "Small", {
    state: "not_installed",
    installedBytes: 0,
    additionalDownloadBytes: 1_000,
    reclaimableBytes: 0,
  });
  const baseRepair = model("mrt2_base", "Base", {
    state: "needs_repair",
    installedBytes: 750,
    additionalDownloadBytes: 250,
    reclaimableBytes: 750,
  });
  const snapshot = (revision: number, models: AmbientMusicModelStatus[]): AmbientMusicFeatureSnapshot => ({
    revision,
    supported: true,
    helper: "stopped",
    playback: "stopped",
    promptReady: false,
    models,
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
  });
  let current = snapshot(1, [smallMissing, baseRepair]);
  const calls: Array<[string, unknown]> = [];
  const mounted = installMountedDom({
    async invoke(channel, input) {
      calls.push([channel, input]);
      if (channel === "ambientMusic:download") {
        const request = input as { model: AmbientMusicModelStatus["model"]; repair: boolean };
        if (request.model === "mrt2_small") {
          current = snapshot(2, [model("mrt2_small", "Small", {
            state: "downloading",
            installedBytes: 0,
            additionalDownloadBytes: 1_000,
            reclaimableBytes: 0,
            progress: { downloadedBytes: 100, totalBytes: 1_000, currentFile: 1, fileCount: 2 },
          }), baseRepair]);
        } else {
          current = snapshot(4, [smallMissing, model("mrt2_base", "Base")]);
        }
        return current;
      }
      if (channel === "ambientMusic:cancelDownload") {
        current = snapshot(3, [smallMissing, baseRepair]);
        return current;
      }
      if (channel === "ambientMusic:removeModel") {
        current = snapshot(5, [smallMissing, model("mrt2_base", "Base", {
          state: "not_installed",
          installedBytes: 0,
          additionalDownloadBytes: 1_000,
          reclaimableBytes: 0,
        })]);
        return current;
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
    onNotification() { return () => undefined; },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.ambientMusic, current);
  queryClient.setQueryData<AppSettings>(queryKeys.settings, { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  const findButton = (label: string) => Array.from(mounted.document.getElementsByTagName("button"))
    .find((button) => button.textContent === label || button.getAttribute("aria-label") === label);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AmbientMusicSettings />
        </QueryClientProvider>,
      );
    });
    const terms = Array.from(mounted.document.getElementsByTagName("input"))
      .find((input) => input.getAttribute("class")?.includes("ambient-terms-checkbox"));
    assert.ok(terms);
    await act(async () => {
      terms.checked = true;
      terms.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const download = findButton("Download");
    assert.ok(download);
    assert.equal(download.hasAttribute("disabled"), false);
    await act(async () => {
      download.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const cancel = findButton("Cancel");
    assert.ok(cancel);
    await act(async () => {
      cancel.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const repair = findButton("Repair");
    assert.ok(repair);
    await act(async () => {
      repair.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const removeBase = findButton("Remove Base");
    assert.ok(removeBase);
    assert.equal(removeBase.hasAttribute("disabled"), false);
    await act(async () => {
      removeBase.focus();
      removeBase.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(calls.map(([channel]) => channel), [
      "ambientMusic:download",
      "ambientMusic:cancelDownload",
      "ambientMusic:download",
    ]);
    assert.deepEqual(calls[0]?.[1], { model: "mrt2_small", termsAccepted: true, repair: false });
    assert.deepEqual(calls[2]?.[1], { model: "mrt2_base", termsAccepted: true, repair: true });
    assert.equal(mounted.document.activeElement, removeBase);
  } finally {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    mounted.restore();
  }
});

test("mounted live-control failure remains visible without discarding the saved value", async () => {
  let currentSettings: AppSettings = { ambientMusic: DEFAULT_AMBIENT_MUSIC_CONFIG };
  const initialSnapshot: AmbientMusicFeatureSnapshot = {
    revision: 7,
    supported: true,
    helper: "ready",
    playback: "playing",
    selectedModel: "mrt2_small",
    loadedModel: "mrt2_small",
    promptReady: true,
    models: [model("mrt2_small", "Small"), model("mrt2_base", "Base")],
    storage: { sharedBytes: 500, availableBytes: 5_000, locationLabel: "Aiden application data" },
  };
  const calls: string[] = [];
  const mounted = installMountedDom({
    async invoke(channel, ...args) {
      calls.push(channel);
      if (channel === "settings:set") {
        currentSettings = { ...currentSettings, ...(args[0] as Partial<AppSettings>) };
        return currentSettings;
      }
      if (channel === "ambientMusic:setDrumless") {
        throw new Error("The live soundtrack could not update.");
      }
      throw new Error(`Unexpected IPC ${channel}`);
    },
    onNotification() { return () => undefined; },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.ambientMusic, initialSnapshot);
  queryClient.setQueryData(queryKeys.settings, currentSettings);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(mounted.container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AmbientMusicSettings />
        </QueryClientProvider>,
      );
    });
    const drumless = Array.from(mounted.document.getElementsByTagName("button"))
      .find((button) => button.getAttribute("aria-label") === "Generate Ambient Music without drums");
    assert.ok(drumless);
    await act(async () => {
      drumless.dispatchEvent(new MountedEvent("click") as unknown as Event);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.ok(calls.includes("settings:set"));
    assert.ok(calls.includes("ambientMusic:setDrumless"));
    assert.equal(currentSettings.ambientMusic?.drumless, true);
    assert.match(mounted.container.textContent ?? "", /live soundtrack did not update/u);
  } finally {
    await act(async () => { root.unmount(); });
    queryClient.clear();
    mounted.restore();
  }
});
