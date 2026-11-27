import assert from "node:assert/strict";
import test from "node:test";
import { inspectFrameworkElement } from "./grab-runtime/inspect-frameworks.js";
import { inspectReactElement } from "./grab-runtime/inspect-react.js";
import { GrabSteppingState } from "./grab-runtime/stepping.js";
import { LocalGrabSourceMapResolver } from "./grab-source-map.js";
import { sanitizeRawGrabPayload } from "./grab-sanitize.js";

test("inspectReactElement extracts React 18 _debugSource, unwraps Memo/ForwardRef, bridges Portals, and redacts secret props", () => {
  function HeroSection() {}
  function InnerButton() {}
  const ForwardedButton = { render: InnerButton };
  const MemoHero = { type: HeroSection };
  function AppRouter() {}

  const routerFiber = { type: AppRouter, return: null };
  const heroFiber = {
    type: MemoHero,
    return: routerFiber,
    _debugSource: { fileName: "webpack-internal:///(app-pages-browser)/./src/HeroSection.tsx", lineNumber: 18, columnNumber: 3 },
    memoizedProps: { title: "Welcome" },
  };
  const portalFiber = { type: null, return: heroFiber };
  const buttonFiber = {
    type: ForwardedButton,
    return: portalFiber,
    _debugOwner: heroFiber,
    _debugSource: { fileName: "/Users/dev/app/src/Button.tsx", lineNumber: 42, columnNumber: 9 },
    memoizedProps: {
      variant: "primary",
      disabled: false,
      apiKey: "sk-super-secret",
      authToken: "secret-123",
      onClick: () => undefined,
      children: "Save",
    },
  };
  const hostFiber = {
    type: "button",
    return: buttonFiber,
    _debugOwner: buttonFiber,
    _debugSource: { fileName: "/Users/dev/app/src/Button.tsx", lineNumber: 45, columnNumber: 5 },
  };

  const fakeEl = { __reactFiber$test123: hostFiber };
  const result = inspectReactElement(fakeEl);
  assert.ok(result);
  assert.equal(result.componentName, "InnerButton");
  assert.deepEqual(
    result.componentStack.map((frame) => frame.name),
    ["InnerButton", "HeroSection"],
  );
  assert.equal(result.source?.fileName, "/Users/dev/app/src/Button.tsx");
  assert.equal(result.source?.lineNumber, 45);
  assert.deepEqual(result.props, {
    variant: "primary",
    disabled: false,
    apiKey: "[redacted]",
    authToken: "[redacted]",
  });
});

test("inspectReactElement handles React 19 _debugStack, RSC Server components, minified production builds, and hostile getters", () => {
  let getterInvoked = false;
  const hostileProps: Record<string, unknown> = { safe: "ok" };
  Object.defineProperty(hostileProps, "boom", {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new Error("should never run");
    },
  });

  const serverOwner = {
    name: "LandingPage",
    env: "Server",
    debugStack: "Error\n    at LandingPage (http://localhost:3000/app/page.js:12:3)",
  };
  function LandingHeroClient() {}
  const clientFiber = {
    type: LandingHeroClient,
    _debugOwner: serverOwner,
    _debugStack: new Error("react-stack"),
    memoizedProps: hostileProps,
    return: null,
  };
  const hostFiber = {
    type: "section",
    _debugOwner: clientFiber,
    return: clientFiber,
  };

  const result = inspectReactElement({ __reactFiber$r19: hostFiber });
  assert.ok(result);
  assert.equal(getterInvoked, false, "page-defined getters must never be invoked");
  assert.equal(result.componentName, "LandingHeroClient");
  assert.equal(result.componentStack[1]?.name, "LandingPage");
  assert.equal(result.componentStack[1]?.environment, "server");
  assert.deepEqual(result.props, { safe: "ok" });

  // Minified production build: single-char names are marked minified and not promoted to componentName.
  function a() {}
  function Le() {}
  const minFiber = { type: a, return: { type: Le, return: null } };
  const minResult = inspectReactElement({ __reactFiber$prod: { type: "button", return: minFiber } });
  assert.ok(minResult);
  assert.equal(minResult.componentName, undefined);
  assert.equal(minResult.componentStack[0]?.minified, true);
});

test("inspectFrameworkElement detects Vue 3, Svelte, Astro, and Preact elements", () => {
  const vueEl = {
    __vueParentComponent: {
      type: { __name: "PricingCard", __file: "src/PricingCard.vue" },
      parent: { type: { name: "PricingPage" }, parent: null },
    },
  } as unknown as Element;
  const vue = inspectFrameworkElement(vueEl);
  assert.equal(vue?.framework, "vue");
  assert.equal(vue?.componentName, "PricingCard");
  assert.equal(vue?.source?.fileName, "src/PricingCard.vue");

  // A minified inner component with a file under a named parent without one still points at a source.
  const minifiedVue = inspectFrameworkElement({
    __vueParentComponent: {
      type: { name: "a", __file: "src/components/Badge.vue" },
      parent: { type: { name: "PricingPage" }, parent: null },
    },
  } as unknown as Element);
  assert.equal(minifiedVue?.componentName, "PricingPage");
  assert.equal(minifiedVue?.source?.fileName, "src/components/Badge.vue");

  const svelteEl = {
    __svelte_meta: { loc: { file: "src/routes/Nav.svelte", line: 9, char: 4 } },
    parentElement: null,
  } as unknown as Element;
  const svelte = inspectFrameworkElement(svelteEl);
  assert.equal(svelte?.framework, "svelte");
  assert.equal(svelte?.componentName, "Nav");
  assert.equal(svelte?.source?.lineNumber, 10);

  const astroEl = {
    getAttribute: (name: string) =>
      name === "data-astro-source-file"
        ? "src/components/Footer.astro"
        : name === "data-astro-source-loc"
          ? "14:2"
          : null,
    parentElement: null,
  } as unknown as Element;
  const astro = inspectFrameworkElement(astroEl);
  assert.equal(astro?.framework, "astro");
  assert.equal(astro?.componentName, "Footer");
  assert.equal(astro?.source?.lineNumber, 14);

  function Counter() {}
  const preactEl = {
    __k: { type: Counter, __: null },
  } as unknown as Element;
  const preact = inspectFrameworkElement(preactEl);
  assert.equal(preact?.framework, "preact");
  assert.equal(preact?.componentName, "Counter");
});

test("GrabSteppingState steps up/down ancestors and unlocks on pointer move > 6px", () => {
  const makeFakeEl = (tag: string, rect: { x: number; y: number; width: number; height: number }, parent: Element | null) =>
    ({
      localName: tag,
      tagName: tag.toUpperCase(),
      parentElement: parent,
      getBoundingClientRect: () => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }),
      ownerDocument: null,
    }) as unknown as Element;

  const section = makeFakeEl("section", { x: 0, y: 0, width: 600, height: 300 }, null);
  const button = makeFakeEl("button", { x: 20, y: 20, width: 100, height: 40 }, section);
  const span = makeFakeEl("span", { x: 30, y: 25, width: 60, height: 20 }, button);

  const stepping = new GrabSteppingState();
  stepping.onPointerMove(40, 30, span);
  assert.equal(stepping.getCurrent(), span);

  assert.equal(stepping.stepUp(), button);
  assert.equal(stepping.getDepth(), 1);
  assert.equal(stepping.stepUp(), section);
  assert.equal(stepping.getDepth(), 2);

  // Small pointer jitter (<= 6px) keeps keyboard-stepped target locked.
  stepping.onPointerMove(43, 32, span);
  assert.equal(stepping.getCurrent(), section);

  // Stepping back down restores descendant trail.
  assert.equal(stepping.stepDown(), button);
  assert.equal(stepping.getDepth(), 1);

  // Larger pointer move (> 6px) unlocks and resumes live hover tracking.
  stepping.onPointerMove(80, 80, span);
  assert.equal(stepping.getCurrent(), span);
  assert.equal(stepping.getDepth(), 0);
});

test("sanitizeRawGrabPayload enforces authoritative URL/title, strips credentials & unsafe attrs, and falls back cleanly for minified React", async () => {
  const resolver = new LocalGrabSourceMapResolver({
    fetchImpl: (async () => new Response("Not Found", { status: 404 })) as typeof fetch,
  });

  const sanitized = await sanitizeRawGrabPayload(
    {
      framework: "react",
      keepActive: true,
      componentStack: [{ name: "a", minified: true }],
      tagName: "button",
      selector: "main > button.cta-primary",
      htmlSnippet: '<button class="cta-primary">Token ghp_1234567890123456789012345</button>',
      textPreview: "Bearer secret_token_value_12345",
      attributes: {
        class: "cta-primary",
        onclick: "evil()",
        value: "my-password",
        "data-api-key": "secret-val",
      },
      props: {
        secretToken: "hidden",
        size: "lg",
      },
      boundingBox: { x: 10, y: 20, width: 120, height: 40 },
      viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
    },
    {
      pageUrl: "https://alice:hunter2@localhost:3000/dashboard?__aiden_preview=1",
      pageTitle: "Dashboard",
      zoomFactor: 1.25,
      id: "fixed_id_1",
      capturedAt: 42_000,
      sourceMapResolver: resolver,
    },
  );

  assert.equal(sanitized.keepActive, true);
  assert.equal(sanitized.element.label, "button.cta-primary");
  assert.equal(sanitized.element.componentName, undefined);
  assert.equal(sanitized.element.pageUrl, "https://localhost:3000/dashboard?__aiden_preview=1");
  assert.equal(sanitized.element.attributes?.onclick, undefined);
  assert.equal(sanitized.element.attributes?.value, undefined);
  assert.equal(sanitized.element.attributes?.["data-api-key"], "[redacted]");
  assert.equal(sanitized.element.props?.secretToken, "[redacted]");
  assert.equal(sanitized.element.props?.size, "lg");
  assert.doesNotMatch(sanitized.element.htmlSnippet, /ghp_/);
  assert.match(sanitized.element.htmlSnippet, /\[redacted\]/);
  assert.equal(sanitized.element.textPreview, "[redacted]");
  assert.equal(sanitized.element.viewport?.zoomFactor, 1.25);
});

test("sanitizeRawGrabPayload prevents remote pages from triggering local fetch or file reads via forged _debugStack", async () => {
  let fetchCalls = 0;
  let readCalls = 0;
  const resolver = new LocalGrabSourceMapResolver({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("", { status: 200 });
    }) as typeof fetch,
    readFileImpl: async () => {
      readCalls += 1;
      return Buffer.from("");
    },
  });

  const remote = await sanitizeRawGrabPayload(
    {
      framework: "react",
      componentName: "SpoofedCard",
      componentStack: [
        {
          name: "SpoofedCard",
          source: {
            debugStack:
              "Error\n    at SpoofedCard (http://127.0.0.1:3000/secret.js:1:1)\n    at Leak (file:///etc/passwd:1:1)",
          },
        },
        {
          name: "StaticSourceFrame",
          source: {
            fileName: "webpack-internal:///(app-pages-browser)/./src/StaticCard.tsx",
            lineNumber: 7,
          },
        },
      ],
      source: {
        debugStack: "Error\n    at SpoofedCard (file:///Users/dev/app/dist/bundle.js:1:1)",
      },
      tagName: "div",
      selector: "div.card",
      htmlSnippet: '<div class="card">Hi</div>',
      boundingBox: { x: 0, y: 0, width: 100, height: 50 },
      viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
    },
    {
      pageUrl: "https://evil.example/landing",
      workspaceRoot: "/Users/dev/app",
      id: "remote_guard_1",
      capturedAt: 1000,
      sourceMapResolver: resolver,
    },
  );

  assert.equal(fetchCalls, 0, "remote page must never trigger loopback fetch");
  assert.equal(readCalls, 0, "remote page must never trigger local file read");
  assert.equal(remote.element.source?.symbolicated, false);
  // Offline static _debugSource.fileName normalization still works cleanly.
  assert.deepEqual(remote.element.componentStack?.[1]?.source, {
    filePath: "src/StaticCard.tsx",
    line: 7,
    symbolicated: false,
  });
});

test("a grabbed credential field never carries its live value in props, whatever the prop is called", async () => {
  function OtpField() {}
  const otpFiber = {
    type: OtpField,
    return: null,
    memoizedProps: { value: "493817", autoComplete: "one-time-code", code: "493817", label: "Code" },
  };
  const otp = inspectReactElement({ __reactFiber$otp: { type: "input", return: otpFiber, _debugOwner: otpFiber } });
  assert.deepEqual(otp?.props, { value: "[redacted]", autoComplete: "one-time-code", code: "[redacted]", label: "[redacted]" });

  // The page reports its own props, so the main process applies the same rule to whatever arrives.
  const raw = (props: Record<string, unknown>, sensitiveTarget?: boolean) => ({
    framework: "react",
    componentStack: [{ name: "PasswordField" }],
    props,
    ...(sensitiveTarget ? { sensitiveTarget } : {}),
    tagName: "input",
    selector: "input#password",
    htmlSnippet: '<input id="password" type="password">',
    boundingBox: { x: 0, y: 0, width: 200, height: 30 },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  });
  const options = { pageUrl: "http://localhost:3000/login", id: "credential_props", capturedAt: 1 };

  const controlled = await sanitizeRawGrabPayload(raw({ value: "hunter2-secret-pass", placeholder: "Password" }), options);
  assert.equal(controlled.element.props?.value, "[redacted]");
  assert.equal(controlled.element.props?.placeholder, "Password");

  const typed = await sanitizeRawGrabPayload(raw({ type: "password", draft: "hunter2-secret-pass", defaultValue: "x" }), options);
  assert.deepEqual(typed.element.props, { type: "password", draft: "[redacted]", defaultValue: "[redacted]" });

  // A wrapper around a password input is sensitive even when its own props don't say so.
  const wrapper = await sanitizeRawGrabPayload(raw({ current: "hunter2-secret-pass", pin: 4321, disabled: false }, true), options);
  assert.deepEqual(wrapper.element.props, { current: "[redacted]", pin: "[redacted]", disabled: false });
  assert.doesNotMatch(JSON.stringify([controlled.element, typed.element, wrapper.element]), /hunter2|4321/);
});

test("a payload taken before the page moved to another origin carries no source hint and fetches nothing", async () => {
  const fetchedUrls: string[] = [];
  const sourceMapJson = JSON.stringify({ version: 3, sources: ["src/components/Card.tsx"], mappings: "AAUI" });
  const inlineMap = `data:application/json;base64,${Buffer.from(sourceMapJson, "utf8").toString("base64")}`;
  const resolver = new LocalGrabSourceMapResolver({
    fetchImpl: (async (input: RequestInfo | URL) => {
      fetchedUrls.push(String(input));
      return new Response(`console.log(1);\n//# sourceMappingURL=${inlineMap}\n`, { status: 200 });
    }) as typeof fetch,
  });
  // The stale stack names the new page's origin, so only the grab-start URL can tell it apart.
  const raw = {
    framework: "react",
    componentName: "Card",
    componentStack: [
      { name: "Card", source: { debugStack: "Error\n    at Card (http://localhost:5173/chunks/card.js:1:1)" } },
      { name: "Shell", source: { fileName: "/Users/dev/app/src/Shell.tsx", lineNumber: 3 } },
    ],
    source: { debugStack: "Error\n    at Card (http://localhost:5173/chunks/card.js:1:1)" },
    tagName: "div",
    selector: "div.card",
    htmlSnippet: '<div class="card">Hi</div>',
    boundingBox: { x: 0, y: 0, width: 100, height: 50 },
    viewport: { width: 1280, height: 720, devicePixelRatio: 1 },
  };
  const base = { workspaceRoot: "/Users/dev/app", capturedAt: 1, sourceMapResolver: resolver };

  const moved = await sanitizeRawGrabPayload(raw, {
    ...base,
    id: "moved_origin",
    pageUrl: "http://localhost:5173/",
    grabPageUrl: "http://localhost:3000/dashboard",
  });
  assert.equal(moved.element.source, undefined);
  assert.deepEqual(moved.element.componentStack, [{ name: "Card" }, { name: "Shell" }]);
  assert.deepEqual(fetchedUrls, []);

  // A same-origin route change during the grab keeps the page's source hints.
  const routed = await sanitizeRawGrabPayload(raw, {
    ...base,
    id: "same_origin",
    pageUrl: "http://localhost:5173/settings",
    grabPageUrl: "http://localhost:5173/",
  });
  assert.deepEqual(routed.element.source, { filePath: "src/components/Card.tsx", line: 11, column: 5, symbolicated: true });
  assert.deepEqual(routed.element.componentStack?.[1]?.source, { filePath: "src/Shell.tsx", line: 3, symbolicated: false });
  assert.deepEqual(fetchedUrls, ["http://localhost:5173/chunks/card.js"]);
});
