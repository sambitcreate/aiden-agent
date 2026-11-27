// Installs happy-dom and the fake IPC bridge; must stay the first import.
import { installBotTestIpc } from "../main/bots/test-dom";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AppCapabilitiesProvider, DISABLED_APP_CAPABILITIES } from "../lib/app-capabilities";
import type { DesignAppsSnapshot } from "../shared/design-app";
import type { AppRouteList } from "../shared/design-canvas/app-routes";
import { emptyDesignCanvas } from "../shared/design-canvas/schema";
import { AppRoutePicker, appRoutePlacer, type AppRoutePlaceAnswer, type AppRoutesAnswer, type AppRouteSource } from "./app-route-picker";
import { resetDesignAppChipForTests } from "./design-app-chip";
import { DesignToolbar } from "./design-toolbar";

afterEach(() => {
  cleanup();
  resetDesignAppChipForTests();
});

/**
 * Retries `get` until it stops throwing, letting timers and React run between
 * tries. Assertions compare booleans and strings, never DOM nodes.
 */
async function until<T>(get: () => T, tries = 100): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return get();
    } catch (error) {
      if (attempt >= tries) throw error;
    }
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}

function list(routes: AppRouteList["routes"], source: AppRouteList["source"] = "discovered"): AppRouteList {
  return { appRoot: ".", framework: "next", source, truncated: false, routes };
}

const ROUTES = list([
  { route: "/", source: "discovered" },
  { route: "/pricing", source: "discovered" },
  { route: "/blog/[slug]", pattern: "/blog/[slug]", source: "discovered" },
  { route: "/blog/hello-world", pattern: "/blog/[slug]", source: "config" },
  { route: "/[org]/p/[id]", pattern: "/[org]/p/[id]", source: "discovered" },
]);

function fakeSource(options: { answer?: AppRoutesAnswer | ((appRoot?: string) => AppRoutesAnswer); place?: AppRoutePlaceAnswer } = {}) {
  const loads: Array<string | undefined> = [];
  const places: Array<[string, string]> = [];
  const source: AppRouteSource = {
    load: async (appRoot) => {
      loads.push(appRoot);
      const answer = options.answer ?? { apps: [{ appRoot: ".", label: "Next.js" }], appRoot: ".", list: ROUTES };
      return typeof answer === "function" ? answer(appRoot) : answer;
    },
    place: async (appRoot, route) => {
      places.push([appRoot, route]);
      return options.place ?? { placed: "frame-1", pageId: "page-1" };
    },
  };
  return { source, loads, places };
}

function Picker({ source, onClose }: { source: AppRouteSource; onClose?: () => void }) {
  return <AppRoutePicker open onOpenChange={(open) => (open ? undefined : onClose?.())} source={source} />;
}

const optionTexts = () => screen.getAllByRole("option").map((option) => option.textContent ?? "");
const filter = () => screen.getByRole("combobox", { name: "Filter routes" });
const addButton = () => screen.getByRole("button", { name: "Add" });

async function type(text: string) {
  await act(async () => {
    fireEvent.change(filter(), { target: { value: text } });
  });
}

async function key(target: HTMLElement, name: string) {
  await act(async () => {
    fireEvent.keyDown(target, { key: name });
  });
}

// ── The dialog ──

test("opening lists the app's routes, a filter narrows them, and Enter adds the active one", async () => {
  const { source, loads, places } = fakeSource();
  let closed = 0;
  render(<Picker source={source} onClose={() => (closed += 1)} />);
  await until(() => assert.deepEqual(optionTexts().slice(0, 3), ["/", "/pricing", "/blog/[slug]"]));
  assert.deepEqual(loads, [undefined]);
  await type("pri");
  assert.deepEqual(optionTexts(), ["/pricing"]);
  await key(filter(), "Enter");
  await until(() => assert.equal(closed, 1));
  assert.deepEqual(places, [[".", "/pricing"]]);
});

test("Add waits for the canvas's pending save, then places on the page on screen", async () => {
  const log: string[] = [];
  const place = appRoutePlacer({
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push("flush");
    },
    place: async (request) => {
      log.push(`place ${request.appRoot} ${request.route} ${request.pageId} ${request.viewSize?.w ?? "-"}`);
      return { placed: "f", pageId: request.pageId };
    },
    pageId: () => "page-2",
    viewSize: () => ({ w: 800, h: 600 }),
  });
  await place(".", "/pricing");
  assert.deepEqual(log, ["flush", "place . /pricing page-2 800"]);
});

test("a dynamic row takes its value, prefilled from canvas.json, and refuses an empty or unsafe one", async () => {
  const { source, places } = fakeSource();
  render(<Picker source={source} />);
  await until(() => screen.getByRole("textbox", { name: "slug" }));
  const slug = screen.getByRole("textbox", { name: "slug" }) as HTMLInputElement;
  assert.equal(slug.value, "hello-world");
  await act(async () => {
    fireEvent.focus(slug);
  });
  assert.equal(addButton().hasAttribute("disabled"), false);
  for (const bad of ["", ".."]) {
    await act(async () => {
      fireEvent.change(slug, { target: { value: bad } });
    });
    assert.equal(addButton().hasAttribute("disabled"), true, `"${bad}" disables Add`);
  }
  await act(async () => {
    fireEvent.change(slug, { target: { value: "hello-world" } });
  });
  await key(slug, "Enter");
  await until(() => assert.deepEqual(places, [[".", "/blog/hello-world"]]));
  assert.deepEqual(
    within(screen.getAllByRole("option")[4]!).getAllByRole("textbox").map((field) => field.getAttribute("aria-label")),
    ["org", "id"],
    "two parameters, two fields",
  );
});

test("a typed concrete route that isn't listed can be added; a malformed one can't", async () => {
  const { source, places } = fakeSource();
  render(<Picker source={source} />);
  await until(() => optionTexts());
  await type("/checkout?step=2");
  assert.deepEqual(optionTexts(), ["Go to /checkout?step=2"]);
  await key(filter(), "Enter");
  await until(() => assert.deepEqual(places, [[".", "/checkout?step=2"]]));
  await type("//x");
  assert.equal(screen.queryAllByRole("option").length, 0);
});

test("with two apps a root picker shows and switching it reloads the list; the source line says where routes came from", async () => {
  const { source, loads: switched } = fakeSource({
    answer: (appRoot) => ({
      apps: [{ appRoot: "apps/a", label: "a" }, { appRoot: "apps/b", label: "b" }],
      appRoot: appRoot ?? "apps/a",
      list: list([{ route: "/", source: "discovered" }], "fallback"),
    }),
  });
  render(<Picker source={source} />);
  const picker = await until(() => screen.getByRole("combobox", { name: "App" }));
  assert.ok(screen.getByText("Only / found: list routes in .aiden/canvas.json"));
  await act(async () => {
    fireEvent.keyDown(picker, { key: "Enter" });
  });
  const other = await until(() => screen.getByRole("option", { name: "b" }));
  await act(async () => {
    fireEvent.click(other);
  });
  await until(() => assert.deepEqual(switched, [undefined, "apps/b"]));

  cleanup();
  const single = fakeSource();
  render(<Picker source={single.source} />);
  await until(() => screen.getByText("From your app's files"));
  assert.equal(screen.queryByRole("combobox", { name: "App" }), null);
});

test("main's refusals show in the dialog, which stays open", async () => {
  for (const [error, copy] of [
    ["bad-route", "That address isn't a page of this app."],
    ["full", "This page is full. Remove a frame or use another page."],
  ] as const) {
    const { source } = fakeSource({ place: { error } });
    let closed = 0;
    render(<Picker source={source} onClose={() => (closed += 1)} />);
    await until(() => optionTexts());
    await key(filter(), "Enter");
    await until(() => assert.equal(screen.getByRole("alert").textContent, copy));
    assert.equal(closed, 0);
    cleanup();
  }
});

test("a route from the app's files is shown as text, never as markup", async () => {
  const { source } = fakeSource({ answer: { apps: [{ appRoot: ".", label: "App" }], appRoot: ".", list: list([{ route: "/<img src=x>", source: "config" }], "config") } });
  render(<Picker source={source} />);
  await until(() => assert.deepEqual(optionTexts(), ["/<img src=x>"]));
  assert.equal(document.querySelector("img"), null);
});

test("Escape closes the dialog without placing anything", async () => {
  const { source, places } = fakeSource();
  let closed = 0;
  render(<Picker source={source} onClose={() => (closed += 1)} />);
  await until(() => optionTexts());
  await key(filter(), "Escape");
  await until(() => assert.equal(closed, 1));
  assert.deepEqual(places, []);
});

test("a list main cut short says so, and points to typing a path or canvas.json", async () => {
  const cut = { ...list([{ route: "/", source: "discovered" }]), truncated: true };
  const { source } = fakeSource({ answer: { apps: [{ appRoot: ".", label: "App" }], appRoot: ".", list: cut } });
  render(<Picker source={source} />);
  await until(() => screen.getByText("Not every route is listed: type /path, or list routes in .aiden/canvas.json"));
  cleanup();
  render(<Picker source={fakeSource().source} />);
  await until(() => optionTexts());
  assert.equal(screen.queryByText(/Not every route is listed/u), null);
});

test("a load still reading when the dialog closes never replaces the list of the next opening", async () => {
  const apps = [{ appRoot: "apps/a", label: "a" }, { appRoot: "apps/b", label: "b" }];
  const answerFor = (appRoot: string): AppRoutesAnswer => ({ apps, appRoot, list: list([{ route: appRoot === "apps/a" ? "/from-a" : "/from-b", source: "discovered" }]) });
  let releaseB: () => void = () => undefined;
  const places: Array<[string, string]> = [];
  const source: AppRouteSource = {
    load: (appRoot) =>
      appRoot === "apps/b" ? new Promise((resolve) => (releaseB = () => resolve(answerFor("apps/b")))) : Promise.resolve(answerFor("apps/a")),
    place: async (appRoot, route) => {
      places.push([appRoot, route]);
      return { placed: "f", pageId: "p" };
    },
  };
  const view = render(<AppRoutePicker open onOpenChange={() => undefined} source={source} />);
  const picker = await until(() => screen.getByRole("combobox", { name: "App" }));
  await act(async () => {
    fireEvent.keyDown(picker, { key: "Enter" });
  });
  const b = await until(() => screen.getByRole("option", { name: "b" }));
  await act(async () => {
    fireEvent.click(b);
  });
  view.rerender(<AppRoutePicker open={false} onOpenChange={() => undefined} source={source} />);
  view.rerender(<AppRoutePicker open onOpenChange={() => undefined} source={source} />);
  await until(() => assert.deepEqual(optionTexts(), ["/from-a"]));
  await act(async () => releaseB());
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(optionTexts(), ["/from-a"]);
  await key(filter(), "Enter");
  await until(() => assert.deepEqual(places, [["apps/a", "/from-a"]]));
});

test("double-clicking inside a value field selects text there and adds nothing", async () => {
  const { source, places } = fakeSource();
  let closed = 0;
  render(<Picker source={source} onClose={() => (closed += 1)} />);
  const slug = await until(() => screen.getByRole("textbox", { name: "slug" }));
  await act(async () => {
    fireEvent.doubleClick(slug);
  });
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  assert.deepEqual(places, []);
  assert.equal(closed, 0);
});

test("a catch-all in the middle of a pattern prefills only its own segments", async () => {
  const { source, places } = fakeSource({
    answer: {
      apps: [{ appRoot: ".", label: "App" }],
      appRoot: ".",
      list: list(
        [
          { route: "/docs/[...rest]/edit", pattern: "/docs/[...rest]/edit", source: "config" },
          { route: "/docs/guide/intro/edit", pattern: "/docs/[...rest]/edit", source: "config" },
        ],
        "config",
      ),
    },
  });
  render(<Picker source={source} />);
  const rest = (await until(() => screen.getByRole("textbox", { name: "rest" }))) as HTMLInputElement;
  assert.equal(rest.value, "guide/intro");
  await key(rest, "Enter");
  await until(() => assert.deepEqual(places, [[".", "/docs/guide/intro/edit"]]));
});

test("arrow keys bring the active row into view, and a pointer passing over another row leaves the row being typed into active", async () => {
  const scrolled: string[] = [];
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.textContent ?? "");
  };
  try {
    const { source, places } = fakeSource();
    render(<Picker source={source} />);
    await until(() => optionTexts());
    await key(filter(), "ArrowDown");
    await until(() => assert.equal(scrolled[scrolled.length - 1], "/pricing"));

    const slug = screen.getByRole("textbox", { name: "slug" });
    await act(async () => {
      slug.focus();
      fireEvent.focus(slug);
    });
    const slugRow = screen.getAllByRole("option")[2]!;
    assert.equal(slugRow.getAttribute("aria-selected"), "true");
    await act(async () => {
      fireEvent.pointerMove(screen.getAllByRole("option")[0]!);
    });
    assert.equal(slugRow.getAttribute("aria-selected"), "true", "the typed-into row stays active");
    await act(async () => {
      fireEvent.click(addButton());
    });
    await until(() => assert.deepEqual(places, [[".", "/blog/hello-world"]]));
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

// ── The Add menu ──

function snapshot(overrides: Partial<DesignAppsSnapshot> = {}): DesignAppsSnapshot {
  return { workspaceId: "ws", target: "single", apps: [], candidates: [{ appRoot: ".", framework: "next", frameworkLabel: "Next.js" }], chosen: [], ...overrides };
}

function Toolbar({ designLive, source }: { designLive: boolean; source: AppRouteSource }) {
  return (
    <AppCapabilitiesProvider capabilities={{ ...DISABLED_APP_CAPABILITIES, designMode: true, designLive }}>
      <DesignToolbar
        doc={emptyDesignCanvas()}
        chatId="chat-1"
        pageId="page-1"
        tool="select"
        onToolChange={() => undefined}
        commenting={false}
        onComment={() => undefined}
        onOpenComment={() => undefined}
        canAddFiles
        onAdd={() => undefined}
        onPage={() => undefined}
        drawTool={null}
        onDraw={() => undefined}
        appRoutes={source}
      />
    </AppCapabilitiesProvider>
  );
}

async function openAdd() {
  const trigger = screen.getByRole("button", { name: "Add" });
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "Enter" });
  });
  return until(() => screen.getByRole("menu"));
}

async function addMenu(designLive: boolean, read: DesignAppsSnapshot) {
  installBotTestIpc({ "designApp:status:get": () => read });
  const fake = fakeSource();
  render(<Toolbar designLive={designLive} source={fake.source} />);
  // Let the snapshot read land.
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
  const menu = await openAdd();
  return { menu, fake };
}

const pageFromApp = (menu: HTMLElement) => within(menu).queryByRole("menuitem", { name: /Page from app…/u });

test("the Add menu offers Page from app… only with live frames, enabled when the workspace has an app", async () => {
  const off = await addMenu(false, snapshot());
  assert.deepEqual(within(off.menu).getAllByRole("menuitem").map((item) => item.textContent), ["Group", "File…", "Image…"]);
  cleanup();
  resetDesignAppChipForTests();

  for (const [name, read, enabled] of [
    ["single", snapshot(), true],
    [
      "attached only",
      snapshot({ target: "none", candidates: [], apps: [{ workspaceId: "ws", appRoot: "web", source: "attached", frameworkLabel: "App", phase: "running", since: 0, revision: 1 }] }),
      true,
    ],
    ["no app", snapshot({ target: "none", candidates: [] }), false],
    ["unavailable", snapshot({ target: "unavailable" }), false],
  ] as const) {
    const { menu } = await addMenu(true, read);
    const item = await until(() => {
      const found = pageFromApp(menu);
      assert.ok(found, name);
      if (enabled) assert.equal(found.hasAttribute("data-disabled"), false, `${name} is enabled`);
      return found;
    });
    assert.equal(item.hasAttribute("data-disabled"), !enabled, name);
    if (!enabled) assert.match(item.textContent ?? "", /No web app in this workspace/u);
    cleanup();
    resetDesignAppChipForTests();
  }
});

test("Page from app… opens the picker, and closing it returns focus to Add", async () => {
  const { menu, fake } = await addMenu(true, snapshot());
  const item = await until(() => {
    const found = pageFromApp(menu);
    assert.ok(found && !found.hasAttribute("data-disabled"));
    return found;
  });
  await act(async () => {
    fireEvent.click(item);
  });
  await until(() => assert.deepEqual(optionTexts().slice(0, 2), ["/", "/pricing"]));
  assert.deepEqual(fake.loads, [undefined]);
  await key(filter(), "Escape");
  await until(() => assert.equal(screen.queryByRole("dialog"), null));
  await until(() => assert.equal(document.activeElement?.getAttribute("aria-label"), "Add"));
  assert.deepEqual(fake.places, []);
});
