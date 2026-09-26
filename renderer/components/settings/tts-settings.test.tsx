import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultTtsSettings, TTS_LIMITS, type TtsSettingsV1 } from "../../shared/tts.js";
import {
  clearGeneratedAudio,
  TtsSettingsView,
  type TtsSettingsViewProps,
} from "./tts-settings.js";

const noop = () => undefined;

function props(extra: Partial<TtsSettingsViewProps> = {}): TtsSettingsViewProps {
  return {
    snapshot: {
      settings: { ...defaultTtsSettings(), enabled: true },
      settingsRevision: "rev-1",
      credentialReady: true,
      credentialSourceLabel: "Saved Google key",
    },
    loadError: false,
    voices: [],
    saving: false,
    dedicatedKey: "",
    deliveryNote: "",
    previewActive: false,
    previewError: null,
    onRetry: noop,
    onPatch: noop,
    onDedicatedKeyChange: noop,
    onSaveDedicatedKey: noop,
    onClearDedicatedKey: noop,
    onPreview: noop,
    onStopPreview: noop,
    onDeliveryNoteChange: noop,
    onClearCache: noop,
    ...extra,
  };
}

function withSettings(update: Partial<TtsSettingsV1>): Partial<TtsSettingsViewProps> {
  const base = props().snapshot!;
  return { snapshot: { ...base, settings: { ...base.settings, ...update } } };
}

type Element = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;

/** Walk the view's element tree (without rendering child components) to reach real handlers. */
function findAll(node: React.ReactNode, match: (element: Element) => boolean): Element[] {
  const found: Element[] = [];
  const visit = (current: React.ReactNode) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!React.isValidElement(current)) return;
    const element = current as Element;
    if (match(element)) found.push(element);
    visit(element.props.children);
  };
  visit(node);
  return found;
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node as Element).props.children);
  }
  return "";
}

function button(tree: React.ReactNode, label: string): Element {
  const [match] = findAll(tree, (element) => typeof element.props.onClick === "function" &&
    textOf(element.props.children) === label);
  assert.ok(match, `button ${label}`);
  return match;
}

function byAriaLabel(tree: React.ReactNode, label: string): Element {
  const [match] = findAll(tree, (element) => element.props["aria-label"] === label);
  assert.ok(match, `element ${label}`);
  return match;
}

test("the preview button drives the player controller and flips to Stop while active", () => {
  const calls: string[] = [];
  const handlers = { onPreview: () => calls.push("preview"), onStopPreview: () => calls.push("stop") };
  const idle = TtsSettingsView(props(handlers));
  const previewButton = button(idle, "Preview sample");
  assert.equal(previewButton.props.disabled, false);
  (previewButton.props.onClick as () => void)();

  const active = TtsSettingsView(props({ ...handlers, previewActive: true }));
  (button(active, "Stop preview").props.onClick as () => void)();
  assert.deepEqual(calls, ["preview", "stop"]);
  assert.match(renderToStaticMarkup(active), />Stop preview</u);
});

test("preview is unavailable until Read aloud is enabled and connected, but Stop always works", () => {
  const disabled = TtsSettingsView(props(withSettings({ enabled: false })));
  assert.equal(button(disabled, "Preview sample").props.disabled, true);
  const disconnected = TtsSettingsView(props({
    snapshot: { ...props().snapshot!, credentialReady: false },
  }));
  assert.equal(button(disconnected, "Preview sample").props.disabled, true);
  assert.match(renderToStaticMarkup(disconnected), /Needs setup/u);
  const activeWhileSaving = TtsSettingsView(props({
    ...withSettings({ enabled: false }),
    saving: true,
    previewActive: true,
  }));
  assert.equal(button(activeWhileSaving, "Stop preview").props.disabled, false);
});

test("the delivery note is bounded and saves on blur only when it changed", () => {
  const patches: unknown[] = [];
  const typed: string[] = [];
  const base = {
    ...withSettings({ delivery: { preset: "calm", note: "slow" } }),
    onPatch: (update: unknown) => patches.push(update),
    onDeliveryNoteChange: (value: string) => typed.push(value),
  };
  const unchanged = byAriaLabel(TtsSettingsView(props({ ...base, deliveryNote: "slow" })), "Optional delivery note");
  assert.equal(unchanged.props.maxLength, TTS_LIMITS.deliveryNoteMaxChars);
  (unchanged.props.onBlur as () => void)();
  assert.deepEqual(patches, []);

  (unchanged.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "slower" } });
  assert.deepEqual(typed, ["slower"]);

  const edited = byAriaLabel(TtsSettingsView(props({ ...base, deliveryNote: "slower" })), "Optional delivery note");
  (edited.props.onBlur as () => void)();
  assert.deepEqual(patches, [{ delivery: { preset: "calm", note: "slower" } }]);
});

test("settings render shared accessible controls, not native selects or page headings", () => {
  const html = renderToStaticMarkup(TtsSettingsView(props(withSettings({ credentialSource: "dedicated" }))));
  assert.doesNotMatch(html, /<h1/u);
  // Only the shared Select's hidden form mirror may be a native <select>.
  assert.doesNotMatch(html, /<select(?![^>]*aria-hidden="true")/u);
  for (const label of ["Speech model", "Google API key source", "Read aloud voice", "Delivery style"]) {
    assert.match(html, new RegExp(`role="combobox"[^>]*aria-label="${label}"`, "u"));
  }
  assert.match(html, /type="password"[^>]*aria-label="Dedicated Google API key"/u);
  const savedKey = renderToStaticMarkup(TtsSettingsView(props()));
  assert.doesNotMatch(savedKey, /aria-label="Dedicated Google API key"/u);
});

test("preview failures surface as an alert, and a load failure offers retry", () => {
  const html = renderToStaticMarkup(TtsSettingsView(props({ previewError: { message: "Voice unavailable." } })));
  assert.match(html, /role="alert"[^>]*>Voice unavailable\./u);

  let retried = 0;
  const failed = TtsSettingsView(props({ snapshot: null, loadError: true, onRetry: () => { retried += 1; } }));
  assert.match(renderToStaticMarkup(failed), /could not be loaded/u);
  (button(failed, "Try again").props.onClick as () => void)();
  assert.equal(retried, 1);
  assert.doesNotMatch(renderToStaticMarkup(TtsSettingsView(props({ snapshot: null }))), /Try again/u);
});

test("clearing generated audio stops preview first and reports failure", async () => {
  const events: string[] = [];
  await clearGeneratedAudio({
    stopPreview: () => events.push("stop"),
    clearCache: async () => { events.push("clear"); },
    notify: (message) => events.push(message),
  });
  assert.deepEqual(events, ["stop", "clear", "Generated audio cleared."]);

  const failures: string[] = [];
  await clearGeneratedAudio({
    stopPreview: noop,
    clearCache: () => Promise.reject(new Error("ipc down")),
    notify: (message) => failures.push(message),
  });
  assert.deepEqual(failures, ["Could not clear generated audio."]);
});
