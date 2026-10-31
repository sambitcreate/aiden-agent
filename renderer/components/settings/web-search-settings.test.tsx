import "../../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  installBotTestIpc,
  type BotTestIpcCall,
} from "../../main/bots/test-dom";
import { mountWithBotRouter } from "../../main/bots/test-providers";
import {
  AppCapabilitiesProvider,
  DISABLED_APP_CAPABILITIES,
} from "../../lib/app-capabilities";
import type {
  BoundedNonSecretProviderConfig,
  WebSearchProviderId,
  WebSearchProviderRendererMetadata,
  WebSearchRendererSnapshot,
  WebSearchRouteEntry,
  WebSearchSelection,
} from "../../lib/types";
import { WebSearchSettings } from "./web-search-settings";

afterEach(() => {
  cleanup();
});

// Radix Select measures and scrolls its viewport; happy-dom has no layout.
const elementProto = Element.prototype as unknown as Record<string, unknown>;
elementProto.scrollIntoView ??= () => {};
elementProto.hasPointerCapture ??= () => false;
elementProto.releasePointerCapture ??= () => {};

type Provider = WebSearchProviderRendererMetadata;
type ExistingAuth = WebSearchRendererSnapshot["existingAuth"];

function provider(
  overrides: Partial<Provider> & Pick<Provider, "id" | "label">,
): Provider {
  return {
    description: `${overrides.label} search.`,
    credentialKind: "none",
    costClass: "provider-free",
    capabilities: ["search"],
    privacyUrl: `https://${overrides.id}.example/privacy`,
    termsUrl: `https://${overrides.id}.example/terms`,
    adapterVersion: 1,
    releaseState: "shipped",
    explicitOnly: false,
    automaticByDefault: false,
    configurationStatus: "not-required",
    ready: true,
    configuredCredentialModes: [],
    ...overrides,
  };
}

const EXA = provider({
  id: "exa",
  label: "Exa",
  costClass: "built-in-free",
  automaticByDefault: true,
});
const BRAVE = provider({
  id: "brave",
  label: "Brave Search",
  credentialKind: "api-key",
  costClass: "paid",
  configurationStatus: "configured",
  configuredCredentialModes: ["api-key"],
});
const SERPER = provider({
  id: "serper",
  label: "Serper",
  credentialKind: "api-key",
  costClass: "quota",
  configurationStatus: "needs-setup",
  ready: false,
});
const DUCKDUCKGO = provider({ id: "duckduckgo", label: "DuckDuckGo" });
const JINA = provider({
  id: "jina",
  label: "Jina",
  credentialKind: "optional-api-key",
  costClass: "provider-free",
});
const SEARXNG = provider({
  id: "searxng",
  label: "SearXNG",
  credentialKind: "endpoint",
  costClass: "self-hosted",
  configurationStatus: "needs-setup",
  ready: false,
});
const OPENAI = provider({
  id: "openai",
  label: "OpenAI",
  credentialKind: "api-key",
  costClass: "quota",
  capabilities: ["search", "existing-provider-auth"],
  configurationStatus: "needs-setup",
  ready: false,
});
const KAGI_EXPERIMENTAL = provider({
  id: "kagi",
  label: "Kagi Experimental",
  releaseState: "experimental",
});

const DEFAULT_PROVIDERS = [
  EXA,
  BRAVE,
  SERPER,
  DUCKDUCKGO,
  JINA,
  SEARXNG,
  OPENAI,
  KAGI_EXPERIMENTAL,
];
const DEFAULT_FALLBACK: Extract<
  WebSearchSelection,
  { mode: "automatic" }
>["fallbackOn"] = ["transient", "quota"];

const NOT_CONSENTED: ExistingAuth = {
  options: [],
  status: {
    targetProviderId: "openai",
    state: "not-consented",
    configured: false,
  },
};

interface ServerOptions {
  providers?: Provider[];
  selection?: WebSearchSelection;
  enabled?: boolean;
  existingAuth?: ExistingAuth;
  fail?: Partial<Record<string, string>>;
  getFails?: number;
}

/**
 * An in-memory main process for the generic Web Search IPC seam. It keeps
 * only what the real main process projects to the renderer: secrets passed
 * to `setCredential` are recorded as presence, never stored.
 */
function webSearchServer(options: ServerOptions = {}) {
  let providers = (options.providers ?? DEFAULT_PROVIDERS).map((entry) => ({
    ...entry,
  }));
  let selection: WebSearchSelection = options.selection ?? {
    mode: "automatic",
    route: [
      { providerId: "exa", credentialMode: "anonymous" },
      { providerId: "brave", credentialMode: "api-key" },
    ],
    fallbackOn: [...DEFAULT_FALLBACK],
  };
  let enabled = options.enabled ?? true;
  let existingAuth = options.existingAuth ?? NOT_CONSENTED;
  const providerConfig: Partial<
    Record<WebSearchProviderId, BoundedNonSecretProviderConfig>
  > = {};
  let getFailures = options.getFails ?? 0;

  const route = (): WebSearchRouteEntry[] =>
    selection.mode === "automatic"
      ? selection.route
      : [
          {
            providerId: selection.providerId,
            credentialMode: selection.credentialMode ?? "anonymous",
          },
        ];

  const snapshot = (): WebSearchRendererSnapshot =>
    structuredClone({
      settings: { version: 2, enabled, selection, providerConfig },
      providers,
      selection,
      route: route(),
      routeReadiness: route().map((entry) => {
        const match = providers.find(
          (candidate) => candidate.id === entry.providerId,
        );
        return {
          providerId: entry.providerId,
          ready: match?.ready ?? false,
          configurationStatus: match?.configurationStatus ?? "invalid",
        };
      }),
      existingAuth,
    });

  const guard = (channel: string) => {
    const message = options.fail?.[channel];
    if (message) throw new Error(message);
  };
  const updateProvider = (id: string, patch: Partial<Provider>) => {
    providers = providers.map((entry) =>
      entry.id === id ? { ...entry, ...patch } : entry,
    );
  };

  const calls = installBotTestIpc({
    "webSearch:get": () => {
      if (getFailures > 0) {
        getFailures -= 1;
        throw new Error("catalog unreadable");
      }
      return snapshot();
    },
    "webSearch:setEnabled": (next: unknown) => {
      guard("webSearch:setEnabled");
      enabled = next as boolean;
      return snapshot();
    },
    "webSearch:setSelection": (next: unknown) => {
      guard("webSearch:setSelection");
      selection = next as WebSearchSelection;
      return snapshot();
    },
    "webSearch:setAutomaticRoute": (next: unknown) => {
      guard("webSearch:setAutomaticRoute");
      selection = {
        mode: "automatic",
        route: next as WebSearchRouteEntry[],
        fallbackOn:
          selection.mode === "automatic"
            ? selection.fallbackOn
            : [...DEFAULT_FALLBACK],
      };
      return snapshot();
    },
    "webSearch:setProviderConfig": (id: unknown, config: unknown) => {
      guard("webSearch:setProviderConfig");
      providerConfig[id as WebSearchProviderId] =
        config as BoundedNonSecretProviderConfig;
      updateProvider(id as string, {
        configurationStatus: "configured",
        ready: true,
      });
      return snapshot();
    },
    "webSearch:setCredential": (id: unknown) => {
      guard("webSearch:setCredential");
      updateProvider(id as string, {
        configurationStatus: "configured",
        ready: true,
        configuredCredentialModes: ["api-key"],
      });
      return snapshot();
    },
    "webSearch:removeCredential": (id: unknown) => {
      guard("webSearch:removeCredential");
      updateProvider(id as string, {
        configurationStatus: "needs-setup",
        ready: false,
        configuredCredentialModes: [],
      });
      return snapshot();
    },
    "webSearch:existingAuth:consent": (request: unknown) => {
      guard("webSearch:existingAuth:consent");
      const { modelId } = request as { modelId: string };
      existingAuth = {
        ...existingAuth,
        status: {
          targetProviderId: "openai",
          state: "ready",
          configured: true,
          sourceProviderId: "openai",
          modelId,
        },
      };
      return snapshot();
    },
    "webSearch:existingAuth:revoke": () => {
      guard("webSearch:existingAuth:revoke");
      existingAuth = {
        ...existingAuth,
        status: {
          targetProviderId: "openai",
          state: "not-consented",
          configured: false,
        },
      };
      return snapshot();
    },
  });

  return {
    calls,
    callsTo: (channel: string) =>
      calls.filter((call) => call.channel === channel),
    /** Web Search writes; app-shell reads made by the test harness are ignored. */
    mutations: () =>
      calls.filter(
        (call) =>
          call.channel.startsWith("webSearch:") &&
          call.channel !== "webSearch:get" &&
          call.channel !== "webSearch:pages:get",
      ),
  };
}

async function mountSettings(options: { bots?: boolean } = {}) {
  const capabilities = {
    ...DISABLED_APP_CAPABILITIES,
    bots: options.bots ?? false,
  };
  return mountWithBotRouter(
    <AppCapabilitiesProvider capabilities={capabilities}>
      <WebSearchSettings />
    </AppCapabilitiesProvider>,
    { initialPath: "/settings" },
  );
}

function argsOf(calls: BotTestIpcCall[]): unknown[][] {
  return calls.map((call) => call.args);
}

async function openRoutingOptions() {
  fireEvent.click(
    await screen.findByRole("button", { name: /Routing options/u }),
  );
}

async function openProviderBrowser() {
  fireEvent.click(
    await screen.findByRole("button", { name: /^Browse providers/u }),
  );
  await screen.findByRole("heading", { name: "Browse providers" });
}

async function openProviderSetup(label: string) {
  await openProviderBrowser();
  const search = screen.getByRole("searchbox", {
    name: "Search shipped Web Search providers",
  });
  fireEvent.change(search, { target: { value: label } });
  const row = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.getAttribute("data-provider-id") !== null &&
        within(button).queryByText(label) !== null,
    );
  assert.ok(row, `provider row for ${label}`);
  fireEvent.click(row);
  await screen.findByRole("heading", { level: 1, name: label });
  fireEvent.click(
    screen.getByRole("button", { name: /^(Configure|Manage)$/u }),
  );
  return screen.findByRole("dialog", { name: `Set up ${label}` });
}

function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
}

/** Every rendered character and attribute value in the document. */
function renderedSurface(): string {
  const attributes = [...document.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].map((attribute) => attribute.value),
  );
  const values = [...document.querySelectorAll("input, textarea")].map(
    (element) => (element as HTMLInputElement).value,
  );
  return [document.body.textContent ?? "", ...attributes, ...values].join("\n");
}

test("settings read only the generic Web Search IPC seam and list only shipped providers", async () => {
  const server = webSearchServer();
  await mountSettings();
  await screen.findByRole("heading", { name: "Web Search" });

  assert.equal(server.calls[0]?.channel, "webSearch:get");
  await openProviderBrowser();
  for (const label of [
    "Exa",
    "Brave Search",
    "Serper",
    "DuckDuckGo",
    "Jina",
    "SearXNG",
    "OpenAI",
  ]) {
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: label },
    });
    assert.ok(
      screen.queryAllByText(label).length > 0,
      `${label} should be listed`,
    );
  }
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Kagi" },
  });
  assert.equal(screen.queryByText("Kagi Experimental"), null);
  assert.ok(screen.getByText("No shipped providers match"));
  assert.deepEqual(
    server.calls.filter((call) => call.channel.startsWith("exa:")),
    [],
    "the legacy Exa-only channels are not used",
  );
});

test("a failed catalog read shows a request-free error with a working retry", async () => {
  const server = webSearchServer({ getFails: 1 });
  await mountSettings();
  const alert = await screen.findByRole("alert");
  assert.match(alert.textContent ?? "", /Web Search settings are unavailable/u);
  assert.match(alert.textContent ?? "", /No provider was contacted/u);

  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "Web Search" });
  assert.equal(server.callsTo("webSearch:get").length, 2);
});

test("the overview keeps enablement, recipients, readiness, and cost visible", async () => {
  const server = webSearchServer();
  await mountSettings();

  const toggle = await screen.findByRole("switch", {
    name: "Allow Web Search",
  });
  assert.equal(toggle.getAttribute("aria-checked"), "true");
  const description = document.getElementById(
    toggle.getAttribute("aria-describedby") ?? "",
  );
  assert.match(
    description?.textContent ?? "",
    /No startup or background search occurs/u,
  );

  const setup = screen.getByRole("region", { name: "Current search setup" });
  assert.match(setup.textContent ?? "", /Available/u);
  assert.match(setup.textContent ?? "", /2\/2 ready/u);
  assert.match(setup.textContent ?? "", /Exa → Brave Search/u);
  assert.match(
    setup.textContent ?? "",
    /May use provider quota or paid usage/u,
  );
  assert.match(
    setup.textContent ?? "",
    /sent sequentially to Exa, Brave Search; Aiden never fans out/u,
  );
  assert.equal(within(setup).queryByRole("alert"), null);

  fireEvent.click(toggle);
  await waitFor(() =>
    assert.match(
      screen.getByRole("status").textContent ?? "",
      /Web Search is off/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:setEnabled")), [[false]]);
  assert.match(
    screen.getByRole("status").textContent ?? "",
    /route and credentials are preserved/u,
  );
  assert.equal(
    screen
      .getByRole("switch", { name: "Allow Web Search" })
      .getAttribute("aria-checked"),
    "false",
  );
  assert.match(
    screen.getByRole("region", { name: "Current search setup" }).textContent ??
      "",
    /Turned off/u,
  );
});

test("a single-destination free route names its only recipient", async () => {
  webSearchServer({
    selection: {
      mode: "automatic",
      route: [{ providerId: "exa", credentialMode: "anonymous" }],
      fallbackOn: [...DEFAULT_FALLBACK],
    },
  });
  await mountSettings();
  const setup = await screen.findByRole("region", {
    name: "Current search setup",
  });
  assert.match(setup.textContent ?? "", /Free route/u);
  assert.match(
    setup.textContent ?? "",
    /may be sent to Exa only when search is used/u,
  );
});

test("a route with no ready destination raises a fail-closed alert", async () => {
  webSearchServer({
    selection: {
      mode: "fixed",
      providerId: "serper",
      credentialMode: "api-key",
    },
  });
  await mountSettings();
  const setup = await screen.findByRole("region", {
    name: "Current search setup",
  });
  const alert = within(setup).getByRole("alert");
  assert.match(alert.textContent ?? "", /No listed provider is ready/u);
  assert.match(alert.textContent ?? "", /Searches fail closed/u);
  assert.match(setup.textContent ?? "", /0\/1 ready/u);
});

test("routing options are a disclosure that switches between automatic and fixed policies", async () => {
  const server = webSearchServer();
  await mountSettings();

  const disclosure = await screen.findByRole("button", {
    name: /Routing options/u,
  });
  assert.equal(disclosure.getAttribute("aria-expanded"), "false");
  const controlsId = disclosure.getAttribute("aria-controls") ?? "";
  assert.equal(document.getElementById(controlsId), null);
  assert.equal(
    screen.queryByRole("radiogroup", { name: "Web Search routing policy" }),
    null,
  );

  fireEvent.click(disclosure);
  assert.equal(disclosure.getAttribute("aria-expanded"), "true");
  const region = document.getElementById(controlsId);
  assert.ok(region);
  const policy = within(region).getByRole("radiogroup", {
    name: "Web Search routing policy",
  });
  const automatic = within(policy).getByRole("radio", { name: /Automatic/u });
  const fixed = within(policy).getByRole("radio", { name: /Fixed provider/u });
  assert.equal(automatic.getAttribute("aria-checked"), "true");
  assert.equal(fixed.getAttribute("aria-checked"), "false");

  fireEvent.click(fixed);
  await waitFor(() =>
    assert.match(
      screen.getByRole("status").textContent ?? "",
      /Fixed mode never falls back/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:setSelection")), [
    [{ mode: "fixed", providerId: "exa", credentialMode: "anonymous" }],
  ]);
  const fixedSelect = screen.getByRole("combobox", {
    name: "Fixed Web Search provider",
  });
  assert.match(fixedSelect.textContent ?? "", /Exa/u);
  assert.equal(
    screen.queryByRole("list", { name: "Ordered automatic Web Search route" }),
    null,
  );

  fireEvent.click(screen.getByRole("radio", { name: /Automatic/u }));
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:setSelection").length, 2),
  );
  const [automaticSelection] = server.callsTo("webSearch:setSelection")[1]!
    .args as [WebSearchSelection];
  assert.equal(automaticSelection.mode, "automatic");
  assert.ok(
    automaticSelection.mode === "automatic" &&
      automaticSelection.fallbackOn.length > 0,
    "switching back to automatic restores disclosed fallback categories",
  );
  await screen.findByRole("list", {
    name: "Ordered automatic Web Search route",
  });
});

test("the automatic route is an ordered list that reorders by button and Alt+Arrow", async () => {
  const server = webSearchServer();
  await mountSettings();
  await openRoutingOptions();

  const list = await screen.findByRole("list", {
    name: "Ordered automatic Web Search route",
  });
  const items = within(list).getAllByRole("listitem");
  assert.deepEqual(
    items.map((item) => [
      item.getAttribute("aria-posinset"),
      item.getAttribute("aria-setsize"),
    ]),
    [
      ["1", "2"],
      ["2", "2"],
    ],
  );
  assert.equal(
    (
      within(list).getByRole("button", {
        name: "Move Exa up",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );
  assert.equal(
    (
      within(list).getByRole("button", {
        name: "Move Brave Search down",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );

  fireEvent.click(
    within(list).getByRole("button", { name: "Move Brave Search up" }),
  );
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:setAutomaticRoute").length, 1),
  );
  assert.deepEqual(server.callsTo("webSearch:setAutomaticRoute")[0]!.args[0], [
    { providerId: "brave", credentialMode: "api-key" },
    { providerId: "exa", credentialMode: "anonymous" },
  ]);
  await waitFor(() =>
    assert.match(
      within(list).getAllByRole("listitem")[0]!.textContent ?? "",
      /Brave Search/u,
    ),
  );

  // A plain arrow key is left for scrolling; only Alt+Arrow moves an entry.
  const first = within(list).getAllByRole("listitem")[0]!;
  fireEvent.keyDown(first, { key: "ArrowDown" });
  assert.equal(server.callsTo("webSearch:setAutomaticRoute").length, 1);
  fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:setAutomaticRoute").length, 2),
  );
  assert.deepEqual(server.callsTo("webSearch:setAutomaticRoute")[1]!.args[0], [
    { providerId: "exa", credentialMode: "anonymous" },
    { providerId: "brave", credentialMode: "api-key" },
  ]);

  const fallback = screen.getByText("Fallback conditions").closest("details");
  assert.ok(fallback);
  assert.match(fallback.textContent ?? "", /Temporary provider error/u);
  assert.match(fallback.textContent ?? "", /Quota or rate limit/u);
});

test("removing a route entry keeps at least one destination", async () => {
  const server = webSearchServer();
  await mountSettings();
  await openRoutingOptions();
  const list = await screen.findByRole("list", {
    name: "Ordered automatic Web Search route",
  });

  fireEvent.click(
    within(list).getByRole("button", {
      name: "Remove Exa from automatic route",
    }),
  );
  await waitFor(() =>
    assert.match(
      screen.getByRole("status").textContent ?? "",
      /Exa removed from the automatic route/u,
    ),
  );
  assert.deepEqual(server.callsTo("webSearch:setAutomaticRoute")[0]!.args[0], [
    { providerId: "brave", credentialMode: "api-key" },
  ]);
  const remove = within(list).getByRole("button", {
    name: "Remove Brave Search from automatic route",
  }) as HTMLButtonElement;
  assert.equal(remove.disabled, true);
});

test("a failed route save shows a dismissible alert and keeps the routing editor open", async () => {
  webSearchServer({
    fail: { "webSearch:setAutomaticRoute": "Route store is read-only." },
  });
  await mountSettings();
  await openRoutingOptions();
  const list = await screen.findByRole("list", {
    name: "Ordered automatic Web Search route",
  });

  fireEvent.click(
    within(list).getByRole("button", { name: "Move Brave Search up" }),
  );
  const alert = await screen.findByText("Route store is read-only.");
  assert.ok(alert.closest("[role=alert]"));
  assert.ok(
    screen.getByRole("list", { name: "Ordered automatic Web Search route" }),
  );
  assert.match(
    within(list).getAllByRole("listitem")[0]!.textContent ?? "",
    /Exa/u,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss Web Search error" }),
  );
  assert.equal(screen.queryByText("Route store is read-only."), null);
});

test("the add-to-route menu labels each provider's cost and appends the choice", async () => {
  const server = webSearchServer();
  await mountSettings();
  await openRoutingOptions();

  openSelect(
    await screen.findByRole("combobox", {
      name: "Add provider to automatic route",
    }),
  );
  const listbox = await screen.findByRole("listbox");
  const options = within(listbox).getAllByRole("option");
  const text = (label: string) =>
    options.find((option) => option.textContent?.startsWith(label))
      ?.textContent ?? "";
  assert.match(text("Serper"), /Quota-based/u);
  assert.match(text("DuckDuckGo"), /Provider free/u);
  assert.match(text("SearXNG"), /Self-hosted/u);
  assert.equal(
    text("Exa"),
    "",
    "providers already in the route are not offered again",
  );
  assert.equal(text("Kagi"), "", "experimental providers are not offered");

  const duck = options.find((option) =>
    option.textContent?.startsWith("DuckDuckGo"),
  );
  assert.ok(duck);
  fireEvent.keyDown(duck, { key: "Enter" });
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:setAutomaticRoute").length, 1),
  );
  assert.deepEqual(server.callsTo("webSearch:setAutomaticRoute")[0]!.args[0], [
    { providerId: "exa", credentialMode: "anonymous" },
    { providerId: "brave", credentialMode: "api-key" },
    { providerId: "duckduckgo", credentialMode: "anonymous" },
  ]);
});

test("the provider catalog searches, filters, discloses more providers, and restores focus", async () => {
  webSearchServer();
  await mountSettings();
  await openProviderBrowser();
  await waitFor(() =>
    assert.equal(
      document.activeElement,
      screen.getByRole("heading", { name: "Browse providers" }),
    ),
  );

  // Built-in and connected providers are shown; the rest wait behind a disclosure.
  assert.ok(screen.getByRole("region", { name: /Built in/u }));
  assert.ok(screen.getByRole("region", { name: /Connected/u }));
  assert.equal(screen.queryByText("Serper"), null);
  const more = screen.getByRole("button", { name: "Show 5 more providers" });
  assert.equal(more.getAttribute("aria-expanded"), "false");
  fireEvent.click(more);
  assert.equal(more.getAttribute("aria-expanded"), "true");
  const moreRegion = document.getElementById(
    more.getAttribute("aria-controls") ?? "",
  );
  assert.ok(moreRegion && within(moreRegion).getByText("Serper"));

  const filters = screen.getByRole("group", { name: "Filter providers" });
  assert.deepEqual(
    within(filters)
      .getAllByRole("button")
      .map((button) => button.textContent),
    ["All", "Free", "Connected", "API key", "Existing account", "Self-hosted"],
  );
  fireEvent.click(within(filters).getByRole("button", { name: "Self-hosted" }));
  assert.equal(
    within(filters)
      .getByRole("button", { name: "Self-hosted" })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.ok(screen.getByText("SearXNG"));
  assert.equal(screen.queryByText("Exa"), null);
  assert.match(
    screen.getByText(/shipped provider/u).textContent ?? "",
    /^1 shipped provider ·/u,
  );

  const search = screen.getByRole("searchbox", {
    name: "Search shipped Web Search providers",
  });
  fireEvent.change(search, { target: { value: "no such provider" } });
  assert.ok(screen.getByText("No shipped providers match"));
  fireEvent.click(
    screen.getByRole("button", { name: "Clear search and filters" }),
  );
  assert.equal((search as HTMLInputElement).value, "");
  assert.equal(
    within(filters)
      .getByRole("button", { name: "All" })
      .getAttribute("aria-pressed"),
    "true",
  );

  // Escape clears a query first, then leaves the catalog.
  fireEvent.change(search, { target: { value: "brave" } });
  fireEvent.keyDown(search, { key: "Escape" });
  assert.equal((search as HTMLInputElement).value, "");
  fireEvent.keyDown(search, { key: "Escape" });
  await screen.findByRole("heading", { name: "Web Search" });
  await waitFor(() =>
    assert.equal(
      document.activeElement,
      screen.getByRole("button", { name: /^Browse providers/u }),
    ),
  );

  await openProviderBrowser();
  fireEvent.click(screen.getByRole("button", { name: "Back to Web Search" }));
  await screen.findByRole("switch", { name: "Allow Web Search" });
});

test("a provider's detail page links privacy and terms safely and adds it to the route", async () => {
  const server = webSearchServer();
  await mountSettings();
  await openProviderBrowser();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "duck" },
  });
  fireEvent.click(screen.getByText("DuckDuckGo").closest("button")!);
  await screen.findByRole("heading", { level: 1, name: "DuckDuckGo" });

  for (const [name, href] of [
    ["Privacy", DUCKDUCKGO.privacyUrl],
    ["Terms", DUCKDUCKGO.termsUrl],
  ] as const) {
    const link = screen.getByRole("link", { name });
    assert.equal(link.getAttribute("href"), href);
    assert.equal(link.getAttribute("target"), "_blank");
    assert.match(link.getAttribute("rel") ?? "", /noreferrer/u);
  }

  fireEvent.click(screen.getByRole("button", { name: "Add to route" }));
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:setAutomaticRoute").length, 1),
  );
  const route = server.callsTo("webSearch:setAutomaticRoute")[0]!
    .args[0] as WebSearchRouteEntry[];
  assert.deepEqual(route[route.length - 1], {
    providerId: "duckduckgo",
    credentialMode: "anonymous",
  });
  await screen.findByRole("button", { name: "In route" });

  fireEvent.click(screen.getByRole("button", { name: "All providers" }));
  await screen.findByRole("heading", { name: "Browse providers" });
});

test("provider setup keeps API keys write-only and never selects the provider", async () => {
  const SECRET = "sk-test-SENTINEL-4f1e9c";
  const server = webSearchServer();
  await mountSettings();
  const dialog = await openProviderSetup("Serper");
  assert.match(dialog.textContent ?? "", /Setup performs no network request/u);
  assert.equal(within(dialog).queryByRole("radiogroup"), null);

  const input = within(dialog).getByLabelText(
    "Serper API key",
  ) as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.getAttribute("autocomplete"), "new-password");
  const save = within(dialog).getByRole("button", {
    name: "Save key",
  }) as HTMLButtonElement;
  assert.equal(save.disabled, true);
  assert.equal(
    (
      within(dialog).getByRole("button", {
        name: "Remove saved key",
      }) as HTMLButtonElement
    ).disabled,
    true,
  );

  fireEvent.change(input, { target: { value: `  ${SECRET}  ` } });
  fireEvent.click(save);
  await waitFor(() =>
    assert.match(
      within(dialog).getByRole("status").textContent ?? "",
      /API key saved/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:setCredential")), [
    ["serper", SECRET],
  ]);
  assert.deepEqual(
    server
      .mutations()
      .map((call) => call.channel)
      .filter((channel) => channel !== "webSearch:setCredential"),
    [],
    "saving a key does not touch route, selection, or enablement",
  );
  assert.equal(
    renderedSurface().includes(SECRET),
    false,
    "the saved key is not echoed",
  );
  assert.match(dialog.textContent ?? "", /Keys are write-only/u);

  const remove = within(dialog).getByRole("button", {
    name: "Remove saved key",
  });
  assert.ok(within(dialog).getByRole("button", { name: "Replace key" }));
  fireEvent.click(remove);
  await waitFor(() =>
    assert.match(
      within(dialog).getByRole("status").textContent ?? "",
      /API key removed/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:removeCredential")), [
    ["serper"],
  ]);
});

test("a failed credential save is announced as an alert without echoing the key", async () => {
  const SECRET = "sk-test-SENTINEL-failing-77a";
  webSearchServer({
    fail: { "webSearch:setCredential": "Keychain is locked." },
  });
  await mountSettings();
  const dialog = await openProviderSetup("Serper");
  fireEvent.change(within(dialog).getByLabelText("Serper API key"), {
    target: { value: SECRET },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));
  const alert = await within(dialog).findByRole("alert");
  assert.match(alert.textContent ?? "", /Keychain is locked/u);
  assert.equal(alert.getAttribute("aria-live"), "assertive");
  assert.equal(document.body.textContent?.includes(SECRET), false);
});

test("an optional-key provider asks for a connection method before showing the key field", async () => {
  const server = webSearchServer();
  await mountSettings();
  const dialog = await openProviderSetup("Jina");
  const method = within(dialog).getByRole("radiogroup", {
    name: "Jina connection method",
  });
  assert.equal(
    within(method)
      .getByRole("radio", { name: /Built-in free route/u })
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(within(dialog).queryByLabelText("Jina API key"), null);

  fireEvent.click(
    within(method).getByRole("radio", { name: /Use my API key/u }),
  );
  assert.ok(await within(dialog).findByLabelText("Jina API key"));
  assert.deepEqual(
    server.mutations(),
    [],
    "choosing a method does not change the route",
  );
});

test("self-hosted setup saves only the non-secret endpoint through provider settings", async () => {
  const server = webSearchServer();
  await mountSettings();
  const dialog = await openProviderSetup("SearXNG");
  const confirm = within(dialog).getByRole("button", {
    name: "Save provider settings",
  }) as HTMLButtonElement;
  assert.equal(confirm.disabled, true);

  fireEvent.change(within(dialog).getByLabelText("SearXNG endpoint"), {
    target: { value: " https://search.local.test " },
  });
  assert.equal(confirm.disabled, false);
  fireEvent.click(confirm);
  await waitFor(() =>
    assert.match(
      within(dialog).getByRole("status").textContent ?? "",
      /does not send a test request/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:setProviderConfig")), [
    ["searxng", { endpoint: "https://search.local.test" }],
  ]);
});

test("OpenAI saved-account reuse is an explicit, separate, redacted consent path", async () => {
  const FINGERPRINT = "fp-SENTINEL-credential-91b";
  const existingAuth = {
    options: [
      {
        sourceProviderId: "openai",
        label: "OpenAI",
        authKind: "api-key",
        available: true,
        models: [{ id: "gpt-search-test", label: "GPT Search Test" }],
        credentialFingerprint: FINGERPRINT,
      },
    ],
    status: {
      targetProviderId: "openai",
      state: "not-consented",
      configured: false,
      codexAccessToken: FINGERPRINT,
    },
  } as unknown as ExistingAuth;
  const server = webSearchServer({ existingAuth });
  await mountSettings();
  const dialog = await openProviderSetup("OpenAI");

  const method = within(dialog).getByRole("radiogroup", {
    name: "OpenAI connection method",
  });
  assert.equal(
    within(method)
      .getByRole("radio", { name: /Use my API key/u })
      .getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    within(dialog).queryByRole("button", { name: /Approve/u }),
    null,
  );

  fireEvent.click(
    within(method).getByRole("radio", { name: /Use approved OpenAI account/u }),
  );
  const approve = await within(dialog).findByRole("button", {
    name: "Approve for Web Search",
  });
  assert.equal(within(dialog).queryByLabelText("OpenAI API key"), null);
  assert.match(dialog.textContent ?? "", /OpenAI API quota and billing/u);
  assert.match(dialog.textContent ?? "", /does not send a request/u);
  assert.match(
    within(dialog).getByRole("combobox", { name: "OpenAI Web Search model" })
      .textContent ?? "",
    /GPT Search Test/u,
  );

  fireEvent.click(approve);
  await waitFor(() =>
    assert.match(
      within(dialog).getByRole("status").textContent ?? "",
      /Route selection is unchanged/u,
    ),
  );
  assert.deepEqual(argsOf(server.callsTo("webSearch:existingAuth:consent")), [
    [
      {
        targetProviderId: "openai",
        sourceProviderId: "openai",
        modelId: "gpt-search-test",
        consent: true,
      },
    ],
  ]);
  assert.deepEqual(
    server.mutations().map((call) => call.channel),
    ["webSearch:existingAuth:consent"],
  );

  const revoke = await within(dialog).findByRole("button", {
    name: "Revoke approval",
  });
  assert.match(dialog.textContent ?? "", /Model: gpt-search-test/u);
  fireEvent.click(revoke);
  await waitFor(() =>
    assert.equal(server.callsTo("webSearch:existingAuth:revoke").length, 1),
  );
  assert.equal(renderedSurface().includes(FINGERPRINT), false);
});

test("OpenAI account approval explains when no saved key exists and offers no approve action", async () => {
  webSearchServer({
    selection: {
      mode: "fixed",
      providerId: "openai",
      credentialMode: "existing-provider-auth",
    },
    existingAuth: {
      options: [
        {
          sourceProviderId: "openai",
          label: "OpenAI",
          authKind: "api-key",
          available: false,
          models: [],
        },
      ],
      status: {
        targetProviderId: "openai",
        state: "not-consented",
        configured: false,
      },
    },
  });
  await mountSettings();
  const dialog = await openProviderSetup("OpenAI");
  assert.match(
    dialog.textContent ?? "",
    /No saved OpenAI API key is available/u,
  );
  assert.equal(
    within(dialog).queryByRole("button", { name: /Approve/u }),
    null,
  );
  assert.equal(
    within(dialog)
      .getByRole("radio", { name: /Use approved OpenAI account/u })
      .hasAttribute("disabled"),
    true,
  );
});

test("privacy copy links to Bot and schedule grants without granting access", async () => {
  const server = webSearchServer();
  const { router } = await mountSettings({ bots: true });
  const privacy = await screen.findByRole("region", {
    name: "Privacy and access",
  });
  assert.match(
    privacy.textContent ?? "",
    /Bots and schedules still require their own explicit/u,
  );

  fireEvent.click(
    within(privacy).getByRole("button", { name: "Manage Bot grants" }),
  );
  await waitFor(() => assert.equal(router.state.location.pathname, "/bots"));
  assert.deepEqual(server.mutations(), []);

  await act(async () => {
    await router.navigate({ to: "/settings" });
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage schedule grants" }),
  );
  await waitFor(() =>
    assert.equal(router.state.location.pathname, "/scheduled"),
  );
});

test("without Bots, privacy copy and actions mention only schedules", async () => {
  webSearchServer();
  await mountSettings({ bots: false });
  const privacy = await screen.findByRole("region", {
    name: "Privacy and access",
  });
  assert.equal(
    within(privacy).queryByRole("button", { name: "Manage Bot grants" }),
    null,
  );
  assert.ok(
    within(privacy).getByRole("button", { name: "Manage schedule grants" }),
  );
  assert.doesNotMatch(privacy.textContent ?? "", /Bots/u);
});
