import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserDeviceToolbar } from "./browser-panel.js";
import { BrowserAnnotationEditor } from "./browser-annotation-editor.js";
import { storedEnvironmentPanelTab, reduceEnvironmentSurfaceState } from "../lib/environment-panel-state.js";
import { DEFAULT_BROWSER_SETTINGS, type BrowserSnapshot, type BrowserTab } from "../shared/browser.js";

const tab: BrowserTab = { id: "tab", workspaceId: "workspace", profileId: "default", url: "http://localhost:3000", title: "App", loading: false, canGoBack: false, canGoForward: false, crashed: false, audible: false, muted: false, viewport: { mode: "responsive", width: 375, height: 667 }, appearance: "system", zoom: 1, recording: false, agentControlling: false, floating: false };

test("Browser is a restorable Environment destination while Quick View stays open", () => {
  assert.equal(storedEnvironmentPanelTab({ getItem: () => "browser", setItem: () => undefined }, "tab", false), "browser");
  const state = reduceEnvironmentSurfaceState({ quickViewOpen: true, toolsOpen: false, toolsTab: "review", frontSurface: "quick-view" }, { type: "show-tools", tab: "browser" });
  assert.equal(state.quickViewOpen, true); assert.equal(state.toolsTab, "browser"); assert.equal(state.toolsOpen, true);
});

test("device controls expose all reference presets, dimensions, aspect lock and rotation", () => {
  const html = renderToStaticMarkup(<BrowserDeviceToolbar tab={tab} run={async () => null} />);
  assert.equal((html.match(/<option/g) ?? []).length, 18);
  for (const label of ["Browser device preset", "Viewport width", "Viewport height", "Lock viewport aspect ratio", "Rotate viewport", "Close device toolbar"]) assert.ok(html.includes(`aria-label="${label}"`));
  assert.ok(html.includes('value="375"')); assert.ok(html.includes('value="667"'));
});

test("annotation keeps selected text and offers keyboard-accessible element selection", () => {
  const snapshot: BrowserSnapshot = { tab, text: "page", elements: [{ ref: "e1", tag: "button", text: "Save", selector: "#save", bounds: { x: 10, y: 20, width: 80, height: 30 } }], diagnostics: [] };
  const html = renderToStaticMarkup(<BrowserAnnotationEditor snapshot={snapshot} initial={{ url: tab.url, selectedText: "Selected page text", elements: snapshot.elements, regions: [], strokes: [], comment: "" }} pending={false} onCancel={() => undefined} onSubmit={() => undefined} />);
  assert.ok(html.includes("Selected page text")); assert.ok(html.includes('aria-label="Element to annotate"'));
  assert.ok(html.includes("Suggested style changes")); assert.ok(html.includes("Add to chat")); assert.ok(html.includes("Cancel annotation"));
  assert.ok(html.includes("Erase"));
  for (const label of ["Font", "Font size", "Font weight", "Line height", "Text color value", "Background value", "Opacity", "Radius", "Border color value", "Border width", "Element width", "Element height", "Unlock element aspect ratio", "Padding", "Margin", "Gap"]) assert.ok(html.includes(`aria-label="${label}"`), label);
});

test("native browser hides behind app overlays and never closes tabs on panel hide", () => {
  const source = readFileSync(new URL("./browser-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('action: "present", tabId, visible: false'));
  assert.ok(source.includes('enqueueBrowserPresentation(presentationKey'));
  assert.ok(source.includes('[role="dialog"], [role="alertdialog"], [data-slot="popover-content"]'));
  assert.ok(source.includes('action: "annotate", tabId: tab.id, enabled: false'));
  assert.ok(source.includes('aria-keyshortcuts="Meta+."'));
  assert.ok(source.includes('aria-label="Browser tabs"'));
  assert.equal(DEFAULT_BROWSER_SETTINGS.agentAccess, "allow");
});

test("HTML and PDF files expose a saved workspace file preview through the browser service", () => {
  const source = readFileSync(new URL("./files-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('aria-label="Open in Browser"'));
  assert.ok(source.includes('action: "open_file", path: selectedPath'));
  assert.ok(source.includes('Open the saved file in Browser'));
  assert.ok(source.includes('html?|pdf'));
});

test("annotation editor clears only after sanitized context is acknowledged by its captured composer", () => {
  const source = readFileSync(new URL("./browser-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("browserAnnotationDelivery.capture(workspaceId)"));
  assert.ok(source.includes('delivery: "renderer"'));
  assert.ok(source.includes("recipient.deliver(result.annotation)) cancelAnnotation()"));
  assert.ok(source.includes("setError(BROWSER_ANNOTATION_UNAVAILABLE)"));
  assert.ok(source.includes("annotationSubmissionRef.current !== submission"));
  assert.ok(source.includes("annotationPreviewQueueRef.current.reset"));
  assert.ok(source.includes('action: "annotation_reset"'));
  const main = readFileSync(new URL("../../main/services/browser/service.ts", import.meta.url), "utf8");
  assert.ok(main.includes("result.annotation = annotation"));
  assert.ok(main.includes('command.delivery !== "renderer"'));
});

test("screenshot success requires a written file and favicon failures keep the globe affordance", () => {
  const source = readFileSync(new URL("./browser-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("savedBrowserScreenshotPath(saved)"));
  assert.ok(source.includes('if (path) toast.success("Screenshot saved"'));
  assert.ok(source.includes("failedSource !== src"));
  assert.ok(source.includes('<Globe aria-hidden="true" />'));
  assert.ok(!source.includes("event.currentTarget.hidden = true"));
});

test("floating preview uses the live browser portal independently of sidebar visibility", () => {
  const source = readFileSync(new URL("./browser-panel.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("active || Boolean(tab?.floating)"));
  assert.ok(source.includes("createPortal(<BrowserFloatingFrame"));
  assert.ok(source.includes("presentationRef.current = schedule"));
  assert.ok(source.includes("onPictureInPicture"));
  assert.ok(!source.includes("Browser is in a floating window"));
  const controls = readFileSync(new URL("./browser-floating-frame.tsx", import.meta.url), "utf8");
  for (const label of ["Move floating browser", "Return browser to Environment", "Close floating browser preview"]) assert.ok(controls.includes(label));
  assert.ok(controls.includes("setPointerCapture"));
  assert.ok(controls.includes("ResizeObserver"));
  const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
  assert.ok(composer.includes('data-browser-composer-inset={placement === "chat" ? "true" : undefined}'));
  assert.ok(!composer.includes('data-browser-composer-inset={hasMessages'));
});

test("browser settings distinguish global agent access from the effective workspace override", () => {
  const source = readFileSync(new URL("./browser-settings.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('value={state.agentAccessOverride}'));
  assert.ok(source.includes('action: "agent_access"'));
  assert.ok(source.includes('state.agentAccessAllowed ? "allowed" : "off"'));
  assert.ok(source.includes('state.defaults.agentAccess === "allow"'));
});
