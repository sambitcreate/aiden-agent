// Design canvas document parser: the bounds and refusals every reader and
// writer of `design-canvases/<workspaceId>.json` relies on.

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DesignCanvas,
  DESIGN_CANVAS_LIMITS,
  emptyDesignCanvas,
  isDesignRelativePath,
  parseDesignCanvas,
} from "./schema.js";

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f1",
    kind: "note",
    title: "Note",
    x: 0,
    y: 0,
    w: 200,
    h: 120,
    text: "hello",
    createdBy: "person",
    ...overrides,
  };
}

function canvas(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 3,
    revision: 3,
    pages: [{ id: "page-1", name: "Page 1" }],
    chatPages: {},
    frames: [],
    comments: [],
    ...overrides,
  };
}

function parsed(value: unknown): { doc: DesignCanvas; dropped: number } {
  const result = parseDesignCanvas(value);
  assert.equal(result.ok, true, result.ok ? "" : result.issues.join("; "));
  if (!result.ok) throw new Error("unreachable");
  return { doc: result.doc, dropped: result.dropped };
}

test("an empty canvas parses with nothing dropped", () => {
  const empty = emptyDesignCanvas();
  assert.equal(empty.revision, 0);
  assert.equal(empty.version, 3);
  assert.deepEqual(empty.pages, [{ id: "page-1", name: "Page 1" }]);
  assert.deepEqual(empty.chatPages, {});
  const { doc, dropped } = parsed(empty);
  assert.equal(dropped, 0);
  assert.deepEqual(doc, empty);
});

test("a frame of an unknown kind is dropped and counted", () => {
  const { doc, dropped } = parsed(
    canvas({ frames: [frame({ id: "a", kind: "page" }), frame({ id: "b" })] }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => entry.id),
    ["b"],
  );
  assert.equal(dropped, 1);
});

test("sizes clamp to 40..8000 and coordinates to +-1,000,000", () => {
  const { doc } = parsed(
    canvas({
      frames: [frame({ id: "small", w: 5, h: 5 }), frame({ id: "big", w: 99999, x: 5e9, y: -5e9 })],
    }),
  );
  const [small, big] = doc.frames;
  assert.equal(small?.w, 40);
  assert.equal(small?.h, 40);
  assert.equal(big?.w, 8000);
  assert.equal(big?.x, 1_000_000);
  assert.equal(big?.y, -1_000_000);
});

test("file frames whose path escapes the workspace or names a hidden file are dropped", () => {
  const unsafe = [
    "../a.html",
    "/abs.html",
    ".git/config",
    "design/.env",
    "a\\b.html",
    "a\u0000.html",
  ];
  const { doc, dropped } = parsed(
    canvas({
      frames: [
        ...unsafe.map((path, index) => frame({ id: `bad${index}`, kind: "file", path })),
        frame({ id: "good", kind: "file", path: "design/hero.html" }),
      ],
    }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => [entry.id, entry.path]),
    [["good", "design/hero.html"]],
  );
  assert.equal(dropped, unsafe.length);
});

test("a page keeps at most 400 frames, in document order", () => {
  const onePage = Array.from({ length: 401 }, (_, index) => frame({ id: `f${index}` }));
  const one = parsed(canvas({ frames: onePage }));
  assert.equal(one.doc.frames.length, 400);
  assert.equal(one.doc.frames[0]?.id, "f0");
  assert.equal(one.doc.frames[399]?.id, "f399");
  assert.equal(one.dropped, 1);
});

test("caps pages at 200, frames at 4000 and comments at 2000", () => {
  assert.equal(DESIGN_CANVAS_LIMITS.pages, 200);
  const pages = Array.from({ length: 205 }, (_, index) => ({ id: `p${index}`, name: `P${index}` }));
  // Eleven full pages hold 4 400 frames; only the first 4 000 stay, the eleventh page filling what is left.
  const spread = pages.slice(0, 11).flatMap((page) =>
    Array.from({ length: 400 }, (_, index) => frame({ id: `${page.id}-${index}`, pageId: page.id })),
  );
  const comments = Array.from({ length: 2005 }, (_, index) => ({
    id: `c${index}`,
    x: 0,
    y: 0,
    note: "",
    state: "open",
    anchorState: "anchored",
    createdAt: "t",
  }));
  const many = parsed(canvas({ pages, frames: spread, comments }));
  assert.equal(many.doc.pages.length, 200);
  assert.equal(many.doc.pages[199]!.id, "p199");
  assert.equal(many.doc.frames.length, 4000);
  assert.equal(many.doc.frames.filter((entry) => entry.pageId === "p10").length, 0, "the eleventh page has no room left");
  assert.equal(many.doc.frames.filter((entry) => entry.pageId === "p9").length, 400);
  assert.equal(many.doc.comments.length, 2000);
  // Five pages, 400 frames and five comments past the limits.
  assert.equal(many.dropped, 5 + 400 + 5);
});

test("a groupId naming a missing group is removed but the frame stays", () => {
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "g", kind: "group", title: "Group", text: undefined }),
        frame({ id: "inside", groupId: "g" }),
        frame({ id: "orphan", groupId: "missing" }),
        frame({ id: "not-a-group", groupId: "inside" }),
      ],
    }),
  );
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("inside")?.groupId, "g");
  assert.equal(byId.has("orphan"), true);
  assert.equal("groupId" in (byId.get("orphan") ?? {}), false);
  assert.equal("groupId" in (byId.get("not-a-group") ?? {}), false);
});

test("duplicate frame ids keep the first occurrence", () => {
  const { doc, dropped } = parsed(
    canvas({
      frames: [frame({ id: "same", title: "First" }), frame({ id: "same", title: "Second" })],
    }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => entry.title),
    ["First"],
  );
  assert.equal(dropped, 1);
});

test("refuses version 1 and 2 documents", () => {
  for (const version of [1, 2, 4]) {
    assert.equal(parseDesignCanvas(canvas({ version })).ok, false, `version ${version}`);
  }
  // A version 2 document exactly as v1 of design mode wrote it.
  const v2 = { version: 2, revision: 4, pages: [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } }], activePageId: "page-1", frames: [], comments: [] };
  assert.equal(parseDesignCanvas(v2).ok, false);
});

test("a non-object is refused", () => {
  for (const value of [null, "canvas", 42, [], undefined]) {
    const result = parseDesignCanvas(value);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.length > 0);
  }
});

test("drops activePageId and page viewports from input", () => {
  const { doc } = parsed(
    canvas({
      pages: [
        { id: "a", name: "A", viewport: { x: 5, y: 6, zoom: 2 } },
        { id: "b", name: "B", viewport: { x: 1, y: 1, zoom: 1 } },
      ],
      activePageId: "b",
      viewport: { x: 1, y: 2, zoom: 3 },
    }),
  );
  for (const page of doc.pages) assert.deepEqual(Object.keys(page).sort(), ["id", "name"]);
  assert.equal("activePageId" in doc, false);
  assert.equal("viewport" in doc, false);
});

test("parses a v3 document and keeps chatPages entries that name existing pages and safe chat ids", () => {
  const { doc } = parsed(
    canvas({
      pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
      chatPages: {
        "chat-1": "a",
        "chat:2.x_y": "b",
        "chat-3": "missing",
        "../x": "a",
        "..": "a",
        "chat-4": 7,
        [`c${"x".repeat(200)}`]: "a",
      },
    }),
  );
  assert.deepEqual(doc.chatPages, { "chat-1": "a", "chat:2.x_y": "b" });
  // A missing or malformed map reads as empty.
  assert.deepEqual(parsed(canvas({ chatPages: undefined })).doc.chatPages, {});
  assert.deepEqual(parsed(canvas({ chatPages: ["a"] })).doc.chatPages, {});
  // Read back after a save, nothing changes.
  assert.deepEqual(parsed(JSON.parse(JSON.stringify(doc))).doc, doc);
});

test("keeps namedFor only when it is a safe chat id", () => {
  const { doc } = parsed(
    canvas({
      pages: [
        { id: "a", name: "A", namedFor: "chat-1" },
        { id: "b", name: "B", namedFor: "../x" },
        { id: "c", name: "C", namedFor: 4 },
      ],
    }),
  );
  assert.deepEqual(doc.pages, [
    { id: "a", name: "A", namedFor: "chat-1" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
  ]);
  assert.deepEqual(parsed(JSON.parse(JSON.stringify(doc))).doc.pages, doc.pages);
});

test("parse keeps the first 2 000 chatPages entries and counts the rest in dropped, without setting the canvas aside", () => {
  const chatPages: Record<string, string> = {};
  for (let index = 0; index < DESIGN_CANVAS_LIMITS.chatPages + 3; index += 1) chatPages[`chat-${index}`] = "page-1";
  const { doc, dropped } = parsed(canvas({ chatPages }));
  assert.equal(Object.keys(doc.chatPages).length, DESIGN_CANVAS_LIMITS.chatPages);
  assert.equal(doc.chatPages["chat-0"], "page-1");
  assert.equal(doc.chatPages[`chat-${DESIGN_CANVAS_LIMITS.chatPages}`], undefined);
  assert.equal(dropped, 3);
});

test("keeps chatId on artifact frames and comments only when it is a safe chat id", () => {
  const comment = (id: string, chatId: unknown) => ({
    id,
    chatId,
    x: 0,
    y: 0,
    note: "",
    state: "open",
    anchorState: "anchored",
    createdAt: "t",
  });
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "art", kind: "artifact", mediaId: "m1", text: undefined, chatId: "chat-1" }),
        frame({ id: "bad-art", kind: "artifact", mediaId: "m2", text: undefined, chatId: "../x" }),
        frame({ id: "note", chatId: "chat-1" }),
      ],
      comments: [comment("c1", "chat-1"), comment("c2", "a/b"), comment("c3", 5)],
    }),
  );
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("art")!.chatId, "chat-1");
  assert.equal("chatId" in byId.get("bad-art")!, false);
  assert.equal("chatId" in byId.get("note")!, false, "only artifact frames carry their chat");
  assert.deepEqual(doc.comments.map((entry) => entry.chatId), ["chat-1", undefined, undefined]);
});

test("a long note is cut to 2000 characters", () => {
  const { doc } = parsed(
    canvas({
      frames: [frame({ id: "n" })],
      comments: [
        {
          id: "c1",
          frameId: "n",
          x: 10,
          y: 10,
          note: "x".repeat(2500),
          state: "open",
          anchorState: "anchored",
          createdAt: "2026-10-31T00:00:00.000Z",
        },
      ],
    }),
  );
  assert.equal(doc.comments[0]?.note.length, 2000);
});

test("pages: duplicates and nameless pages are fixed, and unknown pages fall back to the first", () => {
  const { doc } = parsed({
    version: 3,
    revision: 1,
    pages: [
      { id: "a", name: "  Home  " },
      { id: "a", name: "Again" },
      { id: "b", name: "" },
      "not a page",
    ],
    chatPages: {},
    frames: [frame({ id: "on-b", pageId: "b" }), frame({ id: "lost", pageId: "gone" })],
    comments: [],
  });
  assert.deepEqual(doc.pages, [{ id: "a", name: "Home" }, { id: "b", name: "Page 2" }]);
  assert.deepEqual(doc.frames.map((entry) => entry.pageId), ["b", "a"]);
  const empty = parsed({ version: 3, revision: 0, pages: [], frames: [], comments: [] }).doc;
  assert.equal(empty.pages.length, 1, "a canvas always has a page");
});

test("a frame leaves a group on another page, and a comment on a frame moves to that frame's page", () => {
  const { doc } = parsed({
    version: 3,
    revision: 1,
    pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    chatPages: {},
    frames: [frame({ id: "g", kind: "group", pageId: "a" }), frame({ id: "n", groupId: "g", pageId: "b" })],
    comments: [{ id: "c", frameId: "n", pageId: "a", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  });
  assert.equal(doc.frames[1]!.groupId, undefined);
  assert.equal(doc.comments[0]!.pageId, "b");
});

test("relative path check refuses anything outside a plain workspace-relative path", () => {
  for (const value of [
    "",
    "a".repeat(1025),
    "C:/x.html",
    "c:x.html",
    "design/../x.html",
    "design/./x.html",
    "design//x.html",
    7,
  ]) {
    assert.equal(isDesignRelativePath(value), false, String(value));
  }
  for (const value of ["index.html", "design/hero.html", "design/my page.html", "a/b/c.css"]) {
    assert.equal(isDesignRelativePath(value), true, value);
  }
});

test("drawn items keep their own fields, and small boxes, through a save", () => {
  const frames = [
    frame({ id: "t", kind: "text", text: "Checkout", size: "large", color: "red", w: 120, h: 20 }),
    frame({ id: "s", kind: "shape", shape: "oval", text: "Start", fill: "green", color: "ink", strokeWidth: 3, w: 12, h: 12 }),
    frame({ id: "c", kind: "connector", ends: [{ x: 0, y: 0 }, { x: 50, y: 0 }], arrow: "both", color: "gray", strokeWidth: 2 }),
    frame({
      id: "p",
      kind: "stroke",
      points: [
        [0, 0],
        [1, 1],
      ],
      handles: [
        [0, 0],
        [0.2, -0.3],
      ],
      closed: true,
      w: 3,
      h: 3,
    }),
    frame({ id: "board", kind: "frame", title: "Mobile", w: 390, h: 844 }),
  ];
  const { doc, dropped } = parsed(canvas({ frames }));
  assert.equal(dropped, 0);
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  assert.deepEqual(
    [byId.get("t")!.text, byId.get("t")!.size, byId.get("t")!.color, byId.get("t")!.h],
    ["Checkout", "large", "red", 20],
  );
  assert.deepEqual(
    [byId.get("s")!.shape, byId.get("s")!.text, byId.get("s")!.fill, byId.get("s")!.color, byId.get("s")!.w],
    ["oval", "Start", "green", "ink", 12],
  );
  assert.equal(byId.get("c")!.arrow, "both");
  assert.deepEqual(byId.get("p")!.handles, [
    [0, 0],
    [0.2, -0.3],
  ]);
  assert.equal(byId.get("p")!.closed, true);
  assert.deepEqual([byId.get("board")!.w, byId.get("board")!.h], [390, 844]);
  // The parser's output reads back as itself.
  assert.deepEqual(parsed(doc).doc, doc);
});

test("drawn items that cannot be drawn are dropped, and unknown colours and sizes are left out", () => {
  const { doc, dropped } = parsed(
    canvas({
      frames: [
        frame({ id: "no-shape", kind: "shape" }),
        frame({ id: "one-end", kind: "connector", ends: [{ x: 0, y: 0 }] }),
        frame({ id: "one-point", kind: "stroke", points: [[0, 0]] }),
        frame({ id: "bad-point", kind: "stroke", points: [[0, 0], ["x", 1]] }),
        frame({ id: "odd", kind: "shape", shape: "rect", fill: "#ff0000", color: "chartreuse", strokeWidth: 400 }),
        frame({ id: "loud", kind: "text", size: "huge" }),
        frame({ id: "tiny-note", kind: "note", w: 5, h: 5 }),
      ],
    }),
  );
  assert.deepEqual(
    doc.frames.map((entry) => entry.id),
    ["odd", "loud", "tiny-note"],
  );
  assert.equal(dropped, 4);
  const odd = doc.frames[0]!;
  assert.deepEqual([odd.fill, odd.color, odd.strokeWidth], [undefined, undefined, 24]);
  assert.equal(doc.frames[1]!.size, undefined);
  assert.deepEqual([doc.frames[2]!.w, doc.frames[2]!.h], [40, 40], "a note keeps its minimum size");
});

test("items sit in a group or an artboard, but those never sit in each other", () => {
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "board", kind: "frame", title: "Board", text: undefined }),
        frame({ id: "g", kind: "group", title: "Group", text: undefined, groupId: "board" }),
        frame({ id: "card", kind: "shape", shape: "rect", groupId: "board" }),
        frame({ id: "inner", kind: "frame", title: "Inner", groupId: "g" }),
      ],
    }),
  );
  const byId = new Map(doc.frames.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("card")!.groupId, "board");
  assert.equal(byId.get("g")!.groupId, undefined);
  assert.equal(byId.get("inner")!.groupId, undefined);
});

test("a note keeps its formatted words, size, text colour and note colour; a page frame takes none of them", () => {
  const words = "**Bold** and [a link](https://example.com)\n- item";
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "n", kind: "note", text: words, size: "large", color: "purple", fill: "yellow" }),
        frame({ id: "f", kind: "file", path: "design/a.html", size: "large", color: "purple", fill: "yellow" }),
      ],
    }),
  );
  const [note, page] = doc.frames;
  assert.deepEqual([note!.text, note!.size, note!.color, note!.fill], [words, "large", "purple", "yellow"]);
  assert.deepEqual([page!.size, page!.color, page!.fill], [undefined, undefined, undefined]);
});

test("the side panel's fields: an artboard keeps its background, radius and guide; hide and lock work on anything", () => {
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "board", kind: "frame", fill: "teal", radius: 12.4, guide: "columns-12", hidden: true }),
        frame({ id: "rect", kind: "shape", shape: "rect", radius: 999, locked: true }),
        frame({ id: "oval", kind: "shape", shape: "oval", radius: 8, guide: "grid-8" }),
        frame({ id: "page", kind: "file", path: "a.html", guide: "grid-8", radius: 8, hidden: "yes" }),
        frame({ id: "note", kind: "note", guide: "columns-4", locked: 1 }),
        frame({ id: "odd", kind: "frame", guide: "columns-5", radius: -3 }),
      ],
    }),
  );
  const field = (id: string) => {
    const entry = doc.frames.find((item) => item.id === id)!;
    return { fill: entry.fill, radius: entry.radius, guide: entry.guide, hidden: entry.hidden, locked: entry.locked };
  };
  assert.deepEqual(field("board"), { fill: "teal", radius: 12, guide: "columns-12", hidden: true, locked: undefined });
  assert.deepEqual(field("rect"), { fill: undefined, radius: 200, guide: undefined, hidden: undefined, locked: true });
  assert.deepEqual(field("oval"), { fill: undefined, radius: undefined, guide: undefined, hidden: undefined, locked: undefined });
  assert.deepEqual(field("page"), { fill: undefined, radius: undefined, guide: "grid-8", hidden: undefined, locked: undefined });
  assert.deepEqual(field("note"), { fill: undefined, radius: undefined, guide: undefined, hidden: undefined, locked: undefined });
  assert.deepEqual(field("odd"), { fill: undefined, radius: 0, guide: undefined, hidden: undefined, locked: undefined });
});

test("tweaks: pages and artifacts keep the Dark switch, and only pages keep tweak values, read safely", () => {
  const { doc } = parsed(
    canvas({
      frames: [
        frame({ id: "page", kind: "file", path: "a.html", dark: true, tweaks: { "--accent": "#ff0055", "data-x": "a;b", color: "red" } }),
        frame({ id: "chart", kind: "artifact", mediaId: "media-1", dark: true, tweaks: { "--accent": "#ff0055" } }),
        frame({ id: "note", kind: "note", dark: true }),
        frame({ id: "plain", kind: "file", path: "b.html", dark: "yes", tweaks: { color: "red" } }),
      ],
    }),
  );
  const field = (id: string) => {
    const entry = doc.frames.find((item) => item.id === id)!;
    return { dark: entry.dark, tweaks: entry.tweaks };
  };
  assert.deepEqual(field("page"), { dark: true, tweaks: { "--accent": "#ff0055" } });
  assert.deepEqual(field("chart"), { dark: true, tweaks: undefined });
  assert.deepEqual(field("note"), { dark: undefined, tweaks: undefined });
  assert.deepEqual(field("plain"), { dark: undefined, tweaks: undefined });
});

function appFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return frame({
    id: "app-1",
    kind: "app",
    title: "Pricing",
    appRoot: ".",
    route: "/pricing",
    viewport: { width: 1280, height: 800 },
    scale: 0.5,
    w: 9999,
    h: 9999,
    text: undefined,
    ...overrides,
  });
}

test("app frames: every field parses, and the box is recomputed from the viewport and scale", () => {
  const { doc } = parsed(
    canvas({ frames: [appFrame({ colorScheme: "dark", label: "x".repeat(80), variantOf: "app-0", guide: "columns-12" })] }),
  );
  const app = doc.frames[0]!;
  assert.equal(app.kind, "app");
  assert.equal(app.appRoot, ".");
  assert.equal(app.route, "/pricing");
  assert.deepEqual(app.viewport, { width: 1280, height: 800 });
  assert.equal(app.scale, 0.5);
  assert.equal(app.w, 640, "a stored w of 9 999 is replaced");
  assert.equal(app.h, 400 + 36);
  assert.equal(app.colorScheme, "dark");
  assert.equal(app.label, "x".repeat(60));
  assert.equal(app.variantOf, "app-0");
  assert.equal(app.guide, "columns-12");
});

test("app frames: a bad route, root, viewport or scale drops the frame", () => {
  const bad = [
    appFrame({ route: "pricing" }),
    appFrame({ route: "//evil.com" }),
    appFrame({ appRoot: "../web" }),
    appFrame({ appRoot: undefined }),
    appFrame({ viewport: { width: 199, height: 800 } }),
    appFrame({ viewport: { width: 1280, height: 4001 } }),
    appFrame({ viewport: { width: 1.5, height: 800 } }),
    appFrame({ viewport: undefined }),
    appFrame({ scale: 0.01 }),
    appFrame({ scale: 3 }),
    appFrame({ scale: "0.5" }),
  ];
  for (const entry of bad) {
    const result = parseDesignCanvas(canvas({ frames: [entry] }));
    assert.ok(result.ok);
    assert.equal(result.doc.frames.length, 0, JSON.stringify(entry));
    assert.equal(result.dropped, 1);
  }
});

test("app frames: the route's fragment is dropped, and a scale keeps 4 decimals", () => {
  const { doc } = parsed(canvas({ frames: [appFrame({ route: "/pricing?plan=team#faq", scale: 0.333333 })] }));
  assert.equal(doc.frames[0]!.route, "/pricing?plan=team");
  assert.equal(doc.frames[0]!.scale, 0.3333);
});

test("app frames: page-only fields are dropped", () => {
  const { doc } = parsed(
    canvas({
      frames: [appFrame({ designWidth: 1280, tweaks: { "--accent": "#fff" }, dark: true, printMode: "fixed", paper: "a4", path: "a.html" })],
    }),
  );
  const app = doc.frames[0]!;
  for (const field of ["designWidth", "tweaks", "dark", "printMode", "paper", "path"] as const) {
    assert.equal(app[field], undefined, field);
  }
});

test("app frames: parse, serialize and parse again is a fixed point", () => {
  for (const overrides of [
    { scale: 0.3333, viewport: { width: 1333, height: 777 } },
    { scale: 0.05, viewport: { width: 200, height: 200 } },
    { scale: 2, viewport: { width: 4000, height: 4000 } },
  ]) {
    const first = parsed(canvas({ frames: [appFrame(overrides)] })).doc;
    const second = parsed(JSON.parse(JSON.stringify(first)) as Record<string, unknown>).doc;
    assert.deepEqual(second.frames, first.frames, JSON.stringify(overrides));
    const app = first.frames[0]!;
    assert.ok(app.w <= DESIGN_CANVAS_LIMITS.maxSize && app.h <= DESIGN_CANVAS_LIMITS.maxSize, "the box fits the canvas limit");
  }
  const tiny = parsed(canvas({ frames: [appFrame({ scale: 0.05, viewport: { width: 200, height: 200 } })] })).doc.frames[0]!;
  assert.equal(tiny.w, 10, "the generic clamp doesn't move the smallest app box");
});
