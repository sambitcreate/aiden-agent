// Design canvas document parser: the bounds and refusals every reader and
// writer of `design-canvases/<chatId>.json` relies on.

import assert from "node:assert/strict";
import test from "node:test";
import {
  type DesignCanvas,
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
    version: 1,
    revision: 3,
    viewport: { x: 0, y: 0, zoom: 1 },
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
  assert.deepEqual(empty.pages, [{ id: "page-1", name: "Page 1", viewport: { x: 0, y: 0, zoom: 1 } }]);
  assert.equal(empty.activePageId, "page-1");
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

test("a page keeps at most 400 frames and the canvas 1 000, in document order", () => {
  const onePage = Array.from({ length: 401 }, (_, index) => frame({ id: `f${index}` }));
  const one = parsed(canvas({ frames: onePage }));
  assert.equal(one.doc.frames.length, 400);
  assert.equal(one.doc.frames[0]?.id, "f0");
  assert.equal(one.doc.frames[399]?.id, "f399");
  assert.equal(one.dropped, 1);

  const pages = ["a", "b", "c"].map((id) => ({ id, name: id, viewport: { x: 0, y: 0, zoom: 1 } }));
  const spread = pages.flatMap((page) =>
    Array.from({ length: 400 }, (_, index) => frame({ id: `${page.id}${index}`, pageId: page.id })),
  );
  const many = parsed(canvas({ version: 2, pages, activePageId: "a", frames: spread }));
  assert.equal(many.doc.frames.length, 1000);
  assert.equal(many.doc.frames.filter((entry) => entry.pageId === "c").length, 200, "the third page fills what is left");
  assert.equal(many.dropped, 200);
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

test("another version or a non-object is refused", () => {
  assert.equal(parseDesignCanvas(canvas({ version: 3 })).ok, false);
  for (const value of [null, "canvas", 42, [], undefined]) {
    const result = parseDesignCanvas(value);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.issues.length > 0);
  }
});

test("viewport zoom clamps to 0.1..4", () => {
  assert.equal(parsed(canvas({ viewport: { x: 0, y: 0, zoom: 9 } })).doc.pages[0]!.viewport.zoom, 4);
  assert.equal(parsed(canvas({ viewport: { x: 0, y: 0, zoom: 0.01 } })).doc.pages[0]!.viewport.zoom, 0.1);
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

test("a version 1 canvas becomes one page that keeps its view, and reads back the same as version 2", () => {
  const v1 = canvas({
    viewport: { x: -120, y: 40, zoom: 0.5 },
    frames: [frame({ id: "g", kind: "group" }), frame({ id: "n", groupId: "g" })],
    comments: [{ id: "c1", frameId: "n", x: 1, y: 2, note: "hi", state: "open", anchorState: "anchored", createdAt: "2026-11-05T00:00:00Z" }],
  });
  const { doc, dropped } = parsed(v1);
  assert.equal(dropped, 0);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.pages, [{ id: "page-1", name: "Page 1", viewport: { x: -120, y: 40, zoom: 0.5 } }]);
  assert.equal(doc.activePageId, "page-1");
  assert.deepEqual(doc.frames.map((entry) => [entry.id, entry.pageId, entry.groupId]), [["g", "page-1", undefined], ["n", "page-1", "g"]]);
  assert.equal(doc.comments[0]!.pageId, "page-1");
  // Saved as version 2 and read again, nothing changes.
  assert.deepEqual(parsed(JSON.parse(JSON.stringify(doc))).doc, doc);
});

test("version 2 pages: duplicates and nameless pages are fixed, and unknown pages fall back to the first", () => {
  const { doc } = parsed({
    version: 2,
    revision: 1,
    pages: [
      { id: "a", name: "  Home  ", viewport: { x: 5, y: 6, zoom: 2 } },
      { id: "a", name: "Again" },
      { id: "b", name: "" },
      "not a page",
    ],
    activePageId: "missing",
    frames: [frame({ id: "on-b", pageId: "b" }), frame({ id: "lost", pageId: "gone" })],
    comments: [],
  });
  assert.deepEqual(doc.pages.map((page) => [page.id, page.name]), [["a", "Home"], ["b", "Page 2"]]);
  assert.deepEqual(doc.pages[1]!.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(doc.activePageId, "a");
  assert.deepEqual(doc.frames.map((entry) => entry.pageId), ["b", "a"]);
  const empty = parsed({ version: 2, revision: 0, pages: [], frames: [], comments: [] }).doc;
  assert.equal(empty.pages.length, 1, "a canvas always has a page");
});

test("a frame leaves a group on another page, and a comment on a frame moves to that frame's page", () => {
  const { doc } = parsed({
    version: 2,
    revision: 1,
    pages: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    activePageId: "b",
    frames: [frame({ id: "g", kind: "group", pageId: "a" }), frame({ id: "n", groupId: "g", pageId: "b" })],
    comments: [{ id: "c", frameId: "n", pageId: "a", x: 0, y: 0, note: "", state: "open", anchorState: "anchored", createdAt: "t" }],
  });
  assert.equal(doc.activePageId, "b");
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
