import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DOMImplementation } from "@xmldom/xmldom";
import { CREATE_IMAGES_GEMINI_RELEASE_CATALOG } from "../shared/create-images/providers.js";
import { CreateImagesProviderConnectionContent } from "./provider-connection.js";
import {
  createImagesProviderStatusFromExistingProvider,
  createImagesProviderStatusViewModel,
} from "./provider-connection-core.js";

function installMountedDom(): { container: HTMLElement; restore(): void } {
  const document = new DOMImplementation().createDocument(
    null,
    "html",
    null,
  ) as unknown as Document;
  const body = document.createElement("body");
  const container = document.createElement("div");
  body.appendChild(container);
  document.documentElement.appendChild(body);
  const elementPrototype = Object.getPrototypeOf(document.createElement("div")) as HTMLElement &
    Record<string, unknown>;
  elementPrototype.addEventListener = () => undefined;
  elementPrototype.removeEventListener = () => undefined;
  elementPrototype.focus = () => undefined;
  Object.defineProperty(elementPrototype, "style", { configurable: true, get: () => ({}) });
  const documentPrototype = Object.getPrototypeOf(document) as Document;
  documentPrototype.addEventListener = () => undefined;
  documentPrototype.removeEventListener = () => undefined;
  Object.defineProperty(document, "body", { configurable: true, value: body });
  const window = {
    document,
    HTMLIFrameElement: class HTMLIFrameElement {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
  };
  Object.defineProperty(document, "defaultView", { configurable: true, value: window });
  const keys = [
    "window",
    "document",
    "navigator",
    "Node",
    "Element",
    "HTMLElement",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ] as const;
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const elementConstructor = Object.getPrototypeOf(document.documentElement).constructor;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: document },
    navigator: { configurable: true, value: { userAgent: "provider-connection-test" } },
    Node: { configurable: true, value: elementConstructor },
    Element: { configurable: true, value: elementConstructor },
    HTMLElement: { configurable: true, value: elementConstructor },
    requestAnimationFrame: { configurable: true, value: window.requestAnimationFrame },
    cancelAnimationFrame: { configurable: true, value: window.cancelAnimationFrame },
  });
  return {
    container,
    restore: () => {
      for (const key of keys) {
        const descriptor = previous.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function reactOnClick(button: HTMLButtonElement): () => void {
  const key = Object.getOwnPropertyNames(button).find((candidate) =>
    candidate.startsWith("__reactProps$"),
  );
  assert.ok(key);
  const props = (button as unknown as Record<string, unknown>)[key] as { onClick?: () => void };
  assert.ok(props.onClick);
  return props.onClick;
}

test("provider status view covers every safe connection state without exposing backend detail", () => {
  const expected = {
    disconnected: "Disconnected",
    connecting: "Connecting",
    connected: "Connected",
    invalid: "Invalid",
    unavailable: "Unavailable",
  } as const;
  for (const [connectionState, label] of Object.entries(expected)) {
    const model = createImagesProviderStatusViewModel({
      schemaVersion: 1,
      providerId: "gemini",
      displayName: "Google Gemini",
      connectionState: connectionState as keyof typeof expected,
      ...(connectionState === "connected"
        ? {
            credentialKind: "google-api-key" as const,
            capabilitySnapshot: CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
          }
        : {}),
    });
    assert.equal(model.label, label);
  }
});

test("legacy chat provider state never claims image auth compatibility", () => {
  const status = createImagesProviderStatusFromExistingProvider({
    kind: "ready",
    providers: [
      {
        id: "google",
        kind: "openai",
        label: "Google Gemini",
        baseUrl: "",
        models: [],
        needsKey: true,
        isBuiltin: true,
        hasKey: true,
      },
    ],
  });
  assert.equal(status.connectionState, "unavailable");
  assert.equal(status.safeErrorCode, "credential-scope-unverified");
  assert.equal(status.credentialKind, undefined);
});

test("mounted provider disclosure keeps local mock available and gates Gemini selection", async () => {
  const mounted = installMountedDom();
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  const root = createRoot(mounted.container);
  let selected = "";
  let openedSettings = false;
  try {
    flushSync(() =>
      root.render(
        <CreateImagesProviderConnectionContent
          status={{
            schemaVersion: 1,
            providerId: "gemini",
            displayName: "Google Gemini",
            connectionState: "connected",
            credentialKind: "google-api-key",
            capabilitySnapshot: CREATE_IMAGES_GEMINI_RELEASE_CATALOG,
          }}
          executionMode="local-mock"
          onExecutionModeChange={(mode) => {
            selected = mode;
          }}
          onOpenProviderSettings={() => {
            openedSettings = true;
          }}
        />,
      ),
    );
    const text = mounted.container.textContent ?? "";
    assert.match(text, /private, deterministic, \$0, and fully on this Mac/iu);
    assert.match(text, /prompts and selected reference images leave this Mac/iu);
    assert.match(text, /SynthID/iu);
    assert.match(text, /may create a billed request/iu);
    assert.match(text, /cancellation is advisory/iu);
    assert.match(text, /never automatically retries a paid request/iu);
    const buttons = Array.from(mounted.container.getElementsByTagName("button"));
    const radios = buttons.filter((button) => button.getAttribute("role") === "radio");
    assert.equal(radios.length, 2);
    assert.equal(radios[0]?.getAttribute("aria-checked"), "true");
    assert.equal(radios[1]?.hasAttribute("disabled"), false);
    reactOnClick(radios[1]!)();
    assert.equal(selected, "gemini");
    reactOnClick(buttons[buttons.length - 1]!)();
    assert.equal(openedSettings, true);
  } finally {
    flushSync(() => root.unmount());
    // React 19 schedules host cleanup after unmount. Keep this test process's
    // synthetic DOM installed so that deferred cleanup cannot observe a
    // missing window after the test callback returns.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
});

test("provider source contract includes responsive, reduced-motion, forced-color, and settings-only setup", () => {
  const component = readFileSync(new URL("./provider-connection.tsx", import.meta.url), "utf8");
  const core = readFileSync(new URL("./provider-connection-core.ts", import.meta.url), "utf8");
  const styles = readFileSync(new URL("./create-images.css", import.meta.url), "utf8");
  const view = readFileSync(new URL("./create-images-view.tsx", import.meta.url), "utf8");
  const node = readFileSync(new URL("./workflow-node.tsx", import.meta.url), "utf8");
  assert.match(core, /Set up in Providers/u);
  assert.doesNotMatch(component, /type="password"|API key.*<Input|credential.*value/iu);
  assert.match(component, /role="radiogroup"/u);
  assert.match(styles, /@media \(max-width: 560px\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(styles, /:root\[data-reduce-motion="true"\]/u);
  assert.match(styles, /@media \(forced-colors: active\)/u);
  assert.match(view, /to: "\/settings", search: \{ section: "providers" \}/u);
  for (const label of [
    "Image model",
    "Aspect ratio",
    "Image size",
    "Output format",
    "Output count",
  ]) {
    assert.match(node, new RegExp(label));
  }
});
