import { emitBotTestNotification, installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { afterEach } from "node:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserDeviceToolbar, BrowserEmptyState, BrowserPanel } from "./browser-panel.js";
import { BrowserAnnotationEditor } from "./browser-annotation-editor.js";
import { storedEnvironmentPanelTab, reduceEnvironmentSurfaceState } from "../lib/environment-panel-state.js";
import {
  BROWSER_ELEMENT_GRAB_UNAVAILABLE,
  browserElementGrabDelivery,
} from "../lib/browser-element-grab-delivery.js";
import {
  GRABBED_ELEMENT_SCHEMA_VERSION,
  type GrabbedElementCapture,
} from "../shared/browser-element-grab.js";
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserCommand,
  type BrowserSnapshot,
  type BrowserState,
  type BrowserTab,
} from "../shared/browser.js";

afterEach(cleanup);

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
  assert.ok(source.includes("browserNativeViewObstructed"));
  assert.ok(source.includes("visibleBrowserNativeOccluders"));
  assert.ok(source.includes('action: "annotate", tabId: tab.id, enabled: false'));
  assert.ok(source.includes('aria-keyshortcuts="Meta+."'));
  assert.ok(source.includes('aria-label="Browser tabs"'));
  assert.equal(DEFAULT_BROWSER_SETTINGS.agentAccess, "allow");
  const main = readFileSync(new URL("../../main/services/browser/service.ts", import.meta.url), "utf8");
  assert.ok(main.includes("browserGuestUserAgent"));
  assert.ok(main.includes("applyBrowserGuestIdentityHeaders"));
  assert.ok(main.includes("view.webContents.setUserAgent"));
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
  // The frame's container tracking is shared with the floating device player.
  assert.ok(controls.includes("useFloatingContainerBounds()"));
  const bounds = readFileSync(new URL("../lib/use-floating-container-bounds.ts", import.meta.url), "utf8");
  assert.ok(bounds.includes("ResizeObserver"));
  const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
  assert.ok(composer.includes('data-browser-composer-inset="true"'));
  assert.ok(!composer.includes('data-browser-composer-inset={hasMessages'));
});

test("browser settings distinguish global agent access from the effective workspace override", () => {
  const source = readFileSync(new URL("./browser-settings.tsx", import.meta.url), "utf8");
  assert.ok(source.includes('value={state.agentAccessOverride}'));
  assert.ok(source.includes('action: "agent_access"'));
  assert.ok(source.includes('state.agentAccessAllowed ? "allowed" : "off"'));
  assert.ok(source.includes('state.defaults.agentAccess === "allow"'));
});

test("a failed first browser state read replaces the endless spinner with Try again", () => {
  const props = { state: null, onOpen: () => undefined, run: async () => null };
  const loading = renderToStaticMarkup(<BrowserEmptyState {...props} />);
  assert.match(loading, /role="status"[^>]*>Opening browser…/u);
  const failed = renderToStaticMarkup(<BrowserEmptyState {...props} loadFailed onRetryLoad={() => undefined} />);
  assert.doesNotMatch(failed, /Opening browser/u);
  assert.match(failed, /Couldn’t open the browser/u);
  assert.match(failed, />Try again<\/button>/u);
});

test("Grab toolbar button toggles element grab, shows active status bar, delivers captures to composer, and cancels on Escape", async () => {
  const commands: BrowserCommand[] = [];
  let grabbing = false;
  let revision = 1;
  const currentState = (): BrowserState => ({
    workspaceId: "ws-grab",
    revision,
    tabs: [{ ...tab, id: "tab-grab", workspaceId: "ws-grab", grabbing }],
    activeTabId: "tab-grab",
    profiles: structuredClone(BUILT_IN_BROWSER_PROFILES),
    defaults: structuredClone(DEFAULT_BROWSER_SETTINGS),
    agentAccessOverride: "inherit",
    agentAccessAllowed: true,
    history: [],
    servers: [],
  });

  installBotTestIpc({
    "browser:get-state": () => currentState(),
    "browser:command": (_ws: unknown, cmd: unknown) => {
      const command = cmd as BrowserCommand;
      commands.push(command);
      if (command.action === "grab") {
        grabbing = command.enabled;
        revision += 1;
      }
      return { state: currentState() };
    },
  });

  render(<BrowserPanel workspaceId="ws-grab" active />);
  await screen.findByRole("tab", { name: "App" });
  const grabButton = screen.getByRole("button", { name: "Grab element" });
  const annotateButton = screen.getByRole("button", { name: "Annotate" });
  const addressForm = document.querySelector(".browser-address-form");
  assert.ok(addressForm, "address form is rendered");
  // Grab sits immediately right of .browser-address-form, before Annotate.
  assert.ok(
    Boolean(addressForm.compareDocumentPosition(grabButton) & Node.DOCUMENT_POSITION_FOLLOWING),
    "Grab button follows address form",
  );
  assert.ok(
    Boolean(grabButton.compareDocumentPosition(annotateButton) & Node.DOCUMENT_POSITION_FOLLOWING),
    "Grab button precedes Annotate button",
  );
  assert.equal(grabButton.getAttribute("aria-pressed"), "false");

  // Click Grab -> sends grab(enabled: true) with resolved accent and shows status strip.
  await act(async () => {
    fireEvent.click(grabButton);
  });
  await waitFor(() => {
    const activeButton = screen.getByRole("button", { name: "Stop grabbing" });
    assert.equal(activeButton.getAttribute("aria-pressed"), "true");
  });
  const grabStart = commands.find((cmd) => cmd.action === "grab" && cmd.enabled);
  assert.ok(grabStart && grabStart.action === "grab");
  assert.ok(grabStart.accent?.bg && grabStart.accent?.fg);
  assert.ok(screen.getByText(/Click an element to grab for chat/u));

  // Deliver a grabbed capture through browserElementGrabDelivery when composer is registered.
  const received: GrabbedElementCapture[] = [];
  const unregister = browserElementGrabDelivery.register({
    workspaceId: "ws-grab",
    chatId: "chat-1",
    available: () => true,
    receive: (capture) => {
      received.push(capture);
      return true;
    },
  });
  const capture: GrabbedElementCapture = {
    element: {
      version: GRABBED_ELEMENT_SCHEMA_VERSION,
      id: "el_grab_1",
      label: "<HeroCard />",
      framework: "react",
      componentName: "HeroCard",
      tagName: "section",
      selector: "main > section.hero",
      htmlSnippet: "<section class=\"hero\">Hello</section>",
      boundingBox: { x: 10, y: 20, width: 300, height: 150 },
      pageUrl: "http://localhost:3000/",
      capturedAt: 1_700_000_000_000,
    },
  };
  await act(async () => {
    emitBotTestNotification("browser:event", {
      type: "grab",
      workspaceId: "ws-grab",
      tabId: "tab-grab",
      capture,
    });
  });
  assert.equal(received.length, 1);
  assert.equal(received[0]?.element.label, "<HeroCard />");

  // When composer is unavailable, shows clear user alert instead of silently dropping.
  unregister();
  await act(async () => {
    emitBotTestNotification("browser:event", {
      type: "grab",
      workspaceId: "ws-grab",
      tabId: "tab-grab",
      capture,
    });
  });
  assert.ok(await screen.findByText(BROWSER_ELEMENT_GRAB_UNAVAILABLE));

  // Pressing Escape while host has focus cancels grab via useLayer("panel").
  await act(async () => {
    fireEvent.keyDown(document, { key: "Escape" });
  });
  await waitFor(() => {
    assert.ok(commands.some((cmd) => cmd.action === "grab" && !cmd.enabled));
    assert.equal(screen.getByRole("button", { name: "Grab element" }).getAttribute("aria-pressed"), "false");
  });
});
